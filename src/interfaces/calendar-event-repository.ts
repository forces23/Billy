import type { CalendarEventWrite } from "./calendar-provider.js";

export type CalendarEventRecordStatus =
  | "proposed"
  | "conflicted"
  | "creating"
  | "created"
  | "update_proposed"
  | "updating"
  | "cancel_proposed"
  | "cancelling"
  | "cancelled"
  | "failed";

export interface CalendarEventRecord {
  sessionId: number;
  status: CalendarEventRecordStatus;
  event: CalendarEventWrite;
  googleEventId: string | null;
  googleEventLink: string | null;
  discordMessageId: string | null;
  overrideConflict: boolean;
  lastError: string | null;
}

export interface CalendarEventRepository {
  propose(sessionId: number, event: CalendarEventWrite): Promise<CalendarEventRecord>;
  proposeReschedule(
    gmailThreadId: string,
    sessionId: number,
    event: CalendarEventWrite,
  ): Promise<CalendarEventRecord | null>;
  findBySessionId(sessionId: number): Promise<CalendarEventRecord | null>;
  listUnpublished(limit: number): Promise<readonly CalendarEventRecord[]>;
  savePublication(sessionId: number, messageId: string): Promise<boolean>;
  updateProposal(sessionId: number, event: CalendarEventWrite, conflicted: boolean): Promise<boolean>;
  proposeDelete(sessionId: number): Promise<boolean>;
  claimCreate(sessionId: number, interactionId: string, overrideConflict: boolean): Promise<boolean>;
  markCreated(sessionId: number, providerEventId: string, htmlLink: string | null): Promise<boolean>;
  claimUpdate(sessionId: number, interactionId: string): Promise<boolean>;
  markUpdated(sessionId: number, htmlLink: string | null): Promise<boolean>;
  claimDelete(sessionId: number, interactionId: string): Promise<boolean>;
  markCancelled(sessionId: number): Promise<boolean>;
  markFailed(sessionId: number, error: string): Promise<boolean>;
}
