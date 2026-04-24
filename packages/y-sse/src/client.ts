import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import { UpdateStatusEvent, type UpdateStatus } from "./events.ts";
import { Session } from "./session.ts";
import { sseSink, sseSource } from "./sse.ts";
import { bufferUpdates } from "./buffer.ts";
import type { RetryOptions } from "./utils.ts";

export interface ClientOptions {
  doc: Y.Doc;
  docId: string;
  pathPrefix?: string;
  awareness?: {
    enable?: boolean;
    name?: string;
    color?: string;
  };
  retryOptions?: RetryOptions;
  requestTimeout?: number;
  updateBufferDelay?: number;
}

export class SseProvider extends EventTarget {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness | undefined;
  private _updateStatus: UpdateStatus = "idle";
  private readonly docId;
  private readonly pathPrefix;
  private readonly requestTimeout;
  private readonly updateBufferDelay;
  private readonly retryOptions;

  constructor({ doc, ...opts }: ClientOptions) {
    super();
    this.doc = doc;
    this.docId = opts.docId;
    this.pathPrefix = opts.pathPrefix ?? "/sse";
    this.requestTimeout = opts.requestTimeout ?? 3_000;
    this.updateBufferDelay = opts.updateBufferDelay ?? 1_000;
    this.retryOptions = opts.retryOptions ?? {};
    this.retryOptions.minRetryDelay ??= 500;
    this.retryOptions.maxRetryDelay ??= 30_000;

    const { enable: enableAwareness = true, ...awarenessOpts } = opts.awareness ?? {};
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
    const source = sseSource({
      docId: this.docId,
      pathPrefix: this.pathPrefix,
      retryOptions: this.retryOptions,
      statusStream: new WritableStream({
        write(status) {
          self.updateStatus = status;
        },
      }),
    });
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
              docId: this.docId,
              pathPrefix: this.pathPrefix,
              sessionId: e.payload.session,
              retryOptions: this.retryOptions,
              statusStream: new WritableStream({
                write(status) {
                  self.updateStatus = status;
                },
              }),
              requestTimeout: this.requestTimeout,
            });
            session
              .getEvents()
              .pipeThrough(bufferUpdates({ maxDelay: this.updateBufferDelay }))
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
      // this should not happen as source should indefinitely retry connections
      console.error("SSE source failed:", e);
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
