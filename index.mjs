import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWindowLimiter } from './limiter.mjs';

export const name = 'dsh-rpm';
export const inject = ['llm', 'settings'];
/** Settings namespace on DSH 0.1.5 (`settings.register`). 0.1.7+ uses this entry's Config. */
export const namespace = 'dsh-rpm';
const LOG_PREFIX = 'dsh-rpm:';

/**
 * DSH releases this plugin version was tested against: unit tests plus a
 * Cordis mount and an llm/stream queue probe on each one. The range matches
 * dsh-short-tool-ids v0.4.0, whose settings/client patterns this plugin follows.
 */
export const TESTED_DSH_VERSIONS = Object.freeze([
  '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2',
]);

/**
 * Versions accepted without `allowUntestedHarness`. A release inside this
 * range that is not in TESTED_DSH_VERSIONS loads with a warning, and only if
 * the settings API check passes. 0.3.0 and its prereleases are refused until
 * tested.
 */
export const SUPPORTED_DSH_RANGE = Object.freeze({ min: '0.1.5-rc.1', below: '0.3.0' });

/** Compare two semver strings, prerelease aware (`0.1.7-rc.2` < `0.1.7`). */
export function compareVersions(left, right) {
  const parse = version => {
    const [core, pre] = String(version).split('-', 2);
    return { core: core.split('.').map(part => Number.parseInt(part, 10) || 0), pre: pre === undefined ? null : pre.split('.') };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a.core[index] ?? 0) !== (b.core[index] ?? 0)) return (a.core[index] ?? 0) < (b.core[index] ?? 0) ? -1 : 1;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) return nx < ny ? -1 : 1;
    if (nx !== null || ny !== null) return nx !== null ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** @returns {'tested' | 'compatible' | 'unsupported' | 'unknown'} */
export function classifyVersion(version) {
  if (version === undefined) return 'unknown';
  if (TESTED_DSH_VERSIONS.includes(version)) return 'tested';
  // `below` excludes that release's prereleases too (0.3.0-alpha.1 is outside the range).
  const core = String(version).split('-', 1)[0];
  const inRange = compareVersions(version, SUPPORTED_DSH_RANGE.min) >= 0
    && compareVersions(core, SUPPORTED_DSH_RANGE.below) < 0;
  return inRange ? 'compatible' : 'unsupported';
}

/** Locate the running `@deepseek-ai/dsh` package from its CLI entry. */
export function harnessRoot(entry) {
  let dir = dirname(realpathSync(entry));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === '@deepseek-ai/dsh') return { dir, version: pkg.version };
    } catch {
      /* keep walking up */
    }
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * One provider's limit: a whole number of requests per minute, at least 1.
 * schemastery has no `.int()`/`.positive()`; `natural().min(1)` is its
 * equivalent (rejects 0, negatives, fractions and strings).
 */
export function rpmSchema(z) {
  return z.natural().min(1);
}

/**
 * This entry's Config. On DSH 0.1.7 and later, a plugin's settings live in its
 * own Config: `.volatile()` fields are what Settings edits and what changes
 * live without a restart. The schemastery build that ships with 0.1.5 has no
 * `.volatile()`, and 0.1.5 keeps its settings in `settings.register` instead.
 */
export function createConfig(z) {
  const fields = {
    enabled: z.boolean().description('Set false to load the plugin without rate limiting.'),
    harnessEntry: z.string().description('Path of the running dsh CLI entry; detected automatically.'),
    allowUntestedHarness: z.boolean().description('Load on a DSH version outside the supported range (not recommended).'),
  };
  if (typeof z.prototype?.volatile === 'function' || typeof z.boolean().volatile === 'function') {
    fields.providers = z.dict(rpmSchema(z)).default({}).volatile()
      .description('Provider routes limited to the given requests per minute (absent = unlimited).');
  }
  return z.object(fields);
}

function tryHarnessSchemastery(entry) {
  try {
    if (!entry) return undefined;
    const require = createRequire(realpathSync(entry));
    return pathToFileURL(require.resolve('@deepseek-ai/schemastery')).href;
  } catch {
    return undefined;
  }
}

// Build Config with the running harness's own schemastery, never a second
// copy. Outside a harness (plain `node --test`) there is no Config.
const harnessSchemastery = tryHarnessSchemastery(process.argv[1]);
export const Config = harnessSchemastery === undefined
  ? undefined
  : createConfig((await import(harnessSchemastery)).default);

/** Resolve schemastery and the running dsh version through the CLI entry. */
export async function loadRuntime(harnessEntry = process.argv[1], options = {}) {
  if (!harnessEntry) throw new Error(`${LOG_PREFIX} cannot locate the running dsh; set harnessEntry`);
  const root = harnessRoot(harnessEntry);
  const versionStatus = classifyVersion(root?.version);
  if (versionStatus === 'unsupported' && options.allowUntested !== true) {
    throw new Error(`${LOG_PREFIX} dsh ${root.version} is outside the supported range (>= ${SUPPORTED_DSH_RANGE.min} and < ${SUPPORTED_DSH_RANGE.below}); refusing to load. Upgrade dsh-rpm, or set allowUntestedHarness: true to override.`);
  }
  const require = createRequire(realpathSync(harnessEntry));
  const { default: z } = await import(pathToFileURL(require.resolve('@deepseek-ai/schemastery')).href);
  return { z, dshVersion: root?.version, versionStatus };
}

/** Settings reader for the running DSH: `settings.register` (0.1.5) or a volatile Config field (0.1.7+). */
function providerSettings(ctx, config, z) {
  if (typeof ctx.settings?.register === 'function') {
    const scope = ctx.settings.register(namespace, z.object({
      providers: z.dict(rpmSchema(z)).default({}),
    }), { applies: 'live' });
    return { kind: `settings namespace "${namespace}"`, read: () => scope.get().providers };
  }
  const providers = config.providers;
  if (providers !== null && typeof providers === 'object' && typeof providers.get === 'function') {
    return { kind: 'plugin config (providers)', read: () => providers.get() };
  }
  throw new Error(`${LOG_PREFIX} this dsh offers neither settings.register nor volatile plugin Config; refusing to load (this dsh is not compatible with this plugin version)`);
}

export async function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const runtime = await loadRuntime(config.harnessEntry, { allowUntested: config.allowUntestedHarness === true });
  if (runtime.versionStatus !== 'tested') {
    ctx.logger.warn(`${LOG_PREFIX} dsh ${runtime.dshVersion ?? '(unknown)'} has not been tested with this plugin (tested dsh: ${TESTED_DSH_VERSIONS.join(', ')}); the API check passed, loading anyway`);
  }
  const settings = providerSettings(ctx, config, runtime.z);

  const limiter = createWindowLimiter();
  limiter.start();
  ctx.effect(() => () => limiter.dispose(), 'dsh-rpm: limiter window timer');

  const rpmOf = provider => {
    let providers;
    try {
      providers = settings.read();
    } catch {
      return undefined;
    }
    const rpm = typeof provider === 'string' && providers !== null && typeof providers === 'object'
      ? providers[provider]
      : undefined;
    return typeof rpm === 'number' && Number.isInteger(rpm) && rpm > 0 ? rpm : undefined;
  };

  ctx.on('llm/stream', (options, next) => {
    const route = options && typeof options.provider === 'string' ? options.provider : undefined;
    if (route === undefined) return next();
    const rpm = rpmOf(route);
    if (rpm === undefined) return next();
    return (async function* gated() {
      // A cancelled chat leaves the queue instead of holding a future slot.
      await limiter.acquire(route, rpm, options.signal);
      yield* next();
    })();
  });

  ctx.logger.info(`${LOG_PREFIX} per-provider RPM limits ready (default unlimited; stored in ${settings.kind}; dsh ${runtime.dshVersion ?? '(unknown)'}); Settings → Rate limits`);
}
