import type { EventPayloadClientMap, EventPayloadMap } from "./protocol.js";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";

declare global {
  interface EventSourceEventMap extends EventPayloadClientMap {}
}

export interface ClientOptions {
  doc: Y.Doc;
  docId: string;
  pathPrefix?: string;
  awareness?: {
    name?: string;
    color?: string;
  };
}

export class SseProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly docId: string;
  readonly pathPrefix: string;
  private stream: EventSource;
  private session: Promise<EventPayloadMap["init"]>;

  constructor({ doc, docId, pathPrefix = "/sse", awareness = {} }: ClientOptions) {
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
      try {
        const { session } = await this.session;
        const sessionPath = `${docPath}/${session}`;
        await this.postUpdate(sessionPath, update);
      } catch (e) {
        // TODO: implement pending updates queue
        console.error(e);
      }
    });

    this.awareness = new awarenessProtocol.Awareness(doc);
    this.awareness.setLocalStateField("user", awareness);
    this.stream.addEventListener("awareness", (e) => {
      const update = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, "server update");
    });
    this.awareness.on(
      "update",
      async ({
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => {
        try {
          const { session } = await this.session;
          const awarenessPath = `${docPath}/${session}?awareness`;
          const changed = added.concat(updated).concat(removed);
          const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
          await this.postUpdate(awarenessPath, update);
        } catch (_e) {
          // ignore failed awareness updates
        }
      },
    );
    window.addEventListener("beforeunload", () => {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "window unload");
    });
  }

  private async postUpdate(path: string, update: Uint8Array) {
    await fetch(path, {
      method: "POST",
      body: update as BodyInit,
      headers: {
        "Content-Type": "application/octet-stream",
      },
    });
  }
}
