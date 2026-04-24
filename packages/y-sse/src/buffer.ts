import * as Y from "yjs";
import type { SessionEvent } from "./events.ts";

export function bufferUpdates({
  maxDelay: maxDelay = 1000,
  maxCount,
}: { maxDelay?: number; maxCount?: number } = {}): TransformStream<SessionEvent, SessionEvent> {
  let ctrl: TransformStreamDefaultController<SessionEvent>;
  let updates: Uint8Array[] = [];
  let timeoutHandle: any;
  const flush = () => {
    clearTimeout(timeoutHandle);
    timeoutHandle = undefined;
    if (!updates.length) {
      return;
    }
    const payload = Y.mergeUpdates(updates);
    ctrl.enqueue({ event: "update", payload });
    updates = [];
  };
  return new TransformStream(
    {
      start(controller) {
        ctrl = controller;
      },
      transform(e) {
        if (e.event === "update") {
          updates.push(e.payload);
          if (maxCount && updates.length >= maxCount) {
            flush();
          } else if (!timeoutHandle) {
            timeoutHandle = setTimeout(flush, maxDelay);
          }
        } else {
          // other events flush updates
          flush();
          ctrl.enqueue(e);
        }
      },
      flush,
    },
    new CountQueuingStrategy({ highWaterMark: Infinity }),
  );
}
