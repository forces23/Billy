import type { EmailMessage } from "./email-provider.js";
import type { EmailClassification } from "./email-classifier.js";

export const emailProcessingStatuses = [
  "discovered",
  "drafting",
  "awaiting_approval",
  "approved",
  "sending",
  "sent",
  "failed",
  "rejected",
  "expired",
  "ignored",
] as const;

export type EmailProcessingStatus =
  (typeof emailProcessingStatuses)[number];

export type EmailFailureStage = "draft_generation" | "gmail_send";

export interface EmailFailure {
  stage: EmailFailureStage;
  code: string;
  technicalMessage: string;
  userMessage: string;
}

export interface StoredEmail {
  providerMessageId: string;
  threadId: string;
  messageIdHeader: string;
  subject: string;
  receivedAt: Date;
  status: EmailProcessingStatus;
  attemptCount: number;
  lastError: string | null;
  ignoredReason: string | null;
  sentProviderMessageId: string | null;
  sentAt: Date | null;
  failureStage: EmailFailureStage | null;
  failureCode: string | null;
  failureUserMessage: string | null;
  lastFailureAt: Date | null;
  manualRetryCount: number;
  classification: EmailClassification | null;
  classifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailRepository {
  register(message: EmailMessage): Promise<boolean>;

  findByProviderMessageId(
    providerMessageId: string,
  ): Promise<StoredEmail | null>;

  listByStatus(
    status: EmailProcessingStatus,
    limit: number,
  ): Promise<readonly StoredEmail[]>;

  claimForDrafting(providerMessageId: string): Promise<boolean>;

  saveClassification(
    providerMessageId: string,
    classification: EmailClassification,
  ): Promise<boolean>;

  findLatestClassificationByThreadId(
    threadId: string,
    excludingProviderMessageId: string,
  ): Promise<EmailClassification | null>;

  claimFailedGenerationRetry(providerMessageId: string): Promise<boolean>;

  releaseInterruptedDrafting(): Promise<number>;

  transitionStatus(
    providerMessageId: string,
    expectedStatus: EmailProcessingStatus,
    nextStatus: EmailProcessingStatus,
  ): Promise<boolean>;

  markFailed(
    providerMessageId: string,
    expectedStatus: EmailProcessingStatus,
    failure: EmailFailure,
  ): Promise<boolean>;

  markSent(
    providerMessageId: string,
    sentProviderMessageId: string,
  ): Promise<boolean>;

  markIgnored(
    providerMessageId: string,
    expectedStatus: EmailProcessingStatus,
    reason: string,
  ): Promise<boolean>;
}
