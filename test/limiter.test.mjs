import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindowLimiter } from '../limiter.mjs';

/** Manual timer driver: collect the reset callback and fire it on demand. */
function fakeTimers() {
  const timers = [];
  return {
    setInterval: (fn) => { timers.push(fn); return fn; },
    clearInterval: (fn) => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); },
    tick: () => { for (const fn of timers) fn(); },
    pending: () => timers.length,
  };
}

test('under the cap, acquire resolves immediately', async () => {
  const limiter = createWindowLimiter();
  await limiter.acquire('p', 2);
  await limiter.acquire('p', 2);
  assert.deepEqual(limiter.snapshot(), { p: 2 });
});

test('routes do not share windows', async () => {
  const limiter = createWindowLimiter();
  await limiter.acquire('a', 1);
  await limiter.acquire('b', 1);
  assert.deepEqual(limiter.snapshot(), { a: 1, b: 1 });
});

test('over the cap, callers queue until the window resets', async () => {
  const timers = fakeTimers();
  const limiter = createWindowLimiter();
  limiter.start(timers.setInterval);

  await limiter.acquire('p', 1);
  let released = false;
  const waiting = limiter.acquire('p', 1).then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false);

  timers.tick();
  await waiting;
  assert.equal(released, true);
  assert.deepEqual(limiter.snapshot(), { p: 1 });

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
  await Promise.resolve();
  assert.deepEqual(order, ['w1']);

  timers.tick(); // window 3: the other waiter fits
  await w2;
  assert.deepEqual(order, ['w1', 'w2']);

  limiter.dispose(timers.clearInterval);
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
