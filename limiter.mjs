/**
 * Fixed one-minute-window per-route request limiter.
 *
 * Each key gets an independent counter for the current window. `acquire`
 * resolves immediately while the key is under its RPM cap; once the cap is
 * reached, callers queue on a promise released by the next window reset.
 * Timers are injectable so tests can drive windows deterministically and the
 * host can own teardown.
 */
export function createWindowLimiter(options = {}) {
  const windowMs = options.windowMs ?? 60000;
  const windows = new Map();

  function getWindow(key) {
    let win = windows.get(key);
    if (win === undefined) {
      win = { count: 0, waiters: [] };
      windows.set(key, win);
    }
    return win;
  }

  function reset() {
    for (const win of windows.values()) {
      win.count = 0;
      const waiters = win.waiters;
      win.waiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  let timer = null;

  const limiter = {
    /**
     * Wait until `route` has a free slot under `rpm`, then consume one slot.
     * Rechecks after every window reset so a burst of released waiters cannot
     * overshoot the cap.
     * @param {string} route provider route id.
     * @param {number} rpm positive requests-per-window cap.
     * @returns {Promise<void>}
     */
    acquire(route, rpm) {
      const win = getWindow(route);
      if (win.count < rpm) {
        win.count += 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => win.waiters.push(resolve))
        .then(() => limiter.acquire(route, rpm));
    },

    /** Start the periodic window reset. Idempotent. */
    start(setIntervalFn = setInterval) {
      if (timer === null) timer = setIntervalFn(reset, windowMs);
    },

    /** Stop the timer and release every queued waiter so nothing hangs. */
    dispose(clearIntervalFn = clearInterval) {
      if (timer !== null) {
        clearIntervalFn(timer);
        timer = null;
      }
      reset();
    },

    /** Detached per-route view: { route: count }. For diagnostics/tests. */
    snapshot() {
      const out = {};
      for (const [route, win] of windows) out[route] = win.count;
      return out;
    },
  };

  return limiter;
}
