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
