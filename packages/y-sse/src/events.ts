export type SourceEvent =
  | { event: "init"; session: string }
  | { event: "ping" }
  | { event: "snapshot"; payload: Uint8Array }
  | { event: "update"; payload: Uint8Array }
  | { event: "awareness"; payload: Uint8Array };

export type ClientEvent =
  | { event: "snapshot"; snapshot: Uint8Array }
  | { event: "update"; update: Uint8Array | undefined; awareness: Uint8Array | undefined };

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
