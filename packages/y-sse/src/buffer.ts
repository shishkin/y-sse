import * as Y from "yjs";
import type { ClientEvent, SourceEvent } from "./events.ts";

export function bufferUpdates({
  maxDelay: maxDelay = 1000,
  maxCount,
}: { maxDelay?: number; maxCount?: number } = {}): TransformStream<SourceEvent, ClientEvent> {
  let ctrl: TransformStreamDefaultController<ClientEvent>;
  let updates: Uint8Array[] = [];
  let awareness: Uint8Array | undefined;
  let timeoutHandle: any;
  const flush = () => {
    clearTimeout(timeoutHandle);
    timeoutHandle = undefined;
    if (!updates.length) {
      return;
    }
    const update = Y.mergeUpdates(updates);
    ctrl.enqueue({ event: "update", update, awareness });
    updates = [];
    awareness = undefined;
  };
  return new TransformStream<SourceEvent, ClientEvent>(
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
        } else if (e.event === "awareness") {
          awareness = e.payload;
          if (!timeoutHandle) {
            timeoutHandle = setTimeout(flush, maxDelay);
          }
        } else if (e.event === "snapshot") {
          // snapshots invalidates pending updates:
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
          updates = [];
          ctrl.enqueue({ event: "snapshot", snapshot: e.payload });
        } else {
          // ignore
        }
      },
      flush() {
        flush();
        ctrl.terminate();
      },
    },
    new CountQueuingStrategy({ highWaterMark: Infinity }),
  );
}
