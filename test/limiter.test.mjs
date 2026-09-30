import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindowLimiter } from '../limiter.mjs';

/** Manual timer driver: collect the reset callback and fire it on demand. */
function fakeTimers() {
  const timers = [];
  return {
    setInterval: (fn) => { timers.push(fn); return fn; },
    clearInterval: (fn) => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); },
    tick: () => { for (const fn of [...timers]) fn(); },
    pending: () => timers.length,
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('under the cap, acquire resolves immediately', async () => {
  const limiter = createWindowLimiter();
  await limiter.acquire('p', 2);
  await limiter.acquire('p', 2);
  assert.deepEqual(limiter.snapshot(), { p: { used: 2, queued: 0 } });
});

test('routes do not share windows', async () => {
  const limiter = createWindowLimiter();
  await limiter.acquire('a', 1);
  await limiter.acquire('b', 1);
  assert.deepEqual(limiter.snapshot(), { a: { used: 1, queued: 0 }, b: { used: 1, queued: 0 } });
});

test('over the cap, callers queue until the window resets', async () => {
  const timers = fakeTimers();
  const limiter = createWindowLimiter();
  limiter.start(timers.setInterval);

  await limiter.acquire('p', 1);
  let released = false;
  const waiting = limiter.acquire('p', 1).then(() => { released = true; });
  await flush();
  assert.equal(released, false);
  assert.deepEqual(limiter.snapshot(), { p: { used: 1, queued: 1 } });

  timers.tick();
  await waiting;
  assert.equal(released, true);
  assert.deepEqual(limiter.snapshot(), { p: { used: 1, queued: 0 } });

  limiter.dispose(timers.clearInterval);
  assert.equal(timers.pending(), 0);
});

test('released waiters cannot overshoot the cap', async () => {
  const timers = fakeTimers();
  const limiter = createWindowLimiter();
  limiter.start(timers.setInterval);

  await limiter.acquire('p', 1); // fills window 1
  const order = [];
  const w1 = limiter.acquire('p', 1).then(() => order.push('w1'));
  const w2 = limiter.acquire('p', 1).then(() => order.push('w2'));

  timers.tick(); // window 2: only one waiter fits
  await w1;
  await flush();
  assert.deepEqual(order, ['w1']);

  timers.tick(); // window 3: the other waiter fits
  await w2;
  assert.deepEqual(order, ['w1', 'w2']);

  limiter.dispose(timers.clearInterval);
});

test('an aborted waiter leaves the queue and never takes a slot', async () => {
  const timers = fakeTimers();
  const limiter = createWindowLimiter();
  limiter.start(timers.setInterval);

  await limiter.acquire('p', 1);
  const controller = new AbortController();
  const cancelled = limiter.acquire('p', 1, controller.signal);
  const survivor = limiter.acquire('p', 1);
  await flush();
  assert.equal(limiter.snapshot().p.queued, 2);

  controller.abort(new Error('user stopped the turn'));
  await assert.rejects(cancelled, /user stopped the turn/);
  assert.equal(limiter.snapshot().p.queued, 1);

  timers.tick();
  await survivor; // the slot went to the survivor, not the cancelled caller
  assert.deepEqual(limiter.snapshot(), { p: { used: 1, queued: 0 } });
  limiter.dispose(timers.clearInterval);
});

test('an already-aborted signal rejects without consuming a slot', async () => {
  const limiter = createWindowLimiter();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(limiter.acquire('p', 5, controller.signal), { name: 'AbortError' });
  assert.deepEqual(limiter.snapshot(), { p: { used: 0, queued: 0 } });
});

test('dispose releases queued waiters so nothing hangs', async () => {
  const timers = fakeTimers();
  const limiter = createWindowLimiter();
  limiter.start(timers.setInterval);
  await limiter.acquire('p', 1);
  const waiting = limiter.acquire('p', 1);
  limiter.dispose(timers.clearInterval);
  await waiting; // resolves after the dispose reset + fresh slot
});
