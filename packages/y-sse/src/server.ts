import * as Y from "yjs";
import type { SessionEvent } from "./events.ts";
import { SessionPool } from "./pool.ts";
import { responseFromEvents } from "./sse.ts";
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
      return responseFromEvents(s.getEvents({ signal: req.signal }));
    } else {
      console.warn("bad request:", req.method, req.url);
      return new Response(null, {
        status: 400,
        statusText: "Bad Request",
      });
    }
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
