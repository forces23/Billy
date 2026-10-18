import type { SchedulingRequest } from "./scheduling-interpreter.js";
import type { TrustedSchedulingContext } from "./ai-provider.js";

export interface SchedulingSlot {
  start: string;
  end: string;
  label: string;
}

export interface SchedulingAdvisory {
  date: string;
  titles: readonly string[];
}

export interface SchedulingAnalysis {
  requestedSlot: SchedulingSlot | null;
  requestedSlotAvailable: boolean;
  timezoneRequired: boolean;
  options: readonly SchedulingSlot[];
  advisories: readonly SchedulingAdvisory[];
  checkedAt: string;
}

export type SchedulingSessionStatus =
  | "awaiting_selection"
  | "drafting"
  | "drafted"
  | "resolved"
  | "failed";

export interface SchedulingSession {
  id: number;
  providerMessageId: string;
  gmailThreadId: string | null;
  replyProviderMessageId: string;
  status: SchedulingSessionStatus;
  request: SchedulingRequest;
  analysis: SchedulingAnalysis;
  selectedSlot: SchedulingSlot | null;
  offeredSlots: readonly SchedulingSlot[];
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SchedulingAvailabilityCard {
  id: number;
  sessionId: number;
  version: number;
  request: SchedulingRequest;
  analysis: SchedulingAnalysis;
  source: "email" | "reviewer" | "counterproposal" | "refresh";
  discordMessageId: string | null;
  disabledAt: Date | null;
  createdAt: Date;
}

export interface SchedulingRepository {
  createAndAwaitSelection(
    providerMessageId: string,
    request: SchedulingRequest,
    analysis: SchedulingAnalysis,
  ): Promise<SchedulingSession | null>;
  findById(id: number): Promise<SchedulingSession | null>;
  findByProviderMessageId(
    providerMessageId: string,
  ): Promise<SchedulingSession | null>;
  findByGmailThreadId(gmailThreadId: string): Promise<SchedulingSession | null>;
  listAcceptedRecruiterProposalsWithoutCalendarEvent(
    limit: number,
  ): Promise<readonly SchedulingSession[]>;
  updateAnalysis(
    sessionId: number,
    request: SchedulingRequest,
    analysis: SchedulingAnalysis,
  ): Promise<boolean>;
  listUnpublishedCards(limit: number): Promise<readonly SchedulingAvailabilityCard[]>;
  findCardById(cardId: number): Promise<SchedulingAvailabilityCard | null>;
  findLatestCard(sessionId: number): Promise<SchedulingAvailabilityCard | null>;
  saveCardPublication(cardId: number, discordMessageId: string): Promise<boolean>;
  claimSelection(
    sessionId: number,
    interactionId: string,
    slot: SchedulingSlot | null,
    offeredSlots?: readonly SchedulingSlot[],
  ): Promise<boolean>;
  selectOfferedSlot(
    sessionId: number,
    slot: SchedulingSlot,
  ): Promise<boolean>;
  releaseSelection(
    sessionId: number,
    analysis: SchedulingAnalysis,
    error?: string,
  ): Promise<boolean>;
  markDrafted(sessionId: number, draftId: number): Promise<boolean>;
  linkDraft(sessionId: number, draftId: number): Promise<boolean>;
  findSessionByDraftId(draftId: number): Promise<SchedulingSession | null>;
  markReplySent(draftId: number): Promise<SchedulingSession | null>;
  markRecruiterConfirmed(sessionId: number, providerMessageId: string): Promise<boolean>;
  markConfirmationNeedsReview(sessionId: number, providerMessageId: string): Promise<boolean>;
  markCancelled(sessionId: number, providerMessageId: string): Promise<boolean>;
  reopenAfterConflict(
    sessionId: number,
    analysis: SchedulingAnalysis,
  ): Promise<boolean>;
  appendTurn(
    sessionId: number,
    discordMessageId: string,
    userId: string,
    role: "user" | "assistant",
    body: string,
  ): Promise<boolean>;
}

export interface SchedulingGuard {
  validateDraft(draftId: number, signal?: AbortSignal): Promise<boolean>;
  getDraftContext(draftId: number): Promise<TrustedSchedulingContext | undefined>;
  linkRevision(sourceDraftId: number, resultDraftId: number): Promise<boolean>;
  onDraftSent(draftId: number): Promise<void>;
}
