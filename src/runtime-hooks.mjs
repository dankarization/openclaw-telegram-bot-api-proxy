function defaultSleep(ms, options = {}) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timeout = setTimeout(finish, ms);
    timeout.unref?.();
    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createRuntimeHooks(overrides = {}) {
  const now = overrides.now || Date.now;
  const sleep = overrides.sleep || defaultSleep;
  const fault = overrides.fault || (() => {});
  return Object.freeze({
    now,
    sleep,
    async fault(point, context = {}) {
      await fault(point, context);
    },
  });
}

export const runtimeHooks = createRuntimeHooks();
