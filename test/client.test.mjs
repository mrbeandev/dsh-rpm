import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createClientPlugin } from '../client/index.mjs';

/** Minimal store with the shape of a settings scope / config form. */
function store(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { snapshot = next; for (const fn of listeners) fn(); },
  };
}

const REGISTERED = [
  { id: 'cc', name: 'cc' },
  { id: '9router', name: '9router' },
  { id: 'deepseek-official', name: 'DeepSeek' },
];

/**
 * Fake React + fake DSH client services. `mode` selects the DSH generation:
 * 'forms' (0.1.7+, configForms) or 'scope' (0.1.5, settingsScope).
 */
function harness({ mode = 'forms', value = { providers: {} }, form: formState = {}, mutateImpl, remote = {} } = {}) {
  const entryNs = mode === 'forms' ? 'include:dsh-rpm' : 'dsh-rpm';
  const mirror = store({ view: { writable: true, namespaces: [{ ns: entryNs, value }] } });
  mirror.ensure = () => Promise.resolve();
  const form = store({ status: 'ready', value, revision: 4, writable: true, mode: 'host', ...formState });
  const calls = [];
  form.mutate = async (ops, revision) => {
    calls.push({ ops, revision });
    if (mutateImpl) return mutateImpl(ops, revision, form);
    const current = form.getSnapshot();
    const providers = { ...current.value.providers };
    for (const op of ops) {
      if (op.op === 'unset') delete providers[op.path[1]];
      else providers[op.path[1]] = op.value;
    }
    form.set({ ...current, revision: current.revision + 1, value: { providers } });
    return true;
  };
  const events = new Map();
  const services = {
    remote: {
      llm: { listProviders: remote.listProviders ?? (async () => ({ ok: true, value: REGISTERED })) },
      $on(event, fn) { events.set(event, fn); return () => events.delete(event); },
    },
  };
  const formsRequested = [];
  if (mode === 'forms') {
    services.configForms = { describe: () => mirror, get(ns) { formsRequested.push(ns); return form; } };
  } else {
    services.settingsScope = {
      describe: () => mirror,
      bind(spec) { assert.deepEqual(spec, { namespace: 'dsh-rpm' }); return form; },
    };
  }

  // Fake React with per-instance hook state; effects run after the first render.
  let active;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const instance = active, index = instance.cursor++;
      if (!(index in instance.state)) instance.state[index] = initial;
      return [instance.state[index], next => {
        instance.state[index] = typeof next === 'function' ? next(instance.state[index]) : next;
      }];
    },
    useRef(initial) {
      const instance = active, index = instance.cursor++;
      return instance.state[index] ??= { current: initial };
    },
    useCallback(fn, deps) {
      const instance = active, index = instance.cursor++;
      const previous = instance.state[index];
      if (previous && deps.every((dep, i) => dep === previous.deps[i])) return previous.fn;
      instance.state[index] = { fn, deps };
      return fn;
    },
    // Effects re-run when their deps change, like React; the first run is deferred.
    useEffect(fn, deps) {
      const instance = active, index = instance.cursor++;
      const previous = instance.state[index];
      const changed = !previous || !deps || deps.some((dep, i) => dep !== previous.deps[i]);
      if (!changed) return;
      instance.state[index] = { deps };
      instance.pendingEffects.push(() => { instance.state[index] = { deps, cleanup: fn() }; });
    },
    useId: () => `id-${active.cursor++}`,
    useSyncExternalStore(subscribe, getSnapshot) {
      const instance = active, index = instance.cursor++;
      if (!(index in instance.state)) instance.state[index] = subscribe(() => { instance.notifications++; });
      return getSnapshot();
    },
  };
  const plugin = createClientPlugin(name => { assert.equal(name, 'react'); return React; });
  const registrations = [];
  const ctx = {
    ...services,
    inject(names, callback) {
      if (names.every(name => name in services)) callback(ctx);
    },
    slots: {
      inject(name, callback) { assert.equal(name, 'settings.section'); callback(); },
      register(options, view) { registrations.push({ options, view }); },
    },
  };
  plugin.apply(ctx);
  function page() {
    const instance = { state: [], cursor: 0, notifications: 0, pendingEffects: [] };
    const children = new Map();
    function expand(node) {
      if (node === null || node === undefined || typeof node !== 'object') return node;
      if (typeof node.type === 'function') {
        const key = node.props.key ?? node.props.row?.route;
        if (!children.has(key)) children.set(key, { state: [], cursor: 0, notifications: 0, pendingEffects: [] });
        const child = children.get(key);
        const outer = active;
        active = child; child.cursor = 0;
        const tree = node.type(node.props);
        for (const effect of child.pendingEffects.splice(0)) effect();
        active = outer;
        return expand(tree);
      }
      return { ...node, children: node.children.map(expand) };
    }
    const { options, view } = registrations[0];
    return {
      render() {
        active = instance; active.cursor = 0;
        const tree = view({ ...options.inject() });
        for (const effect of instance.pendingEffects.splice(0)) effect();
        return expand(tree);
      },
    };
  }
  return { plugin, registrations, page, calls, form, mirror, events, formsRequested };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flatMap(child => nodes(child, predicate))];
}
function inputs(tree) { return nodes(tree, n => n.type === 'input').map(n => n.props); }
function applyButtons(tree) { return nodes(tree, n => n.type === 'button' && n.children.includes('Apply')).map(n => n.props); }
function labels(tree) { return nodes(tree, n => n.type === 'label').map(n => n.children.join('')); }
function textOf(tree) { return JSON.stringify(tree); }
async function loaded(h) {
  const p = h.page();
  p.render();
  await flush();
  return p;
}
/** Type a value into the row at `index`, re-render, press its Apply. */
async function setLimit(p, index, value) {
  inputs(p.render())[index].onChange({ currentTarget: { value } });
  applyButtons(p.render())[index].onClick();
  await flush();
  p.render(); // settle post-commit effects, as React's re-render would
}

test('registers one Settings tab with shell React only, and no provider-card seat', () => {
  const h = harness();
  assert.deepEqual(h.plugin.inject, ['slots', 'remote', 'remote.llm']);
  assert.equal(h.registrations.length, 1);
  const { options } = h.registrations[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'dsh-rpm');
  assert.equal(options.label(), 'Rate limits');
  assert.doesNotMatch(createClientPlugin.toString(), /provider-card|short-tool-ids/);
});

test('DSH 0.1.7+ uses configForms with the include:dsh-rpm entry', async () => {
  const h = harness({ mode: 'forms' });
  const p = await loaded(h);
  assert.deepEqual(h.formsRequested, ['include:dsh-rpm']);
  assert.equal(inputs(p.render()).length, 3);
});

test('DSH 0.1.5 uses settingsScope namespace dsh-rpm', async () => {
  const h = harness({ mode: 'scope' });
  const p = await loaded(h);
  assert.deepEqual(h.formsRequested, []);
  assert.equal(inputs(p.render()).length, 3);
});

test('page has a heading, a note, and every provider with its own input (default unlimited)', async () => {
  const tree = (await loaded(harness())).render();
  assert.equal(nodes(tree, n => n.type === 'h2')[0].children.join(''), 'Rate limits');
  assert.equal(nodes(tree, n => n.props?.role === 'note').length, 1);
  assert.deepEqual(labels(tree), ['9router', 'cc', 'DeepSeek']);
  assert.ok(inputs(tree).every(input => input.value === '' && input.placeholder === 'unlimited' && input.disabled === false));
  assert.match(textOf(tree), /Providers \(0 limited\)/);
});

test('saved limits restore per provider', async () => {
  const tree = (await loaded(harness({ value: { providers: { cc: 30 } } }))).render();
  const [nineRouter, cc] = inputs(tree);
  assert.equal(cc.value, '30');
  assert.equal(nineRouter.value, '');
  assert.match(textOf(tree), /Providers \(1 limited\)/);
});

test('Apply writes only that provider path with the rendered revision', async () => {
  const h = harness();
  const p = await loaded(h);
  await setLimit(p, 1, '15');
  assert.deepEqual(h.calls, [{ ops: [{ op: 'set', path: ['providers', 'cc'], value: 15 }], revision: 4 }]);
  assert.equal(inputs(p.render())[1].value, '15');
  assert.equal(inputs(p.render())[0].value, '');
});

test('clearing the field or entering 0 removes the limit', async () => {
  for (const value of ['', '0']) {
    const h = harness({ value: { providers: { cc: 30 } } });
    const p = await loaded(h);
    await setLimit(p, 1, value);
    assert.deepEqual(h.calls, [{ ops: [{ op: 'unset', path: ['providers', 'cc'] }], revision: 4 }], JSON.stringify(value));
    assert.equal(inputs(p.render())[1].value, '');
  }
});

test('invalid numbers are refused without a write', async () => {
  for (const value of ['-1', '1.5', 'abc']) {
    const h = harness();
    const p = await loaded(h);
    await setLimit(p, 1, value);
    assert.equal(h.calls.length, 0, value);
    assert.match(textOf(p.render()), /positive whole number/);
  }
});

test('a limited provider that no longer exists stays listed so its limit can be removed', async () => {
  const tree = (await loaded(harness({ value: { providers: { gone: 5 } } }))).render();
  assert.ok(labels(tree).includes('gone'));
  assert.match(textOf(tree), /no longer configured/);
});

test('loading, unavailable, read-only and memory states cannot write', async () => {
  for (const state of [{ status: 'loading' }, { status: 'unavailable' }, { writable: false }, { mode: 'memory' }]) {
    const h = harness({ form: state });
    const p = await loaded(h);
    assert.ok(inputs(p.render()).every(input => input.disabled), JSON.stringify(state));
    await setLimit(p, 1, '5');
    assert.equal(h.calls.length, 0);
  }
});

test('host plugin not running: explains why instead of failing silently', async () => {
  const h = harness();
  h.mirror.set({ view: { writable: true, namespaces: [] } });
  const tree = (await loaded(h)).render();
  assert.match(textOf(tree), /dsh-rpm host plugin is not running/);
  assert.ok(inputs(tree).every(input => input.disabled));
});

test('pending write blocks duplicates; failure shows a safe error only', async () => {
  let reject;
  const h = harness({ mutateImpl: () => new Promise((_, no) => { reject = no; }) });
  const p = await loaded(h);
  inputs(p.render())[1].onChange({ currentTarget: { value: '5' } });
  applyButtons(p.render())[1].onClick();
  assert.ok(inputs(p.render()).every(input => input.disabled));
  applyButtons(p.render())[1].onClick();
  assert.equal(h.calls.length, 1);
  reject(new Error('SECRET_CONFIGURATION_DETAILS'));
  await flush();
  const tree = p.render();
  assert.equal(nodes(tree, n => n.props?.role === 'alert').length, 1);
  assert.doesNotMatch(textOf(tree), /SECRET_CONFIGURATION_DETAILS/);
});

test('refused write that settles without throwing is detected', async () => {
  const h = harness({ mutateImpl: async () => false });
  const p = await loaded(h);
  await setLimit(p, 1, '5');
  const tree = p.render();
  assert.equal(nodes(tree, n => n.props?.role === 'alert').length, 1);
});

test('provider list failure offers a retry; empty list explains what to do', async () => {
  let fail = true;
  const h = harness({ remote: { listProviders: async () => (fail ? { ok: false, error: { message: 'x' } } : { ok: true, value: [] }) } });
  const p = await loaded(h);
  let tree = p.render();
  assert.match(textOf(tree), /Could not load the provider list/);
  fail = false;
  nodes(tree, n => n.type === 'button' && n.children.includes('Retry'))[0].props.onClick();
  await flush();
  tree = p.render();
  assert.match(textOf(tree), /No model providers are configured yet/);
});

test('provider changes pushed by the host refresh the list', async () => {
  let list = REGISTERED.slice(0, 1);
  const h = harness({ remote: { listProviders: async () => ({ ok: true, value: list }) } });
  const p = await loaded(h);
  assert.equal(inputs(p.render()).length, 1);
  list = REGISTERED;
  h.events.get('llm/adapters-updated')();
  await flush();
  assert.equal(inputs(p.render()).length, 3);
});

test('buildRows lists every registered provider, sorted by name', () => {
  const { buildRows } = createClientPlugin(() => ({}));
  const rows = buildRows({ registered: [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'cc', name: '9router' }], limits: {} });
  assert.deepEqual(rows.map(row => row.route), ['cc', 'deepseek-official']);
  assert.ok(rows.every(row => row.active));
});

test('buildRows and findEntryNamespace ignore malformed data', () => {
  const { buildRows, findEntryNamespace } = createClientPlugin(() => ({}));
  const rows = buildRows({
    registered: [{ id: 'cc', name: '9router' }, { id: '' }, { name: 'oops' }, null, { id: 7 }],
    limits: { 'gone-provider': 10, weak: -1, bogus: 'fast', cc: 30 },
  });
  const byRoute = Object.fromEntries(rows.map(row => [row.route, row]));
  assert.equal(rows.length, 2);
  assert.equal(byRoute.cc.active, true);
  assert.equal(byRoute['gone-provider'].active, false);
  assert.equal(buildRows({ registered: null, limits: null }).length, 0);
  const ns = (...ids) => ids.map(id => ({ ns: id }));
  assert.equal(findEntryNamespace(ns('llm-deepseek', 'include:dsh-rpm')), 'include:dsh-rpm');
  assert.equal(findEntryNamespace(ns('x:dsh-rpm', 'include:dsh-rpm')), 'include:dsh-rpm');
  assert.equal(findEntryNamespace(ns('dsh-rpm')), 'dsh-rpm');
  assert.equal(findEntryNamespace(ns('profile-web:dsh-rpm')), 'profile-web:dsh-rpm');
  assert.equal(findEntryNamespace(ns('llm-deepseek')), undefined);
  assert.equal(findEntryNamespace(undefined), undefined);
});

test('distributed bundle registers lazily and matches authored factory', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let registration;
  vm.runInNewContext(bundle, { window: { __ModuleLoader__: { load(value) { registration = value; } } } });
  assert.equal(registration.id, 'dsh-rpm');
  assert.equal(typeof registration.factory, 'function');
  assert.equal(registration.factory.toString(), createClientPlugin.toString());
  const requests = [];
  const plugin = registration.factory(name => { requests.push(name); return {}; });
  assert.deepEqual(requests, ['react']);
  assert.equal(typeof plugin.apply, 'function');
});
