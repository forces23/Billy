import type Database from "better-sqlite3";

import type { EmailMessage } from "../../interfaces/email-provider.js";
import type {
  EmailClassification,
  EmailCategory,
} from "../../interfaces/email-classifier.js";
import type {
  EmailFailure,
  EmailFailureStage,
  EmailProcessingStatus,
  EmailRepository,
  StoredEmail,
} from "../../interfaces/email-repository.js";

interface EmailRow {
  provider_message_id: string;
  thread_id: string;
  message_id_header: string;
  subject: string;
  received_at: string;
  status: EmailProcessingStatus;
  attempt_count: number;
  last_error: string | null;
  ignored_reason: string | null;
  sent_provider_message_id: string | null;
  sent_at: string | null;
  failure_stage: EmailFailureStage | null;
  failure_code: string | null;
  failure_user_message: string | null;
  last_failure_at: string | null;
  manual_retry_count: number;
  classification_category: EmailCategory | null;
  classification_confidence: number | null;
  classification_reason: string | null;
  classification_requested_model: string | null;
  classification_resolved_model: string | null;
  classification_provider_response_id: string | null;
  classified_at: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteEmailRepository implements EmailRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  async register(message: EmailMessage): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare<{
        providerMessageId: string;
        threadId: string;
        messageIdHeader: string;
        subject: string;
        receivedAt: string;
        createdAt: string;
        updatedAt: string;
      }>(`
        INSERT INTO email_messages (
          provider_message_id,
          thread_id,
          message_id_header,
          subject,
          received_at,
          status,
          created_at,
          updated_at
        )
        VALUES (
          @providerMessageId,
          @threadId,
          @messageIdHeader,
          @subject,
          @receivedAt,
          'discovered',
          @createdAt,
          @updatedAt
        )
        ON CONFLICT (provider_message_id) DO NOTHING
      `)
      .run({
        providerMessageId: message.providerMessageId,
        threadId: message.threadId,
        messageIdHeader: message.messageIdHeader,
        subject: message.subject,
        receivedAt: message.receivedAt.toISOString(),
        createdAt: now,
        updatedAt: now,
      });

    return result.changes === 1;
  }

  async findByProviderMessageId(
    providerMessageId: string,
  ): Promise<StoredEmail | null> {
    const row = this.#database
      .prepare<[string], EmailRow>(`
        SELECT
          provider_message_id,
          thread_id,
          message_id_header,
          subject,
          received_at,
          status,
          attempt_count,
          last_error,
          ignored_reason,
          sent_provider_message_id,
          sent_at,
          failure_stage,
          failure_code,
          failure_user_message,
          last_failure_at,
          manual_retry_count,
          classification_category,
          classification_confidence,
          classification_reason,
          classification_requested_model,
          classification_resolved_model,
          classification_provider_response_id,
          classified_at,
          created_at,
          updated_at
        FROM email_messages
        WHERE provider_message_id = ?
      `)
      .get(providerMessageId);

    return row ? mapEmailRow(row) : null;
  }

  async listByStatus(
    status: EmailProcessingStatus,
    limit: number,
  ): Promise<readonly StoredEmail[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Email query limit must be a positive integer");
    }

    const rows = this.#database
      .prepare<[EmailProcessingStatus, number], EmailRow>(`
        SELECT
          provider_message_id,
          thread_id,
          message_id_header,
          subject,
          received_at,
          status,
          attempt_count,
          last_error,
          ignored_reason,
          sent_provider_message_id,
          sent_at,
          failure_stage,
          failure_code,
          failure_user_message,
          last_failure_at,
          manual_retry_count,
          classification_category,
          classification_confidence,
          classification_reason,
          classification_requested_model,
          classification_resolved_model,
          classification_provider_response_id,
          classified_at,
          created_at,
          updated_at
        FROM email_messages
        WHERE status = ?
        ORDER BY received_at ASC
        LIMIT ?
      `)
      .all(status, limit);

    return rows.map(mapEmailRow);
  }

  async claimForDrafting(providerMessageId: string): Promise<boolean> {
    return this.transitionStatus(providerMessageId, "discovered", "drafting");
  }

  async saveClassification(
    providerMessageId: string,
    classification: EmailClassification,
  ): Promise<boolean> {
    const classifiedAt = new Date().toISOString();
    const result = this.#database
      .prepare<{
        providerMessageId: string;
        category: EmailCategory;
        confidence: number;
        reason: string;
        requestedModel: string;
        resolvedModel: string;
        providerResponseId: string;
        classifiedAt: string;
      }>(`
        UPDATE email_messages
        SET
          classification_category = @category,
          classification_confidence = @confidence,
          classification_reason = @reason,
          classification_requested_model = @requestedModel,
          classification_resolved_model = @resolvedModel,
          classification_provider_response_id = @providerResponseId,
          classified_at = @classifiedAt,
          updated_at = @classifiedAt
        WHERE provider_message_id = @providerMessageId
          AND status = 'drafting'
      `)
      .run({
        providerMessageId,
        category: classification.category,
        confidence: classification.confidence,
        reason: classification.reason,
        requestedModel: classification.requestedModel,
        resolvedModel: classification.resolvedModel,
        providerResponseId: classification.providerResponseId,
        classifiedAt,
      });

    return result.changes === 1;
  }

  async findLatestClassificationByThreadId(
    threadId: string,
    excludingProviderMessageId: string,
  ): Promise<EmailClassification | null> {
    const row = this.#database
      .prepare<[string, string], EmailRow>(`
        SELECT
          provider_message_id,
          thread_id,
          message_id_header,
          subject,
          received_at,
          status,
          attempt_count,
          last_error,
          ignored_reason,
          sent_provider_message_id,
          sent_at,
          failure_stage,
          failure_code,
          failure_user_message,
          last_failure_at,
          manual_retry_count,
          classification_category,
          classification_confidence,
          classification_reason,
          classification_requested_model,
          classification_resolved_model,
          classification_provider_response_id,
          classified_at,
          created_at,
          updated_at
        FROM email_messages
        WHERE thread_id = ?
          AND provider_message_id <> ?
          AND classification_category IS NOT NULL
        ORDER BY classified_at DESC, received_at DESC
        LIMIT 1
      `)
      .get(threadId, excludingProviderMessageId);

    return row ? mapClassification(row) : null;
  }

  async claimFailedGenerationRetry(providerMessageId: string): Promise<boolean> {
    const result = this.#database
      .prepare<{ providerMessageId: string; updatedAt: string }>(`
        UPDATE email_messages
        SET
          status = 'drafting',
          manual_retry_count = manual_retry_count + 1,
          updated_at = @updatedAt
        WHERE provider_message_id = @providerMessageId
          AND status = 'failed'
          AND failure_stage = 'draft_generation'
      `)
      .run({ providerMessageId, updatedAt: new Date().toISOString() });

    return result.changes === 1;
  }

  async releaseInterruptedDrafting(): Promise<number> {
    const result = this.#database
      .prepare<[string]>(`
        UPDATE email_messages
        SET
          status = 'discovered',
          last_error = NULL,
          ignored_reason = NULL,
          updated_at = ?
        WHERE status = 'drafting'
      `)
      .run(new Date().toISOString());

    return result.changes;
  }

  async transitionStatus(
    providerMessageId: string,
    expectedStatus: EmailProcessingStatus,
    nextStatus: EmailProcessingStatus,
  ): Promise<boolean> {
    const result = this.#database
      .prepare<{
        providerMessageId: string;
        expectedStatus: EmailProcessingStatus;
        nextStatus: EmailProcessingStatus;
        updatedAt: string;
      }>(`
        UPDATE email_messages
        SET
          status = @nextStatus,
          last_error = NULL,
          ignored_reason = NULL,
          updated_at = @updatedAt
        WHERE provider_message_id = @providerMessageId
          AND status = @expectedStatus
      `)
      .run({
        providerMessageId,
        expectedStatus,
        nextStatus,
        updatedAt: new Date().toISOString(),
      });

    return result.changes === 1;
  }

  async markFailed(
    providerMessageId: string,
    expectedStatus: EmailProcessingStatus,
    failure: EmailFailure,
  ): Promise<boolean> {
    const failedAt = new Date().toISOString();
    const result = this.#database
      .prepare<{
        providerMessageId: string;
        expectedStatus: EmailProcessingStatus;
        stage: EmailFailureStage;
        code: string;
        technicalMessage: string;
        userMessage: string;
        failedAt: string;
      }>(`
        UPDATE email_messages
        SET
          status = 'failed',
          attempt_count = attempt_count + 1,
          last_error = @technicalMessage,
          ignored_reason = NULL,
          failure_stage = @stage,
          failure_code = @code,
          failure_user_message = @userMessage,
          last_failure_at = @failedAt,
          updated_at = @failedAt
        WHERE provider_message_id = @providerMessageId
          AND status = @expectedStatus
      `)
      .run({
        providerMessageId,
        expectedStatus,
        stage: failure.stage,
        code: failure.code,
        technicalMessage: failure.technicalMessage,
        userMessage: failure.userMessage,
        failedAt,
      });

    return result.changes === 1;
  }

  async markSent(
    providerMessageId: string,
    sentProviderMessageId: string,
  ): Promise<boolean> {
    if (!sentProviderMessageId.trim()) {
      throw new Error("A sent Gmail message ID is required");
    }

    const sentAt = new Date().toISOString();
    const result = this.#database
      .prepare<{
        providerMessageId: string;
        sentProviderMessageId: string;
        sentAt: string;
      }>(`
        UPDATE email_messages
        SET
          status = 'sent',
          sent_provider_message_id = @sentProviderMessageId,
          sent_at = @sentAt,
          last_error = NULL,
          failure_stage = NULL,
          failure_code = NULL,
          failure_user_message = NULL,
          last_failure_at = NULL,
          updated_at = @sentAt
        WHERE provider_message_id = @providerMessageId
          AND status = 'sending'
      `)
      .run({ providerMessageId, sentProviderMessageId, sentAt });

    return result.changes === 1;
  }

  async markIgnored(
    providerMessageId: string,
    expectedStatus: EmailProcessingStatus,
    reason: string,
  ): Promise<boolean> {
    if (!reason.trim()) {
      throw new Error("An ignored email reason is required");
    }

    const result = this.#database
      .prepare<{
        providerMessageId: string;
        expectedStatus: EmailProcessingStatus;
        reason: string;
        updatedAt: string;
      }>(`
        UPDATE email_messages
        SET
          status = 'ignored',
          last_error = NULL,
          ignored_reason = @reason,
          failure_stage = NULL,
          failure_code = NULL,
          failure_user_message = NULL,
          last_failure_at = NULL,
          updated_at = @updatedAt
        WHERE provider_message_id = @providerMessageId
          AND status = @expectedStatus
      `)
      .run({
        providerMessageId,
        expectedStatus,
        reason: reason.trim(),
        updatedAt: new Date().toISOString(),
      });

    return result.changes === 1;
  }
}

function mapEmailRow(row: EmailRow): StoredEmail {
  return {
    providerMessageId: row.provider_message_id,
    threadId: row.thread_id,
    messageIdHeader: row.message_id_header,
    subject: row.subject,
    receivedAt: parseStoredDate(row.received_at, "received_at"),
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    ignoredReason: row.ignored_reason,
    sentProviderMessageId: row.sent_provider_message_id,
    sentAt: row.sent_at ? parseStoredDate(row.sent_at, "sent_at") : null,
    failureStage: row.failure_stage,
    failureCode: row.failure_code,
    failureUserMessage: row.failure_user_message,
    lastFailureAt: row.last_failure_at
      ? parseStoredDate(row.last_failure_at, "last_failure_at")
      : null,
    manualRetryCount: row.manual_retry_count,
    classification: mapClassification(row),
    classifiedAt: row.classified_at
      ? parseStoredDate(row.classified_at, "classified_at")
      : null,
    createdAt: parseStoredDate(row.created_at, "created_at"),
    updatedAt: parseStoredDate(row.updated_at, "updated_at"),
  };
}

function mapClassification(row: EmailRow): EmailClassification | null {
  if (
    row.classification_category === null ||
    row.classification_confidence === null ||
    row.classification_reason === null ||
    row.classification_requested_model === null ||
    row.classification_resolved_model === null ||
    row.classification_provider_response_id === null
  ) {
    return null;
  }

  return {
    category: row.classification_category,
    confidence: row.classification_confidence,
    reason: row.classification_reason,
    requestedModel: row.classification_requested_model,
    resolvedModel: row.classification_resolved_model,
    providerResponseId: row.classification_provider_response_id,
  };
}

function parseStoredDate(value: string, column: string): Date {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date in email_messages.${column}: ${value}`);
  }

  return date;
}
