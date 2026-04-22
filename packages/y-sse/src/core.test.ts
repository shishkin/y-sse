import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import * as Y from "yjs";
import { Session, SharedDoc } from "./core.ts";

describe("Yjs doc sync", () => {
  let serverDoc: Y.Doc;
  let serverId: number;
  let serverText: Y.Text;
  let sharedDoc: SharedDoc;
  let serverSession: Session;
  let clientDoc: Y.Doc;
  let clientText: Y.Text;
  let clientSession: Session;

  beforeEach(() => {
    serverDoc = new Y.Doc();
    serverId = serverDoc.clientID;
    serverText = serverDoc.getText("text");
    serverText.insert(0, "initial\n");
    sharedDoc = new SharedDoc("doc-1", serverDoc, { enableAwareness: false });
    clientDoc = new Y.Doc();
    clientText = clientDoc.getText("text");
    serverSession = sharedDoc.newSession();
    start();
  });

  async function start() {
    for await (const e of serverSession.getEvents()) {
      switch (e.event) {
        case "init":
          clientSession = new Session({
            id: e.payload.session,
            doc: clientDoc,
          });
          handleClientEvents();
          clientSession.push(e);
          break;
        default:
          clientSession.push(e);
          break;
      }
    }
  }

  async function handleClientEvents() {
    for await (const e of clientSession.getEvents()) {
      switch (e.event) {
        case "update":
          sharedDoc.apply(e, clientSession.id);
          break;
        case "awareness":
        case "init":
        case "ping":
          // ignore
          break;
      }
    }
  }

  // manual test
  it.skip("failing sync", async () => {
    assert.strictEqual(clientText.toString(), "initial\n");

    for (let i = 0; i < 10_000; i++) {
      const word = Array.from({ length: 3 }, () =>
        String.fromCharCode(97 + Math.random() * 26),
      ).join("");
      clientText.insert(clientText.length, word);
      await new Promise((resolve) => setTimeout(resolve, 1));
      assert.strictEqual(clientText.toString(), serverText.toString());
    }

    console.debug(serverText.toString());
    assert.strictEqual(clientText.toString(), serverText.toString());
  });
});
