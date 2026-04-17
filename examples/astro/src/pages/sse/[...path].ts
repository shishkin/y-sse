import type { APIRoute, APIContext } from "astro";
import { SseServer } from "y-sse/server";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as Y from "yjs";

const server = new SseServer<APIContext>({
  // stable client ID ensures client can reconnect to a respawned server
  serverId: 0,
  pathPrefix: "/sse",
  persistence: {
    async load(id, doc) {
      console.info("loading document:", id);
      const path = `data/${id}`;
      if (existsSync(path)) {
        const data = await readFile(path);
        Y.applyUpdate(doc, data);
      }
    },
    async save(id, doc) {
      console.info("saving document:", id);
      await writeFile(`data/${id}`, Y.encodeStateAsUpdate(doc));
    },
  },
  autoSaveInterval: 1000,
});

export const GET: APIRoute = (ctx) => {
  return server.handle(ctx.request, ctx);
};

export const HEAD = GET;
export const POST = GET;
