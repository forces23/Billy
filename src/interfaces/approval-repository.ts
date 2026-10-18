import type { EmailAddress, RecipientSet } from "../core/recipient-resolver.js";

export type ReplyMode = "reply" | "reply_all";
export type ReviewDecision =
  | "approved_reply"
  | "approved_reply_all"
  | "do_not_reply";

export interface DraftPublication {
  draftId: number;
  channelId: string;
  messageId: string;
  postedAt: Date;
}

export interface GenerationFailureNotice {
  providerMessageId: string;
  subject: string;
  userMessage: string;
  failureCode: string;
  automaticAttemptRuns: number;
  manualRetryCount: number;
  failedAt: Date;
  publication: GenerationFailurePublication | null;
}

export interface GenerationFailurePublication {
  providerMessageId: string;
  channelId: string;
  messageId: string;
  renderedFailureAt: Date;
  resolvedAt: Date | null;
}

export interface ResolvedGenerationFailurePublication {
  publication: GenerationFailurePublication;
  subject: string;
  emailStatus: string;
}

export type DeliveryDisplayStatus = "queued" | "sending" | "sent" | "failed";

export interface DeliveryStatusUpdate {
  draftId: number;
  providerMessageId: string;
  channelId: string;
  messageId: string;
  revision: number;
  subject: string;
  decision: ReviewDecision;
  displayStatus: DeliveryDisplayStatus;
  sentAt: Date | null;
  failureUserMessage: string | null;
}

export interface StoredReviewDecision {
  providerMessageId: string;
  draftId: number;
  decision: ReviewDecision;
  reviewerUserId: string;
  recipients: RecipientSet;
  decidedAt: Date;
}

export interface RevisionRequest {
  id: number;
  interactionId: string;
  sourceDraftId: number;
  resultDraftId: number | null;
  reviewerUserId: string;
  instructions: string;
  status: "pending" | "completed" | "failed";
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalRepository {
  listUnpublishedAwaitingDraftIds(limit: number): Promise<readonly number[]>;
  savePublication(
    draftId: number,
    channelId: string,
    messageId: string,
  ): Promise<boolean>;
  findPublication(draftId: number): Promise<DraftPublication | null>;
  listPublishedAwaitingDrafts(
    limit: number,
  ): Promise<readonly DraftPublication[]>;
  listPublicationsByProviderMessageId(
    providerMessageId: string,
  ): Promise<readonly DraftPublication[]>;
  listGenerationFailuresNeedingPublication(
    limit: number,
  ): Promise<readonly GenerationFailureNotice[]>;
  saveGenerationFailurePublication(
    providerMessageId: string,
    channelId: string,
    messageId: string,
    renderedFailureAt: Date,
  ): Promise<void>;
  listResolvedGenerationFailurePublications(
    limit: number,
  ): Promise<readonly ResolvedGenerationFailurePublication[]>;
  markGenerationFailurePublicationResolved(
    providerMessageId: string,
  ): Promise<boolean>;
  listDeliveryStatusUpdates(
    limit: number,
  ): Promise<readonly DeliveryStatusUpdate[]>;
  markDeliveryStatusRendered(
    draftId: number,
    status: DeliveryDisplayStatus,
  ): Promise<boolean>;
  approve(
    draftId: number,
    mode: ReplyMode,
    recipients: RecipientSet,
    reviewerUserId: string,
  ): Promise<StoredReviewDecision | null>;
  doNotReply(
    draftId: number,
    reviewerUserId: string,
  ): Promise<StoredReviewDecision | null>;
  findDecision(
    providerMessageId: string,
  ): Promise<StoredReviewDecision | null>;
  createRevisionRequest(
    interactionId: string,
    sourceDraftId: number,
    reviewerUserId: string,
    instructions: string,
  ): Promise<RevisionRequest | null>;
  completeRevisionRequest(
    requestId: number,
    resultDraftId: number,
  ): Promise<boolean>;
  failRevisionRequest(requestId: number, error: string): Promise<boolean>;
}

export function formatEmailAddress(address: EmailAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}
