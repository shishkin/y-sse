import type { EventPayloadClientMap, EventPayloadMap } from "./protocol.ts";
import * as Y from "yjs";

declare global {
  interface EventSourceEventMap extends EventPayloadClientMap {}
}

export interface ClientOptions {
  doc: Y.Doc;
  docId: string;
  pathPrefix?: string;
}

export class ClientAdapter {
  readonly doc: Y.Doc;
  readonly docId: string;
  readonly pathPrefix: string;
  private stream: EventSource;
  private session: Promise<EventPayloadMap["init"]>;

  constructor({ doc, docId, pathPrefix = "/sse" }: ClientOptions) {
    this.doc = doc;
    this.docId = docId;
    this.pathPrefix = pathPrefix;
    const docPath = `${this.pathPrefix}/${this.docId}`;
    this.stream = new EventSource(docPath);
    this.session = new Promise((resolve) => {
      this.stream.addEventListener(
        "init",
        (e) => {
          resolve(JSON.parse(e.data));
        },
        { once: true },
      );
    });
    this.stream.addEventListener("update", (e) => {
      const update = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
      Y.applyUpdate(this.doc, update);
    });
    this.doc.on("update", async (update) => {
      const { session } = await this.session;
      const sessionPath = `${docPath}/${session}`;
      await fetch(sessionPath, {
        method: "POST",
        body: update as BodyInit,
        headers: {
          "Content-Type": "application/octet-stream",
        },
      });
    });
  }
}
