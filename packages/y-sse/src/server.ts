import { EventEmitter } from "node:events";
import { setInterval } from "node:timers";
import { isTypedArray } from "node:util/types";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import type { EventPayloadMap, EventType } from "./protocol.js";

export class Session extends EventEmitter<{ abort: any }> {
  readonly id: string;
  private controller: ReadableStreamDefaultController<Uint8Array>;
  private aborted = false;
  private pingInterval;

  constructor({
    id,
    controller,
    pingInterval,
  }: {
    id: string;
    controller: ReadableStreamDefaultController<Uint8Array>;
    pingInterval?: number;
  }) {
    super();
    this.id = id;
    this.controller = controller;
    if (pingInterval) {
      this.pingInterval = setInterval(() => this.send("ping"), pingInterval);
      this.once("abort", () => {
        this.pingInterval?.close();
      });
    }
    this.send("init", { session: id });
  }

  private send<K extends EventType>(event: K, payload?: EventPayloadMap[K]) {
    if (this.aborted) {
      return;
    }

    const enc = new TextEncoder();
    try {
      const data = payload
        ? isTypedArray(payload)
          ? Buffer.from(payload).toString("base64")
          : JSON.stringify(payload)
        : "";
      this.controller.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`));
    } catch (_error) {
      this.aborted = true;
      this.emit("abort");
    }
  }

  update(update: Uint8Array): void {
    this.send("update", update);
  }

  updateAwareness(update: Uint8Array): void {
    this.send("awareness", update);
  }
}

export class SharedDoc extends EventEmitter<{ closed: any }> {
  readonly sessions: Map<string, Session> = new Map();
  readonly awareness: awarenessProtocol.Awareness;

  constructor(
    readonly id: string,
    readonly doc: Y.Doc,
  ) {
    super();
    doc.on("update", this.onUpdate.bind(this));
    this.once("closed", () => doc.off("update", this.onUpdate.bind(this)));
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = added.concat(updated).concat(removed);
        const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
        this.sessions.forEach((session) => session.updateAwareness(update));
      },
    );
  }

  addSession(session: Session): void {
    this.sessions.set(session.id, session);
    session.once("abort", () => {
      this.onDisconnect(session);
    });
    session.update(Y.encodeStateAsUpdate(this.doc));
    session.updateAwareness(
      awarenessProtocol.encodeAwarenessUpdate(
        this.awareness,
        Array.from(this.awareness.getStates().keys()),
      ),
    );
  }

  applyUpdate(update: Uint8Array, originSession: string): void {
    Y.applyUpdate(this.doc, update, originSession);
  }

  applyAwarenessUpdate(update: Uint8Array, originSession: string): void {
    awarenessProtocol.applyAwarenessUpdate(this.awareness, update, originSession);
  }

  private onDisconnect(session: Session) {
    this.sessions.delete(session.id);
    if (!this.sessions.size) {
      this.emit("closed");
    }
  }

  private onUpdate(update: Uint8Array) {
    this.sessions.forEach((session) => session.update(update));
  }
}

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
}

export class SseServer<Ctx = {}> extends EventEmitter {
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

  private matchUrl(url: string): { session?: string; id?: string; awareness?: boolean } {
    const pattern = new URLPattern({
      pathname: `${this.opts.pathPrefix}/:id/:session?`,
      search: "{:param}?",
    });
    const match = pattern.exec(url);
    return {
      id: match?.pathname.groups.id,
      session: match?.pathname.groups.session,
      awareness: match?.search.groups.param === "awareness",
    };
  }

  async handle(req: Request, ctx: Ctx): Promise<Response> {
    const { id, session, awareness } = this.matchUrl(req.url);

    if (!id) {
      return new Response(null, {
        status: 404,
        statusText: "Not Found",
      });
    } else if (req.method === "POST" && session && awareness) {
      const doc = await this.loadDocument(id, ctx);
      doc.applyAwarenessUpdate(await req.bytes(), session);
      return new Response(null, {
        status: 204,
        statusText: "No Content",
      });
    } else if (req.method === "POST" && session) {
      const doc = await this.loadDocument(id, ctx);
      doc.applyUpdate(await req.bytes(), session);
      return new Response(null, {
        status: 204,
        statusText: "No Content",
      });
    } else if (req.method === "GET" && session) {
      const doc = await this.loadDocument(id, ctx);
      const pingInterval = this.opts.pingInterval;
      const stream = new ReadableStream({
        async start(controller) {
          doc.addSession(new Session({ id: session, controller, pingInterval }));
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
      const session = Math.random().toString(36).substring(2);
      return new Response(null, {
        status: 302,
        statusText: "Found",
        headers: {
          Location: `${this.opts.pathPrefix}/${id}/${session}`,
        },
      });
    } else {
      return new Response(null, {
        status: 405,
        statusText: "Method Not Allowed",
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
    const newDoc = new SharedDoc(id, ydoc);
    this.docs.set(id, newDoc);
    await this.persistence.load(id, newDoc.doc, ctx);
    newDoc.once("closed", () => this.unloadDocument(newDoc, ctx));
    if (this.autoSave) {
      ydoc.on("update", () => this.autoSave?.(id, ydoc, ctx));
    }
    return newDoc;
  }

  private async unloadDocument(doc: SharedDoc, ctx: Ctx): Promise<void> {
    await this.persistence.save(doc.id, doc.doc, ctx);
    this.docs.delete(doc.id);
  }
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
