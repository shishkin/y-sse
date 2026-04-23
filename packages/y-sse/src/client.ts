import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import { UpdateStatusEvent, type UpdateStatus } from "./events.ts";
import { Session } from "./session.ts";
import { sseSink, sseSource } from "./sse.ts";
import { bufferUpdates } from "./buffer.ts";

export interface ClientOptions {
  doc: Y.Doc;
  docId: string;
  pathPrefix?: string;
  awareness?: {
    enable?: boolean;
    name?: string;
    color?: string;
  };
  minRetryDelay?: number;
  maxRetryDelay?: number;
  maxRetries?: number;
  requestTimeout?: number;
  updateBufferDelay?: number;
}

export class SseProvider extends EventTarget {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness | undefined;
  private _updateStatus: UpdateStatus = "idle";
  private readonly opts;

  constructor({ doc, ...opts }: ClientOptions) {
    super();
    this.doc = doc;
    this.opts = {
      ...opts,
      pathPrefix: opts.pathPrefix ?? "/sse",
      awareness: {
        ...opts.awareness,
        enable: opts.awareness?.enable ?? true,
      },
    };

    const { enable: enableAwareness, ...awarenessOpts } = this.opts.awareness;
    if (enableAwareness) {
      this.awareness = new awarenessProtocol.Awareness(this.doc);
      this.awareness.setLocalStateField("user", awarenessOpts);
      window.addEventListener("beforeunload", () => {
        awarenessProtocol.removeAwarenessStates(
          this.awareness!,
          [this.doc.clientID],
          "window unload",
        );
      });
    }

    this.start();
  }

  private async start() {
    const source = sseSource({ docId: this.opts.docId, pathPrefix: this.opts.pathPrefix });
    const self = this;
    let session: Session | undefined;
    try {
      for await (const e of source) {
        switch (e.event) {
          case "init":
            session?.close();
            session = new Session({
              doc: this.doc,
              awareness: this.awareness,
              id: e.payload.session,
            });
            const sink = sseSink({
              sessionId: e.payload.session,
              ...this.opts,
              statusStream: new WritableStream({
                write(status) {
                  self.updateStatus = status;
                },
              }),
            });
            session
              .getEvents()
              .pipeThrough(bufferUpdates({ maxDelay: this.opts.updateBufferDelay }))
              .pipeTo(sink);
            session.push(e);
            break;
          default:
            session?.push(e);
            break;
        }
      }
    } catch (e) {
      // restart the session when it breaks:
      session?.close();
      await this.start();
    }
  }

  private set updateStatus(s: UpdateStatus) {
    if (s !== this._updateStatus) {
      this._updateStatus = s;
      this.dispatchEvent(new UpdateStatusEvent({ status: s }));
    }
  }

  get updateStatus(): UpdateStatus {
    return this._updateStatus;
  }
}
