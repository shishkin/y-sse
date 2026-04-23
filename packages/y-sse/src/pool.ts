import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { Session } from "./session.ts";
import type { SessionEvent } from "./events.ts";

export class SessionPool extends EventTarget {
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
