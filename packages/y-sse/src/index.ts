import {
  EventPayloadClientMap,
  UpdateStatusEvent,
  type EventPayloadMap,
  type UpdateStatus,
} from "./protocol.js";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";

declare global {
  interface EventSourceEventMap extends EventPayloadClientMap {}
}

export { UpdateStatusEvent } from "./protocol.js";
export type { UpdateStatus, UpdateStatusDetails } from "./protocol.js";

export interface ClientOptions {
  doc: Y.Doc;
  docId: string;
  pathPrefix?: string;
  awareness?: {
    name?: string;
    color?: string;
  };
}

export class SseProvider extends EventTarget {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly docPath: string;
  private stream: EventSource;
  private sessionPath: Promise<string>;
  private pendingUpdate: Uint8Array | undefined;
  private updateAttempt = 0;
  private _updateStatus: UpdateStatus = "idle";

  constructor(private readonly opts: ClientOptions) {
    super();
    this.opts.pathPrefix ??= "/sse";
    this.opts.awareness ??= {};
    this.doc = this.opts.doc;

    this.docPath = `${this.opts.pathPrefix}/${this.opts.docId}`;
    this.stream = new EventSource(this.docPath);
    this.sessionPath = new Promise((resolve) => {
      this.stream.addEventListener(
        "init",
        (e) => {
          const payload = JSON.parse(e.data) as EventPayloadMap["init"];
          resolve(`${this.docPath}/${payload.session}`);
        },
        { once: true },
      );
    });

    this.stream.addEventListener("update", (e) => {
      const update = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
      Y.applyUpdate(this.doc, update);
    });
    this.doc.on("update", async (update) => {
      this.pendingUpdate = this.pendingUpdate
        ? Y.mergeUpdates([this.pendingUpdate, update])
        : update;
      this.tryPostingPendingUpdate();
    });

    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalStateField("user", this.opts.awareness);
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
          const path = await this.sessionPath;
          const awarenessPath = `${path}?awareness`;
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

  private async tryPostingPendingUpdate() {
    if (this.updateAttempt) {
      // loop is already running
      return;
    }
    while (this.pendingUpdate) {
      try {
        if (this.updateStatus === "idle") {
          this.updateStatus = "pending";
        }
        this.updateAttempt++;
        const path = await this.sessionPath;
        await this.postUpdate(path, this.pendingUpdate);
        this.pendingUpdate = undefined;
        this.updateAttempt = 0;
        this.updateStatus = "idle";
      } catch (e) {
        this.updateStatus = "error";
        console.error(e);
        const delay = Math.min(500 * Math.pow(2, Math.max(this.updateAttempt - 1, 0)), 30_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private set updateStatus(s: UpdateStatus) {
    if (s !== this._updateStatus) {
      this._updateStatus = s;
      this.dispatchEvent(new UpdateStatusEvent({ status: s }));
    }
  }

  get updateStatus(): UpdateStatus {
    return this._updateStatus;
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
