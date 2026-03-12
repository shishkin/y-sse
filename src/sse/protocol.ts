export interface EventPayloadMap {
  ping: undefined;
  init: { session: string };
  update: Uint8Array<ArrayBufferLike>;
}

export type EventType = keyof EventPayloadMap;

export type EventPayloadClientMap = {
  [K in keyof EventPayloadMap]: undefined extends EventPayloadMap[K]
    ? MessageEvent<undefined>
    : MessageEvent<string>;
};
