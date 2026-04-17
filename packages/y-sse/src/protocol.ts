export interface EventPayloadMap {
  ping: undefined;
  init: { session: string };
  update: Uint8Array;
  awareness: Uint8Array;
}

export type EventType = keyof EventPayloadMap;

export type EventPayloadClientMap = {
  [K in keyof EventPayloadMap]: undefined extends EventPayloadMap[K]
    ? MessageEvent<undefined>
    : MessageEvent<string>;
};

export type UpdateStatus = "idle" | "pending" | "error";

export interface UpdateStatusDetails {
  status: UpdateStatus;
}

export class UpdateStatusEvent extends CustomEvent<UpdateStatusDetails> {
  static readonly type = "update-status" as const;

  constructor(detail: UpdateStatusDetails) {
    super(UpdateStatusEvent.type, { detail });
  }
}
