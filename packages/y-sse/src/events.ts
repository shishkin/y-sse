export type SessionEvent =
  | { event: "init"; payload: { session: string } }
  | { event: "ping" }
  | { event: "update"; payload: Uint8Array }
  | { event: "awareness"; payload: Uint8Array };

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
