import type { SessionEvent, UpdateStatus } from "./events.ts";
import { fromBase64 } from "./utils.ts";

export function responseFromEvents(events: ReadableStream<SessionEvent>): Response {
  const abort = new AbortController();
  const encode = (e: SessionEvent) => {
    const data =
      "payload" in e
        ? ArrayBuffer.isView(e.payload)
          ? // TODO: replace with isomorphic:
            Buffer.from(e.payload).toString("base64")
          : JSON.stringify(e.payload)
        : "";
    const encoder = new TextEncoder();
    return encoder.encode(`event: ${e.event}\ndata: ${data}\n\n`);
  };
  return new Response(
    new ReadableStream({
      async start(controller) {
        for await (const e of events) {
          if (abort.signal.aborted) {
            break;
          }
          const encoded = encode(e);
          controller.enqueue(encoded);
        }
        controller.close();
      },
      cancel() {
        abort.abort();
      },
    }),
    {
      headers: {
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    },
  );
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
