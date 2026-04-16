import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import * as Y from "yjs";

describe("Yjs doc sync", () => {
  let serverDoc: Y.Doc;
  let serverId: number;
  let serverText: Y.Text;
  let clientDoc: Y.Doc;
  let clientText: Y.Text;

  beforeEach(() => {
    serverDoc = new Y.Doc();
    serverId = serverDoc.clientID;
    serverText = serverDoc.getText("text");
    serverText.insert(0, "initial\n");
    clientDoc = new Y.Doc();
    clientText = clientDoc.getText("text");
  });

  it("can handle subsequent snapshot", () => {
    const snapshot1 = Y.encodeStateAsUpdate(serverDoc);
    Y.applyUpdate(clientDoc, snapshot1);
    assert.strictEqual(clientText.toString(), "initial\n");

    serverDoc.once("update", (update) => {
      Y.applyUpdate(clientDoc, update);
    });
    serverText.insert(serverText.length, "line 2\n");
    assert.strictEqual(clientText.toString(), "initial\nline 2\n");

    clientText.insert(clientText.length, "client line\n");

    Y.applyUpdate(clientDoc, snapshot1);
    assert.strictEqual(clientText.toString(), "initial\nline 2\nclient line\n");
  });

  it("can handle server restart", () => {
    const snapshot1 = Y.encodeStateAsUpdate(serverDoc);
    Y.applyUpdate(clientDoc, snapshot1);
    assert.strictEqual(clientText.toString(), "initial\n");

    clientText.insert(clientText.length, "client line\n");

    serverDoc = new Y.Doc();
    // preserve server ID:
    serverDoc.clientID = serverId;
    serverText = serverDoc.getText("text");
    serverText.insert(0, "initial\n");
    const snapshot2 = Y.encodeStateAsUpdate(serverDoc);
    Y.applyUpdate(clientDoc, snapshot2);

    assert.strictEqual(clientText.toString(), "initial\nclient line\n");
  });
});
