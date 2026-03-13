# Y-SSE

> HTTP Server-Sent Events (SSE) Provider for Yjs

> [!WARNING]
> 🚧 This package is WIP and has experimental status.

## 🚀 Features

- [x] Yjs document sync over plain HTTP without WebSocket
- [x] Yjs Awareness Protocol
- [x] Works in Node.js-compatible environments with Web API Request and Response like Astro
- [x] Detects aborted client connections
- [x] Automatic document persistence hooks
- [ ] Client reconnection and offline support
- [ ] Automated simulation testing
- [ ] Optimize throughput with batching updates

## 📦 Installation

```bash
npm install y-sse
```

## 📖 Usage

On the server side with Astro:

```typescript
import type { APIRoute } from "astro";
import { SseServer } from "y-sse/server";

const server = new SseServer({
  pathPrefix: "/sse",
  persistence: {
    async load(id, ydoc) {
      console.info("loading document:", id);
      // do something with ydoc
    },
    async save(id, ydoc) {
      console.info("saving document:", id);
      // do something with ydoc
    },
  },
});

export const GET: APIRoute = (ctx) => {
  return server.handle(ctx.request);
};
export const POST = GET;
```

On the client side:

```typescript
import { SseProvider } from "y-sse";

const ydoc = new Y.Doc();
const provider = new SseProvider({
  doc: ydoc,
  pathPrefix: "/sse",
  docId: "doc-123",
  awareness: {
    name: "user123",
    color: "orange",
  },
});

// do something with ydoc and adapter.awareness
```

## 📝 License

MIT © [Sergey Shishkin](https://github.com/shishkin)
