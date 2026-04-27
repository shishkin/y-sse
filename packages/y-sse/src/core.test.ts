import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import * as Y from "yjs";
import { Session } from "./session.ts";
import { SessionPool } from "./pool.ts";
import { bufferUpdates } from "./buffer.ts";

describe("Yjs doc sync", () => {
  let serverDoc: Y.Doc;
  let serverText: Y.Text;
  let sharedDoc: SessionPool;
  let serverSession: Session;
  let clientDoc: Y.Doc;
  let clientText: Y.Text;
  let clientSession: Session;

  beforeEach(() => {
    serverDoc = new Y.Doc();
    serverText = serverDoc.getText("text");
    serverText.insert(0, "initial\n");
    sharedDoc = new SessionPool("doc-1", serverDoc, { enableAwareness: false });
    clientDoc = new Y.Doc();
    clientText = clientDoc.getText("text");
    serverSession = sharedDoc.newSession();
    start();
  });

  async function start() {
    for await (const e of serverSession.getEvents()) {
      if (e.event === "init") {
        clientSession = new Session({
          id: e.session,
          doc: clientDoc,
        });
        handleClientEvents();
      }
      clientSession.apply(e);
    }
  }

  async function handleClientEvents() {
    for await (const e of clientSession.getClientEvents({ delay: 1 })) {
      sharedDoc.apply(e, clientSession.id);
    }
  }

  // manual test
  it.skip("sync load test", async () => {
    assert.strictEqual(clientText.toString(), "initial\n");

    for (let i = 0; i < 10_000; i++) {
      const word = Array.from({ length: 3 }, () =>
        String.fromCharCode(97 + Math.random() * 26),
      ).join("");
      clientText.insert(clientText.length, word);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    clientSession.close();
    assert.strictEqual(clientText.toString(), serverText.toString());
  });
});
