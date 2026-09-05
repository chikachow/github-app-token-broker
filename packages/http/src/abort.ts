export function awaitWithAbortSignal<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const rejectForAbort = () => {
      reject(signal.reason);
    };
    const removeAbortListener = () => {
      signal.removeEventListener("abort", rejectForAbort);
    };

    if (signal.aborted) {
      rejectForAbort();
    } else {
      signal.addEventListener("abort", rejectForAbort, { once: true });
    }

    // The operation can still reject after cancellation, including a pre-abort.
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
