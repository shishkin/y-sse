import type { SessionEvent, UpdateStatus } from "./events.ts";
import { fromBase64, RetryOptions, retryWithBackoff } from "./utils.ts";

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
  retryOptions,
  statusStream,
}: {
  docId: string;
  pathPrefix: string;
  retryOptions?: RetryOptions;
  statusStream?: WritableStream<UpdateStatus>;
}): ReadableStream<SessionEvent> {
  const abort = new AbortController();
  const signal = retryOptions?.signal
    ? AbortSignal.any([retryOptions.signal, abort.signal])
    : abort.signal;
  const statusWriter = statusStream?.getWriter();
  let ctrl: ReadableStreamDefaultController<SessionEvent>;
  let source: EventSource | undefined;
  const connectSource = () =>
    new Promise<EventSource>((resolve, reject) => {
      let connected = false;
      const docPath = `${pathPrefix}/${docId}`;
      statusWriter?.write("pending");
      const es = new EventSource(docPath);
      es.addEventListener("init", (e) => {
        const payload = JSON.parse(e.data) as InitPayload;
        ctrl.enqueue({ event: "init", payload });
      });
      es.addEventListener("update", (e) => {
        const payload = fromBase64(e.data);
        ctrl.enqueue({ event: "update", payload });
      });
      es.addEventListener("awareness", (e) => {
        const payload = fromBase64(e.data);
        ctrl.enqueue({ event: "awareness", payload });
      });
      es.addEventListener("open", () => {
        connected = true;
        statusWriter?.write("idle");
        resolve(es);
      });
      es.addEventListener("error", async () => {
        statusWriter?.write("error");
        if (!connected) {
          // reject the promise is not yet resolved:
          reject(new Error("Failed to connect to the event source"));
        } else {
          // when an already established connection breaks, try to reconnect:
          await retryWithBackoff(
            async () => {
              source = await connectSource();
            },
            {
              ...retryOptions,
              signal,
            },
          );
        }
      });
    });
  return new ReadableStream({
    async start(controller) {
      ctrl = controller;
      await retryWithBackoff(
        async () => {
          source = await connectSource();
        },
        {
          ...retryOptions,
          signal,
        },
      );
    },
    cancel(reason) {
      abort.abort(reason);
      source?.close();
    },
  });
}

export function sseSink({
  docId,
  sessionId,
  pathPrefix,
  statusStream,
  requestTimeout,
  retryOptions,
}: {
  docId: string;
  sessionId: string;
  pathPrefix: string;
  statusStream?: WritableStream<UpdateStatus>;
  requestTimeout?: number;
  retryOptions?: RetryOptions;
}): WritableStream<SessionEvent> {
  const statusWriter = statusStream?.getWriter();
  statusWriter?.write("idle");
  return new WritableStream(
    {
      async write(e, controller) {
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
        try {
          await retryWithBackoff(
            async () => {
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
                signal: requestTimeout
                  ? AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeout)])
                  : controller.signal,
              });
            },
            {
              ...retryOptions,
              signal: controller.signal,
              onError: () => statusWriter?.write("error"),
            },
          );
          statusWriter?.write("idle");
        } catch (err) {
          statusWriter?.write("error");
          controller.error(err);
        }
      },
    },
    new CountQueuingStrategy({ highWaterMark: 1 }),
  );
}
