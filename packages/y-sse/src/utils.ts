export function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(s, "base64");
  } else {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  }
}

export function toBase64(buffer: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buffer).toString("base64");
  } else {
    return btoa(String.fromCharCode(...buffer));
  }
}

export function throttle<F extends (...args: any[]) => void>(fn: F, wait: number): F {
  let timeout: any | undefined;
  let lastArgs: any[] | undefined;

  const exec = function (this: any) {
    if (lastArgs) {
      fn.apply(this, lastArgs);
      lastArgs = undefined;
      timeout = setTimeout(exec, wait);
    } else {
      timeout = undefined;
    }
  };

  return function (this: any, ...args: any[]) {
    lastArgs = args;
    if (!timeout) {
      exec();
    }
  } as F;
}

export interface RetryOptions {
  minRetryDelay?: number;
  maxRetryDelay?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  onError?: (err: unknown) => void;
}

export async function retryWithBackoff<T = void, F extends () => PromiseLike<T> = () => Promise<T>>(
  fn: F,
  { minRetryDelay = 0, maxRetryDelay = Infinity, maxRetries, signal, onError }: RetryOptions,
): Promise<T> {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) {
      throw signal?.reason ?? new Error("Retrying aborted");
    }
    try {
      return await fn();
    } catch (err) {
      onError?.(err);
      if (maxRetries && attempt > maxRetries) {
        throw err;
      }
      if (!signal?.aborted) {
        const delay = Math.min(
          minRetryDelay * Math.pow(2, Math.max(attempt - 1, 0)),
          maxRetryDelay,
        );
        await wait(delay, { signal });
        attempt++;
      }
    }
  }
}

export function wait(delay: number, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const handleAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Signal aborted"));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delay);
  });
}
