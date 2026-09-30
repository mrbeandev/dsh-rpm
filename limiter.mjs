/**
 * Fixed one-minute-window per-route request limiter.
 *
 * Each route gets an independent counter for the current window. `acquire`
 * resolves immediately while the route is under its RPM cap; once the cap is
 * reached, callers queue until the next window reset. A queued caller whose
 * AbortSignal fires leaves the queue and rejects with the signal's reason, so
 * a cancelled chat never holds a slot. Timers are injectable so tests can
 * drive windows deterministically and the host owns teardown.
 */
export function createWindowLimiter(options = {}) {
  const windowMs = options.windowMs ?? 60000;
  const windows = new Map();

  function getWindow(route) {
    let win = windows.get(route);
    if (win === undefined) {
      win = { count: 0, waiters: new Set() };
      windows.set(route, win);
    }
    return win;
  }

  function reset() {
    for (const win of windows.values()) {
      win.count = 0;
      const waiters = [...win.waiters];
      win.waiters.clear();
      for (const wake of waiters) wake();
    }
  }

  function abortReason(signal) {
    return signal.reason ?? Object.assign(new Error('Aborted while waiting for a rate-limit slot'), { name: 'AbortError' });
  }

  let timer = null;

  const limiter = {
    /**
     * Wait until `route` has a free slot under `rpm`, then consume one slot.
     * Rechecks after every window reset, so a burst of released waiters cannot
     * overshoot the cap.
     * @param {string} route provider route id.
     * @param {number} rpm positive requests-per-window cap.
     * @param {AbortSignal} [signal] cancels the wait.
     * @returns {Promise<void>}
     */
    async acquire(route, rpm, signal) {
      const win = getWindow(route);
      for (;;) {
        if (signal?.aborted) throw abortReason(signal);
        if (win.count < rpm) {
          win.count += 1;
          return;
        }
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            win.waiters.delete(wake);
            reject(abortReason(signal));
          };
          const wake = () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          };
          win.waiters.add(wake);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
    },

    /** Start the periodic window reset. Idempotent. */
    start(setIntervalFn = setInterval) {
      if (timer === null) {
        timer = setIntervalFn(reset, windowMs);
        // Never keep the process alive just for this timer.
        timer?.unref?.();
      }
    },

    /** Stop the timer and release every queued waiter so nothing hangs. */
    dispose(clearIntervalFn = clearInterval) {
      if (timer !== null) {
        clearIntervalFn(timer);
        timer = null;
      }
      reset();
    },

    /** Detached per-route view: { route: { used, queued } }. For diagnostics and tests. */
    snapshot() {
      const out = {};
      for (const [route, win] of windows) out[route] = { used: win.count, queued: win.waiters.size };
      return out;
    },
  };

  return limiter;
}
