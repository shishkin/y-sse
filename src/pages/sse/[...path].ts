import type { APIRoute } from "astro";

export const GET: APIRoute = (ctx) => {
  return ctx.redirect("/");
};

export const HEAD = GET;
export const POST = GET;
export const PUT = GET;
