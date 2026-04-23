import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import { Session, type SessionEvent } from "./core.ts";

export type UpdateStatus = "idle" | "pending" | "error";

export interface UpdateStatusDetails {
  status: UpdateStatus;
}

export class UpdateStatusEvent extends CustomEvent<UpdateStatusDetails> {
  static readonly type = "update-status" as const;

  constructor(detail: UpdateStatusDetails) {
    super(UpdateStatusEvent.type, { detail });
  }
}

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
            session.getEvents().pipeThrough(bufferUpdates()).pipeTo(sink);
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

type InitPayload = Extract<SessionEvent, { event: "init" }>["payload"];

export function sseSource({
  docId,
  pathPrefix,
}: {
  docId: string;
  pathPrefix: string;
}): ReadableStream<SessionEvent> {
  const docPath = `${pathPrefix}/${docId}`;
  const stream = new EventSource(docPath);
  const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return new ReadableStream({
    start(controller) {
      stream.addEventListener("init", (e) => {
        const payload = JSON.parse(e.data) as InitPayload;
        controller.enqueue({ event: "init", payload });
      });
      stream.addEventListener("update", (e) => {
        const payload = fromBase64(e.data);
        controller.enqueue({ event: "update", payload });
      });
      stream.addEventListener("awareness", (e) => {
        const payload = fromBase64(e.data);
        controller.enqueue({ event: "awareness", payload });
      });
      stream.onerror = (e) => {
        controller.error(e);
      };
    },
    cancel() {
      stream.close();
    },
  });
}

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
  return new TransformStream({
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
  });
}

export function sseSink({
  docId,
  sessionId,
  pathPrefix,
  statusStream,
  minRetryDelay = 500,
  maxRetryDelay = 30_000,
  maxRetries = 20,
  requestTimeout = 3_000,
}: {
  docId: string;
  sessionId: string;
  pathPrefix: string;
  statusStream?: WritableStream<UpdateStatus>;
  minRetryDelay?: number;
  maxRetryDelay?: number;
  maxRetries?: number;
  requestTimeout?: number;
}): WritableStream<SessionEvent> {
  const statusWriter = statusStream?.getWriter();
  statusWriter?.write("idle");
  return new WritableStream(
    {
      async write(e, controller) {
        let updateAttempt = 0;
        statusWriter?.write("pending");
        const params = new URLSearchParams({
          session: sessionId,
          event: e.event,
        });
        const path = `${pathPrefix}/${docId}?${params.toString()}`;
        const body =
          "payload" in e
            ? ArrayBuffer.isView(e.payload)
              ? (e.payload as BodyInit)
              : JSON.stringify(e.payload)
            : null;
        while (!controller.signal.aborted) {
          updateAttempt++;
          try {
            await fetch(path, {
              method: "POST",
              body,
              headers: {
                ...(body
                  ? ArrayBuffer.isView(body)
                    ? { "Content-Type": "application/octet-stream" }
                    : { "Content-Type": "application/json" }
                  : {}),
              },
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeout)]),
            });
            statusWriter?.write("idle");
            break;
          } catch (err) {
            statusWriter?.write("error");
            if (controller.signal.aborted) {
              break;
            }
            if (updateAttempt >= maxRetries) {
              controller.error(err);
              break;
            }
            const delay = Math.min(
              minRetryDelay * Math.pow(2, Math.max(updateAttempt - 1, 0)),
              maxRetryDelay,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      },
    },
    new CountQueuingStrategy({ highWaterMark: 1 }),
  );
}
