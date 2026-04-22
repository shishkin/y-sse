import { SessionEvent, SharedDoc } from "./core.js";
import * as Y from "yjs";

export interface Persistence<Ctx> {
  load(id: string, doc: Y.Doc, ctx: Ctx): Promise<void>;
  save(id: string, doc: Y.Doc, ctx: Ctx): Promise<void>;
}

export interface ServerOptions<Ctx> {
  pathPrefix?: string;
  persistence?: Persistence<Ctx>;
  serverId?: number;
  pingInterval?: number;
  autoSaveInterval?: number;
  enableAwareness?: boolean;
}

export class SseServer<Ctx = {}> extends EventTarget {
  readonly docs: Map<string, SharedDoc> = new Map();
  readonly persistence: Persistence<Ctx>;
  private autoSave: Persistence<Ctx>["save"] | undefined;

  constructor(private readonly opts: ServerOptions<Ctx> = {}) {
    super();
    this.persistence = this.opts.persistence ?? {
      load: async () => {},
      save: async () => {},
    };
    this.opts.pathPrefix = (this.opts.pathPrefix ?? "/sse")
      .trim()
      .replaceAll(/[\/]{2,}/g, "/")
      .replace(/\/$/, "");
    if (this.opts.autoSaveInterval) {
      this.autoSave = throttle(
        this.persistence.save.bind(this.persistence),
        this.opts.autoSaveInterval,
      );
    }
  }

  private matchUrl(url: string): {
    id?: string;
    session?: string;
    event?: SessionEvent["event"];
  } {
    const pattern = new URLPattern({
      pathname: `${this.opts.pathPrefix}/:id?`,
      search: "{:search}?",
    });
    const match = pattern.exec(url);
    const search = new URLSearchParams(match?.search.groups.search);
    return {
      id: match?.pathname.groups.id,
      session: search.get("session") ?? undefined,
      event: (search.get("event") as any) ?? undefined,
    };
  }

  async handle(req: Request, ctx: Ctx): Promise<Response> {
    const { id, session, event } = this.matchUrl(req.url);

    if (req.method === "POST" && id && session && event) {
      const doc = await this.loadDocument(id, ctx);
      const payload =
        event === "update" || event === "awareness"
          ? await req.bytes()
          : event === "init"
            ? await req.json()
            : undefined;
      doc.apply({ event, payload }, session);
      return new Response(null, {
        status: 204,
        statusText: "No Content",
      });
    } else if (req.method === "GET" && id && !session && !event) {
      const doc = await this.loadDocument(id, ctx);
      const s = doc.newSession();
      return eventsResponse(s.getEvents({ signal: req.signal }));
    } else {
      console.warn("bad request:", req.method, req.url);
      return new Response(null, {
        status: 400,
        statusText: "Bad Request",
      });
    }
  }

  private async loadDocument(id: string, ctx: Ctx): Promise<SharedDoc> {
    const doc = this.docs.get(id);
    if (doc) {
      return doc;
    }

    const ydoc = new Y.Doc();
    if (this.opts.serverId) {
      ydoc.clientID = this.opts.serverId;
    }
    const newDoc = new SharedDoc(id, ydoc, {
      enableAwareness: this.opts.enableAwareness,
      pingInterval: this.opts.pingInterval,
    });
    this.docs.set(id, newDoc);
    await this.persistence.load(id, newDoc.doc, ctx);
    newDoc.addEventListener("closed", () => this.unloadDocument(newDoc, ctx), { once: true });
    if (this.autoSave) {
      ydoc.on("update", () => this.autoSave?.(id, ydoc, ctx));
    }
    return newDoc;
  }

  private async unloadDocument(doc: SharedDoc, ctx: Ctx): Promise<void> {
    console.debug("unloading document:", doc.id);
    await this.persistence.save(doc.id, doc.doc, ctx);
    this.docs.delete(doc.id);
  }
}

function eventsResponse(events: ReadableStream<SessionEvent>): Response {
  const abort = new AbortController();
  const encode = (e: SessionEvent) => {
    const data =
      "payload" in e
        ? ArrayBuffer.isView(e.payload)
          ? Buffer.from(e.payload).toString("base64")
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

function throttle<F extends (...args: any[]) => void>(fn: F, wait: number): F {
  let timeout: any | undefined;
  let lastArgs: any[] | undefined;

  const exec = function (this: any) {
    if (lastArgs) {
      fn.apply(this, lastArgs);
      lastArgs = undefined;
      timeout = setTimeout(exec, wait);
    } else {
      timeout = undefined;
    }
  };

  return function (this: any, ...args: any[]) {
    lastArgs = args;
    if (!timeout) {
      exec();
    }
  } as F;
}
