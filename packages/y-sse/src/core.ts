import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";

export type SessionEvent =
  | { event: "init"; payload: { session: string } }
  | { event: "ping" }
  | { event: "update"; payload: Uint8Array }
  | { event: "awareness"; payload: Uint8Array };

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
      cancel(reason) {
        self.close();
      },
    });
  }
}

export class SharedDoc extends EventTarget {
  readonly sessions: Map<string, Session> = new Map();
  readonly awareness: awarenessProtocol.Awareness | undefined;

  constructor(
    readonly id: string,
    readonly doc: Y.Doc,
    private readonly opts: { enableAwareness?: boolean; pingInterval?: number } = {},
  ) {
    super();
    opts.enableAwareness ??= true;
    if (opts.enableAwareness) {
      this.awareness = new awarenessProtocol.Awareness(doc);
    }
  }

  newSession(): Session {
    const session = new Session({
      id: Math.random().toString(36).substring(2),
      doc: this.doc,
      awareness: this.awareness,
      pingInterval: this.opts.pingInterval,
      mode: "server",
    });
    this.sessions.set(session.id, session);
    console.debug("session connected", session.id, this.sessions.keys().toArray());
    session.abortSignal.addEventListener("abort", () => this.onSessionClosed(session), {
      once: true,
    });
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  private onSessionClosed(session: Session): void {
    this.sessions.delete(session.id);
    if (!this.sessions.size) {
      this.dispatchEvent(new CustomEvent("closed"));
    }
  }

  apply(e: SessionEvent, originSession: string): void {
    switch (e.event) {
      case "update":
        Y.applyUpdate(this.doc, e.payload, originSession);
        console.debug("server text:", this.doc.getText("text").toString());
        break;
      case "awareness":
        if (this.awareness) {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, e.payload, originSession);
        }
        break;
      default:
      // ignore
    }
  }
}
