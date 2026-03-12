import type { APIRoute } from "astro";
import { Server } from "../../sse/server.ts";

const server = new Server({
  pathPrefix: "/sse",
  persistence: {
    async load(id) {
      console.info("loading document:", id);
    },
    async save(id) {
      console.info("saving document:", id);
    },
  },
});

export const GET: APIRoute = (ctx) => {
  return server.handle(ctx.request);
};

export const HEAD = GET;
export const POST = GET;
