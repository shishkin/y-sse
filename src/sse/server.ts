import { EventEmitter } from "node:events";
import { setInterval } from "node:timers";
import * as Y from "yjs";

export class Session extends EventEmitter<{ abort: any }> {
  readonly id: string;
  private controller: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>;
  private aborted = false;
  private pingInterval;

  constructor({
    id,
    controller,
  }: {
    id: string;
    controller: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>;
  }) {
    super();
    this.id = id;
    this.controller = controller;
    this.pingInterval = setInterval(() => this.send("ping"), 1000);
    this.once("abort", () => {
      this.pingInterval.close();
    });
  }

  private send(event: "update" | "ping", payload?: Uint8Array<ArrayBufferLike>) {
    if (this.aborted) {
      return;
    }

    const enc = new TextEncoder();
    try {
      const data = payload ? Buffer.from(payload).toString("base64") : "";
      this.controller.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`));
    } catch (_error) {
      this.aborted = true;
      console.error("stream aborted");
      this.emit("abort");
    }
  }

  update(update: Uint8Array<ArrayBufferLike>) {
    this.send("update", update);
  }
}

export class SharedDoc extends EventEmitter<{ closed: any }> {
  readonly sessions = new Map<string, Session>();

  constructor(readonly doc: Y.Doc) {
    super();
    doc.on("update", this.onUpdate.bind(this));
    this.once("closed", () => doc.off("update", this.onUpdate.bind(this)));
  }

  get id() {
    return this.doc.guid;
  }

  addSession(session: Session) {
    this.sessions.set(session.id, session);
    session.once("abort", () => {
      this.onDisconnect(session);
    });
  }

  private onDisconnect(session: Session) {
    this.sessions.delete(session.id);
    if (!this.sessions.size) {
      this.emit("closed");
    }
  }

  private onUpdate(update: Uint8Array<ArrayBufferLike>) {
    this.sessions.forEach((session) => session.update(update));
  }
}

export interface Persistence {
  load(id: string, doc: Y.Doc): Promise<void>;
  save(id: string, doc: Y.Doc): Promise<void>;
}

export interface ServerOptions {
  pathPrefix?: string;
  persistence?: Persistence;
}

export class Server extends EventEmitter {
  pathPrefix: string;
  persistence: Persistence;
  docs = new Map<string, SharedDoc>();

  constructor({
    pathPrefix = "/sse",
    persistence = {
      load: async () => {},
      save: async () => {},
    },
  }: ServerOptions = {}) {
    super();
    this.pathPrefix = pathPrefix
      .trim()
      .replaceAll(/[\/]{2,}/g, "/")
      .replace(/\/$/, "");
    this.persistence = persistence;
  }

  private matchUrl(url: string): { session?: string; id?: string } {
    const pattern = new URLPattern({ pathname: `${this.pathPrefix}/:id/:session?` });
    const match = pattern.exec(url);
    return {
      id: match?.pathname.groups.id,
      session: match?.pathname.groups.session,
    };
  }

  async handle(req: Request): Promise<Response> {
    const { id, session } = this.matchUrl(req.url);

    if (!id) {
      return new Response(null, {
        status: 404,
        statusText: "Not Found",
      });
    } else if (req.method === "POST" && session) {
      console.info("POST document update:", id, session);
      const doc = await this.loadDocument(id);
      Y.applyUpdate(doc.doc, await req.bytes(), session);
      return new Response(null, {
        status: 204,
        statusText: "No Content",
      });
    } else if (req.method === "GET" && session) {
      console.info("GET document session stream:", id, session);
      const doc = await this.loadDocument(id);
      const stream = new ReadableStream({
        async start(controller) {
          doc.addSession(new Session({ id: session, controller }));
        },
      });
      return new Response(stream, {
        headers: {
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    } else if (req.method === "GET") {
      console.info("GET document session:", id);
      const session = Math.random().toString(36).substring(2);
      return new Response(null, {
        status: 302,
        statusText: "Found",
        headers: {
          Location: `${this.pathPrefix}/${id}/${session}`,
        },
      });
    } else {
      console.error("Unsupported request:", req.method, new URL(req.url).pathname);
      return new Response(null, {
        status: 405,
        statusText: "Method Not Allowed",
      });
    }
  }

  async loadDocument(id: string): Promise<SharedDoc> {
    const doc = this.docs.get(id);
    if (doc) {
      return doc;
    }

    const newDoc = new SharedDoc(new Y.Doc({ guid: id }));
    this.docs.set(id, newDoc);
    await this.persistence.load(id, newDoc.doc);
    newDoc.once("closed", () => this.unloadDocument(newDoc));
    return newDoc;
  }

  async unloadDocument(doc: SharedDoc): Promise<void> {
    await this.persistence.save(doc.id, doc.doc);
    this.docs.delete(doc.id);
  }
}
