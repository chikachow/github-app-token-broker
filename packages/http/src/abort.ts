export function awaitWithAbortSignal<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const rejectForAbort = () => {
      reject(signal.reason);
    };
    const removeAbortListener = () => {
      signal.removeEventListener("abort", rejectForAbort);
    };

    signal.addEventListener("abort", rejectForAbort, { once: true });
    void operation.then(
      (value) => {
        removeAbortListener();
        resolve(value);
      },
      (error: unknown) => {
        removeAbortListener();
        reject(error);
      },
    );
  });
}
