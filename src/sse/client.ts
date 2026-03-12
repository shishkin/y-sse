declare global {
  interface EventSourceEventMap {
    ping: MessageEvent<undefined>;
    update: MessageEvent<string>;
  }
}

export interface ClientOptions {
  docId: string;
  pathPrefix?: string;
}

export class ClientAdapter {
  readonly docId: string;
  readonly pathPrefix: string;

  constructor({ docId, pathPrefix = "/sse" }: ClientOptions) {
    this.docId = docId;
    this.pathPrefix = pathPrefix;
  }

  async run() {
    const docPath = `${this.pathPrefix}/${this.docId}`;
    const source = new EventSource(docPath);
    source.onmessage = (e) => console.log("Message:", e);
    source.addEventListener("update", (e) => console.log("Update:", e.data));
    source.addEventListener("ping", (_e) => console.log("ping"));
  }
}
