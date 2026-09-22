import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createWindowLimiter } from './limiter.mjs';

export const name = 'dsh-rpm';
export const inject = ['llm', 'settings'];
export const namespace = 'dsh-rpm';

/**
 * Per-provider requests-per-minute limits.
 *
 * Settings document (`dsh-rpm` namespace, durable, live-applied):
 *   { providers: { [routeId]: positiveIntegerRpm } }
 *
 * Enforcement sits in the `llm/stream` waterfall that wraps every streaming
 * model call. Over-limit calls wait for the next fixed one-minute window
 * instead of failing; routes without an entry pass through untouched.
 * The Models settings UI (`client/index.mjs`) edits the same document, so
 * changes take effect immediately with no restart.
 */
export async function apply(ctx, config = {}) {
  if (config.enabled === false) return;

  // Resolve schemastery through the running harness, not a second npm copy.
  const harnessEntry = config.harnessEntry ?? process.argv[1];
  if (!harnessEntry) throw new Error('dsh-rpm: cannot locate running DSH; set harnessEntry');
  const runtimeRequire = createRequire(realpathSync(harnessEntry));
  const { default: z } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/schemastery')).href);

  const scope = ctx.settings.register(namespace, z.object({
    providers: z.dict(z.number().step(1).min(1)).default({}),
  }), { applies: 'live' });

  const limiter = createWindowLimiter();
  limiter.start();
  ctx.effect(() => () => limiter.dispose(), 'dsh-rpm: limiter window timer');

  ctx.on('llm/stream', (options, next) => {
    const route = options && typeof options.provider === 'string' ? options.provider : undefined;
    if (route === undefined) return next();
    const rpm = scope.get().providers[route];
    if (typeof rpm !== 'number' || !(rpm > 0)) return next();
    return (async function* gated() {
      await limiter.acquire(route, rpm);
      yield* next();
    })();
  });

  ctx.logger.info('dsh-rpm: per-provider RPM limits ready (Settings → Models); default unlimited');
}
