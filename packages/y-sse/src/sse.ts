import type { SourceEvent, ClientEvent, UpdateStatus } from "./events.ts";
import { fromBase64, toBase64, RetryOptions, retryWithBackoff } from "./utils.ts";

export function responseFromEvents(events: ReadableStream<SourceEvent>): Response {
  const abort = new AbortController();
  const encode = (e: SourceEvent) => {
    const data = "payload" in e ? toBase64(e.payload) : e.event === "init" ? e.session : "";
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
}): ReadableStream<SourceEvent> {
  const abort = new AbortController();
  const signal = retryOptions?.signal
    ? AbortSignal.any([retryOptions.signal, abort.signal])
    : abort.signal;
  const statusWriter = statusStream?.getWriter();
  let ctrl: ReadableStreamDefaultController<SourceEvent>;
  let source: EventSource | undefined;
  const connectSource = () =>
    new Promise<EventSource>((resolve, reject) => {
      let connected = false;
      const docPath = `${pathPrefix}/${docId}`;
      statusWriter?.write("pending");
      const es = new EventSource(docPath);
      es.addEventListener("init", (e) => {
        ctrl.enqueue({ event: "init", session: e.data as string });
      });
      es.addEventListener("snapshot", (e) => {
        const payload = fromBase64(e.data);
        ctrl.enqueue({ event: "snapshot", payload });
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
}): WritableStream<ClientEvent> {
  const statusWriter = statusStream?.getWriter();
  statusWriter?.write("idle");
  return new WritableStream<ClientEvent>(
    {
      async write(e, controller) {
        statusWriter?.write("pending");
        const data = new FormData();
        data.set("session", sessionId);
        data.set("event", e.event);
        if (e.event === "snapshot") {
          data.append(
            "snapshot",
            new Blob([e.snapshot as BufferSource], { type: "application/octet-stream" }),
          );
        } else if (e.event === "update") {
          if (e.update) {
            data.append(
              "update",
              new Blob([e.update as BufferSource], { type: "application/octet-stream" }),
            );
          }
          if (e.awareness) {
            data.append(
              "awareness",
              new Blob([e.awareness as BufferSource], { type: "application/octet-stream" }),
            );
          }
        }
        const path = `${pathPrefix}/${docId}`;
        try {
          await retryWithBackoff(
            async () => {
              await fetch(path, {
                method: "POST",
                body: data,
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

export type SseRequest =
  | { method: "GET"; docId: string }
  | { method: "POST"; docId: string; session: string; event: ClientEvent };

export async function parseRequest(
  req: Request,
  { pathPrefix }: { pathPrefix: string },
): Promise<SseRequest> {
  const pattern = new URLPattern({
    pathname: `${pathPrefix}/:id?`,
  });
  const match = pattern.exec(req.url);
  const docId = match?.pathname.groups.id;
  if (!docId) {
    throw new Error("Request path must contain document ID");
  }

  if (req.method === "GET") {
    return { method: "GET", docId };
  } else if (req.method === "POST") {
    const data = await req.formData();
    const event = data.get("event")?.toString();
    if (!event) {
      throw new Error("Request data must contain event field");
    }

    const session = data.get("session")?.toString();
    if (!session) {
      throw new Error("Request data must contain session field");
    }

    if (event === "update") {
      return {
        method: "POST",
        docId,
        session,
        event: {
          event,
          update: data.has("update") ? await readBytesFromBlob(data, "update") : undefined,
          awareness: data.has("awareness") ? await readBytesFromBlob(data, "awareness") : undefined,
        },
      };
    } else if (event === "snapshot") {
      return {
        method: "POST",
        docId,
        session,
        event: {
          event,
          snapshot: await readBytesFromBlob(data, "snapshot"),
        },
      };
    } else {
      throw new Error("Invalid event type");
    }
  } else {
    throw new Error("Method not supported");
  }
}

async function readBytesFromBlob(form: FormData, name: string): Promise<Uint8Array> {
  const value = form.get(name);
  if (!value || !(value instanceof Blob)) {
    throw new Error(`Form value ${name} is not a Blob`);
  }
  return await value.bytes();
}
