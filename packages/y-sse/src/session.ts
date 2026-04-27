import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import type { ClientEvent, SourceEvent } from "./events.ts";

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

  apply(e: SourceEvent): void {
    if (this.abortSignal.aborted) {
      return;
    }
    switch (e.event) {
      case "snapshot":
      case "update":
        Y.applyUpdate(this.doc, e.payload);
        break;
      case "awareness":
        if (this.awareness) {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, e.payload, undefined);
        }
        break;
      default:
      // ignore
    }
  }

  getEvents({ signal }: { signal?: AbortSignal } = {}): ReadableStream<SourceEvent> {
    const self = this;
    let pingHandle: any;
    let ctrl: ReadableStreamDefaultController<SourceEvent>;
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
          controller.enqueue({ event: "init", session: self.id });
          if (self.opts.pingInterval) {
            pingHandle = setInterval(
              () => controller.enqueue({ event: "ping" }),
              self.opts.pingInterval,
            );
          }
        }

        const update = Y.encodeStateAsUpdate(self.doc);
        controller.enqueue({ event: "snapshot", payload: update });
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

  getClientEvents({ delay }: { delay?: number }): ReadableStream<ClientEvent> {
    const self = this;
    let ctrl: ReadableStreamDefaultController<ClientEvent>;
    let stateVector: Uint8Array | undefined;
    const getUpdates = (): ClientEvent => {
      const update = Y.encodeStateAsUpdate(this.doc, stateVector);
      stateVector = Y.encodeStateVector(this.doc);
      let awareness: Uint8Array | undefined;
      if (this.awareness) {
        awareness = awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          Array.from(this.awareness.getStates().keys()),
        );
      }
      return { event: "update", update, awareness };
    };
    const pull = (): Promise<ClientEvent> => {
      return delay
        ? new Promise<ClientEvent>((resolve) => {
            setTimeout(() => {
              resolve(getUpdates());
            }, delay);
          })
        : Promise.resolve(getUpdates());
    };
    return new ReadableStream<ClientEvent>(
      {
        start(controller) {
          ctrl = controller;
          const snapshot = Y.encodeStateAsUpdate(self.doc);
          stateVector = Y.encodeStateVector(self.doc);
          controller.enqueue({ event: "snapshot", snapshot });
        },
        async pull(controller) {
          for (let i = 0; i < (controller.desiredSize ?? 1); i++) {
            if (self.abortSignal.aborted) {
              controller.close();
              return;
            }
            const item = await pull();
            if (!item) {
              break;
            }
            controller.enqueue(item);
          }
        },
        cancel(reason) {
          self.abort.abort(reason);
          ctrl.close();
        },
      },
      new CountQueuingStrategy({ highWaterMark: 1 }),
    );
  }
}
