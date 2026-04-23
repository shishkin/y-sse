import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import type { SessionEvent } from "./events.ts";

export class Session {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness | undefined;
  private readonly opts;
  private readonly abort = new AbortController();

  constructor({
    id,
    doc,
    awareness,
    ...opts
  }: {
    doc: Y.Doc;
    id: string;
    awareness?: awarenessProtocol.Awareness;
    pingInterval?: number;
    mode?: "server" | "client";
  }) {
    this.id = id;
    this.doc = doc;
    this.awareness = awareness;
    this.opts = opts;
  }

  get abortSignal(): AbortSignal {
    return this.abort.signal;
  }

  close(): void {
    if (!this.abortSignal.aborted) {
      this.abort.abort();
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  push(event: SessionEvent): void {
    if (this.abortSignal.aborted) {
      return;
    }
    switch (event.event) {
      case "update":
        Y.applyUpdate(this.doc, event.payload);
        break;
      case "awareness":
        if (this.awareness) {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, event.payload, undefined);
        }
        break;
      default:
      // ignore
    }
  }

  getEvents({ signal }: { signal?: AbortSignal } = {}): ReadableStream<SessionEvent> {
    const self = this;
    let pingHandle: any;
    let ctrl: ReadableStreamDefaultController<SessionEvent>;
    const onUpdate = (update: Uint8Array) => ctrl.enqueue({ event: "update", payload: update });
    const onAwareness = ({
      added,
      updated,
      removed,
    }: {
      added: number[];
      updated: number[];
      removed: number[];
    }) => {
      const changed = added.concat(updated).concat(removed);
      const update = awarenessProtocol.encodeAwarenessUpdate(self.awareness!, changed);
      ctrl.enqueue({ event: "awareness", payload: update });
    };
    const onAbort = () => {
      self.doc.off("update", onUpdate);
      self.awareness?.off("update", onAwareness);
      if (pingHandle) {
        clearInterval(pingHandle);
      }
    };
    signal?.addEventListener("abort", this.close.bind(this), { once: true });
    self.abortSignal.addEventListener("abort", onAbort, { once: true });
    return new ReadableStream({
      start(controller) {
        if (self.abortSignal.aborted) {
          controller.close();
          return;
        }
        ctrl = controller;
        if (self.opts.mode === "server") {
          controller.enqueue({ event: "init", payload: { session: self.id } });
          if (self.opts.pingInterval) {
            pingHandle = setInterval(
              () => controller.enqueue({ event: "ping" }),
              self.opts.pingInterval,
            );
          }
          const update = Y.encodeStateAsUpdate(self.doc);
          controller.enqueue({ event: "update", payload: update });
        }
        self.doc.on("update", onUpdate);
        if (self.awareness) {
          if (self.opts.mode === "server") {
            const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
              self.awareness,
              Array.from(self.awareness.getStates().keys()),
            );
            controller.enqueue({ event: "awareness", payload: awarenessUpdate });
          }
          self.awareness.on("update", onAwareness);
        }
      },
      cancel() {
        self.close();
      },
    });
  }
}
