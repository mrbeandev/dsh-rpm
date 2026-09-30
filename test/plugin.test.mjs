import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { apply, createConfig, loadRuntime, rpmSchema } from '../index.mjs';

const harnessEntry = process.env.DSH_TEST_HARNESS_ENTRY;
const runtimeAvailable = Boolean(harnessEntry && existsSync(harnessEntry));
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Collect an async iterable's values. */
async function drain(iterable) {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
}

/**
 * Mount the host plugin against a fake Cordis ctx on the running DSH.
 * Uses the settings API that DSH actually offers (register on 0.1.5, a
 * volatile Config field on 0.1.7+), exactly like dsh-short-tool-ids.
 */
async function mount() {
  const runtime = await loadRuntime(harnessEntry);
  const legacy = typeof runtime.z.boolean().volatile !== 'function';
  let providers = {};
  const effects = [];
  const listeners = new Map();
  const messages = [];
  const ctx = {
    effect: fn => { effects.push(fn()); },
    on: (event, fn) => { listeners.set(event, fn); },
    logger: { info: msg => messages.push(msg), warn: msg => messages.push(msg) },
    settings: legacy ? {
      register(ns, schema, options) {
        assert.equal(ns, 'dsh-rpm');
        assert.equal(options.applies, 'live');
        assert.deepEqual(schema({}), { providers: {} });
        assert.throws(() => schema({ providers: { cc: 0 } }));
        return { get: () => ({ providers }) };
      },
    } : {},
  };
  const config = legacy ? { harnessEntry } : { harnessEntry, ...createConfig(runtime.z)({ providers: {} }) };
  await apply(ctx, config);
  const setProviders = legacy
    ? next => { providers = next; }
    // What the Loader does on a live settings save: rewrite the volatile reference.
    : next => config.providers[Symbol.for('cosmokit.volatile.write')](next);
  return {
    legacy, messages, setProviders,
    stream: listeners.get('llm/stream'),
    dispose: () => { for (const fn of effects) fn?.(); },
  };
}

test('rpmSchema accepts whole positive numbers only', { skip: !runtimeAvailable }, async () => {
  const { z } = await loadRuntime(harnessEntry);
  const schema = z.dict(rpmSchema(z));
  assert.deepEqual(schema({ cc: 5 }), { cc: 5 });
  for (const bad of [0, -1, 1.5, '5']) assert.throws(() => schema({ cc: bad }), `rejects ${JSON.stringify(bad)}`);
});

test('0.1.7+: Config exposes a live volatile providers field', { skip: !runtimeAvailable }, async () => {
  const { z } = await loadRuntime(harnessEntry);
  if (typeof z.boolean().volatile !== 'function') return; // 0.1.5 has no volatile Config
  const config = createConfig(z)({ providers: { cc: 3 } });
  assert.equal(typeof config.providers.get, 'function');
  assert.deepEqual(config.providers.get(), { cc: 3 });
  assert.throws(() => createConfig(z)({ providers: { cc: 0 } }));
});

test('Cordis apply on the running DSH: unlimited passes through, limited routes queue, live updates', { skip: !runtimeAvailable }, async () => {
  const plugin = await mount();
  try {
    assert.match(plugin.messages.at(-1), /per-provider RPM limits ready/);
    assert.match(plugin.messages.at(-1), plugin.legacy ? /settings namespace/ : /plugin config/);
    let calls = 0;
    const next = () => { calls += 1; return (async function* () { yield calls; })(); };

    // Default: unlimited routes are returned untouched (no wrapper).
    const direct = next;
    const passthrough = plugin.stream({ provider: 'cc' }, direct);
    assert.deepEqual(await drain(passthrough), [1]);

    // Live limit of 1/min: the first call runs, the second waits in the queue.
    plugin.setProviders({ cc: 1 });
    assert.deepEqual(await drain(plugin.stream({ provider: 'cc' }, next)), [2]);
    const controller = new AbortController();
    const queued = drain(plugin.stream({ provider: 'cc', signal: controller.signal }, next));
    await flush();
    assert.equal(calls, 2, 'second call is held back by the limit');

    // Other providers are unaffected by cc's limit.
    assert.deepEqual(await drain(plugin.stream({ provider: 'other' }, next)), [3]);

    // Cancelling the queued chat releases it without reaching the provider.
    controller.abort(new Error('stopped'));
    await assert.rejects(queued, /stopped/);
    assert.equal(calls, 3);

    // Removing the limit lets the route through again immediately.
    plugin.setProviders({});
    assert.deepEqual(await drain(plugin.stream({ provider: 'cc' }, next)), [4]);
  } finally {
    plugin.dispose();
  }
});

test('enabled: false loads without registering the gate', async () => {
  const ctx = { on: () => assert.fail('must not listen'), effect: () => assert.fail('must not start timers') };
  await apply(ctx, { enabled: false });
});
