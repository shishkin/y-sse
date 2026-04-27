import * as Y from "yjs";
import { SessionPool } from "./pool.ts";
import { parseRequest, responseFromEvents } from "./sse.ts";
import { throttle } from "./utils.ts";

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
  readonly docs: Map<string, SessionPool> = new Map();
  readonly persistence: Persistence<Ctx>;
  private readonly pathPrefix;
  private autoSave: Persistence<Ctx>["save"] | undefined;

  constructor(private readonly opts: ServerOptions<Ctx> = {}) {
    super();
    this.persistence = this.opts.persistence ?? {
      load: async () => {},
      save: async () => {},
    };
    this.pathPrefix = (this.opts.pathPrefix ?? "/sse")
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

  async handle(req: Request, ctx: Ctx): Promise<Response> {
    try {
      const res = await parseRequest(req, { pathPrefix: this.pathPrefix });
      if (res.method === "POST") {
        const doc = await this.loadDocument(res.docId, ctx);
        doc.apply(res.event, res.session);
        return new Response(null, {
          status: 204,
          statusText: "No Content",
        });
      } else if (res.method === "GET") {
        const doc = await this.loadDocument(res.docId, ctx);
        const s = doc.newSession();
        return responseFromEvents(s.getEvents({ signal: req.signal }));
      }
      console.warn("bad request:", req.method, req.url);
    } catch (err) {
      console.warn("bad request:", req.method, req.url, err);
    }
    return new Response(null, {
      status: 400,
      statusText: "Bad Request",
    });
  }

  private async loadDocument(id: string, ctx: Ctx): Promise<SessionPool> {
    const doc = this.docs.get(id);
    if (doc) {
      return doc;
    }

    const ydoc = new Y.Doc();
    if (this.opts.serverId) {
      ydoc.clientID = this.opts.serverId;
    }
    const pool = new SessionPool(id, ydoc, {
      enableAwareness: this.opts.enableAwareness,
      pingInterval: this.opts.pingInterval,
    });
    this.docs.set(id, pool);
    await this.persistence.load(id, pool.doc, ctx);
    pool.addEventListener("closed", () => this.unloadDocument(pool, ctx), { once: true });
    if (this.autoSave) {
      ydoc.on("update", () => this.autoSave?.(id, ydoc, ctx));
    }
    return pool;
  }

  private async unloadDocument(pool: SessionPool, ctx: Ctx): Promise<void> {
    await this.persistence.save(pool.id, pool.doc, ctx);
    this.docs.delete(pool.id);
  }
}
