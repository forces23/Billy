import type Database from "better-sqlite3";

import type { EmailAddress, RecipientSet } from "../../core/recipient-resolver.js";
import type {
  ApprovalRepository,
  DeliveryDisplayStatus,
  DeliveryStatusUpdate,
  DraftPublication,
  GenerationFailureNotice,
  GenerationFailurePublication,
  ReplyMode,
  RevisionRequest,
  ReviewDecision,
  ResolvedGenerationFailurePublication,
  StoredReviewDecision,
} from "../../interfaces/approval-repository.js";

const MAX_STORED_ERROR_LENGTH = 500;

interface PublicationRow {
  draft_id: number;
  channel_id: string;
  message_id: string;
  posted_at: string;
}

interface GenerationFailureRow {
  provider_message_id: string;
  subject: string;
  failure_user_message: string;
  failure_code: string;
  attempt_count: number;
  manual_retry_count: number;
  last_failure_at: string;
  channel_id: string | null;
  message_id: string | null;
  rendered_failure_at: string | null;
  resolved_at: string | null;
}

interface GenerationFailurePublicationRow {
  provider_message_id: string;
  channel_id: string;
  message_id: string;
  rendered_failure_at: string;
  resolved_at: string | null;
  subject: string;
  status: string;
}

interface DeliveryUpdateRow {
  draft_id: number;
  provider_message_id: string;
  channel_id: string;
  message_id: string;
  revision: number;
  subject: string;
  decision: ReviewDecision;
  status: "approved" | "sending" | "sent" | "failed";
  sent_at: string | null;
  failure_user_message: string | null;
}

interface DecisionRow {
  provider_message_id: string;
  draft_id: number;
  decision: ReviewDecision;
  reviewer_user_id: string;
  decided_at: string;
}

interface RecipientRow {
  recipient_kind: "to" | "cc";
  position: number;
  address: string;
  display_name: string | null;
}

interface RevisionRequestRow {
  id: number;
  discord_interaction_id: string;
  source_draft_id: number;
  result_draft_id: number | null;
  reviewer_user_id: string;
  instructions: string;
  status: "pending" | "completed" | "failed";
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteApprovalRepository implements ApprovalRepository {
  readonly #database: Database.Database;
  readonly #approveTransaction: (
    draftId: number,
    mode: ReplyMode,
    recipients: RecipientSet,
    reviewerUserId: string,
  ) => StoredReviewDecision | null;
  readonly #doNotReplyTransaction: (
    draftId: number,
    reviewerUserId: string,
  ) => StoredReviewDecision | null;

  constructor(database: Database.Database) {
    this.#database = database;
    this.#approveTransaction = database.transaction(
      (
        draftId: number,
        mode: ReplyMode,
        recipients: RecipientSet,
        reviewerUserId: string,
      ): StoredReviewDecision | null => {
        if (recipients.to.length === 0) {
          throw new Error("An approved reply requires at least one To recipient");
        }

        const providerMessageId = claimFinalDecision(
          database,
          draftId,
          "approved",
        );
        if (!providerMessageId) return null;

        const decision: ReviewDecision =
          mode === "reply" ? "approved_reply" : "approved_reply_all";
        const decidedAt = new Date().toISOString();
        insertDecision(
          database,
          providerMessageId,
          draftId,
          decision,
          reviewerUserId,
          decidedAt,
        );
        insertRecipients(database, providerMessageId, "to", recipients.to);
        insertRecipients(database, providerMessageId, "cc", recipients.cc);

        return {
          providerMessageId,
          draftId,
          decision,
          reviewerUserId,
          recipients,
          decidedAt: new Date(decidedAt),
        };
      },
    );
    this.#doNotReplyTransaction = database.transaction(
      (draftId: number, reviewerUserId: string): StoredReviewDecision | null => {
        const providerMessageId = claimFinalDecision(
          database,
          draftId,
          "rejected",
        );
        if (!providerMessageId) return null;

        const decidedAt = new Date().toISOString();
        insertDecision(
          database,
          providerMessageId,
          draftId,
          "do_not_reply",
          reviewerUserId,
          decidedAt,
        );

        return {
          providerMessageId,
          draftId,
          decision: "do_not_reply",
          reviewerUserId,
          recipients: { to: [], cc: [] },
          decidedAt: new Date(decidedAt),
        };
      },
    );
  }

  async listUnpublishedAwaitingDraftIds(
    limit: number,
  ): Promise<readonly number[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Publication query limit must be a positive integer");
    }

    return this.#database
      .prepare<
        [number],
        { id: number }
      >(`
        SELECT d.id
        FROM email_drafts AS d
        INNER JOIN email_messages AS e
          ON e.provider_message_id = d.provider_message_id
        LEFT JOIN discord_draft_publications AS p
          ON p.draft_id = d.id
        WHERE e.status = 'awaiting_approval'
          AND p.draft_id IS NULL
        ORDER BY d.id ASC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => row.id);
  }

  async savePublication(
    draftId: number,
    channelId: string,
    messageId: string,
  ): Promise<boolean> {
    const result = this.#database
      .prepare<{
        draftId: number;
        channelId: string;
        messageId: string;
        postedAt: string;
      }>(`
        INSERT INTO discord_draft_publications (
          draft_id,
          channel_id,
          message_id,
          posted_at
        )
        VALUES (@draftId, @channelId, @messageId, @postedAt)
        ON CONFLICT (draft_id) DO NOTHING
      `)
      .run({
        draftId,
        channelId,
        messageId,
        postedAt: new Date().toISOString(),
      });

    return result.changes === 1;
  }

  async findPublication(draftId: number): Promise<DraftPublication | null> {
    const row = this.#database
      .prepare<[number], PublicationRow>(`
        SELECT draft_id, channel_id, message_id, posted_at
        FROM discord_draft_publications
        WHERE draft_id = ?
      `)
      .get(draftId);

    return row ? mapPublication(row) : null;
  }

  async listPublishedAwaitingDrafts(
    limit: number,
  ): Promise<readonly DraftPublication[]> {
    requirePositiveLimit(limit);

    return this.#database
      .prepare<[number], PublicationRow>(`
        SELECT p.draft_id, p.channel_id, p.message_id, p.posted_at
        FROM discord_draft_publications AS p
        INNER JOIN email_drafts AS d ON d.id = p.draft_id
        INNER JOIN email_messages AS e
          ON e.provider_message_id = d.provider_message_id
        WHERE e.status = 'awaiting_approval'
        ORDER BY p.draft_id ASC
        LIMIT ?
      `)
      .all(limit)
      .map(mapPublication);
  }

  async listPublicationsByProviderMessageId(
    providerMessageId: string,
  ): Promise<readonly DraftPublication[]> {
    return this.#database
      .prepare<[string], PublicationRow>(`
        SELECT p.draft_id, p.channel_id, p.message_id, p.posted_at
        FROM discord_draft_publications AS p
        INNER JOIN email_drafts AS d ON d.id = p.draft_id
        WHERE d.provider_message_id = ?
        ORDER BY d.revision ASC
      `)
      .all(providerMessageId)
      .map(mapPublication);
  }

  async listGenerationFailuresNeedingPublication(
    limit: number,
  ): Promise<readonly GenerationFailureNotice[]> {
    requirePositiveLimit(limit);

    return this.#database
      .prepare<[number], GenerationFailureRow>(`
        SELECT
          e.provider_message_id,
          e.subject,
          COALESCE(e.failure_user_message, 'OpenRouter could not generate a complete draft.')
            AS failure_user_message,
          COALESCE(e.failure_code, 'draft_generation_failed') AS failure_code,
          e.attempt_count,
          e.manual_retry_count,
          COALESCE(e.last_failure_at, e.updated_at) AS last_failure_at,
          p.channel_id,
          p.message_id,
          p.rendered_failure_at,
          p.resolved_at
        FROM email_messages AS e
        LEFT JOIN discord_generation_failure_publications AS p
          ON p.provider_message_id = e.provider_message_id
        WHERE e.status = 'failed'
          AND e.failure_stage = 'draft_generation'
          AND (
            p.provider_message_id IS NULL
            OR p.rendered_failure_at <> COALESCE(e.last_failure_at, e.updated_at)
            OR p.resolved_at IS NOT NULL
          )
        ORDER BY COALESCE(e.last_failure_at, e.updated_at) ASC
        LIMIT ?
      `)
      .all(limit)
      .map(mapGenerationFailureNotice);
  }

  async saveGenerationFailurePublication(
    providerMessageId: string,
    channelId: string,
    messageId: string,
    renderedFailureAt: Date,
  ): Promise<void> {
    const now = new Date().toISOString();
    this.#database
      .prepare<{
        providerMessageId: string;
        channelId: string;
        messageId: string;
        renderedFailureAt: string;
        now: string;
      }>(`
        INSERT INTO discord_generation_failure_publications (
          provider_message_id,
          channel_id,
          message_id,
          rendered_failure_at,
          resolved_at,
          posted_at,
          updated_at
        )
        VALUES (
          @providerMessageId,
          @channelId,
          @messageId,
          @renderedFailureAt,
          NULL,
          @now,
          @now
        )
        ON CONFLICT (provider_message_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          message_id = excluded.message_id,
          rendered_failure_at = excluded.rendered_failure_at,
          resolved_at = NULL,
          updated_at = excluded.updated_at
      `)
      .run({
        providerMessageId,
        channelId,
        messageId,
        renderedFailureAt: renderedFailureAt.toISOString(),
        now,
      });
  }

  async listResolvedGenerationFailurePublications(
    limit: number,
  ): Promise<readonly ResolvedGenerationFailurePublication[]> {
    requirePositiveLimit(limit);

    return this.#database
      .prepare<[number], GenerationFailurePublicationRow>(`
        SELECT
          p.provider_message_id,
          p.channel_id,
          p.message_id,
          p.rendered_failure_at,
          p.resolved_at,
          e.subject,
          e.status
        FROM discord_generation_failure_publications AS p
        INNER JOIN email_messages AS e
          ON e.provider_message_id = p.provider_message_id
        WHERE p.resolved_at IS NULL
          AND e.status NOT IN ('discovered', 'drafting')
          AND NOT (
            e.status = 'failed'
            AND e.failure_stage = 'draft_generation'
          )
        ORDER BY p.updated_at ASC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => ({
        publication: mapGenerationFailurePublication(row),
        subject: row.subject,
        emailStatus: row.status,
      }));
  }

  async markGenerationFailurePublicationResolved(
    providerMessageId: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare<[string, string, string]>(`
        UPDATE discord_generation_failure_publications
        SET resolved_at = ?, updated_at = ?
        WHERE provider_message_id = ?
          AND resolved_at IS NULL
      `)
      .run(now, now, providerMessageId);

    return result.changes === 1;
  }

  async listDeliveryStatusUpdates(
    limit: number,
  ): Promise<readonly DeliveryStatusUpdate[]> {
    requirePositiveLimit(limit);

    return this.#database
      .prepare<[number], DeliveryUpdateRow>(`
        SELECT
          p.draft_id,
          d.provider_message_id,
          p.channel_id,
          p.message_id,
          d.revision,
          e.subject,
          decision.decision,
          e.status,
          e.sent_at,
          e.failure_user_message
        FROM discord_draft_publications AS p
        INNER JOIN email_drafts AS d ON d.id = p.draft_id
        INNER JOIN email_messages AS e
          ON e.provider_message_id = d.provider_message_id
        INNER JOIN email_review_decisions AS decision
          ON decision.draft_id = p.draft_id
        WHERE decision.decision IN ('approved_reply', 'approved_reply_all')
          AND (
            e.status IN ('approved', 'sending', 'sent')
            OR (e.status = 'failed' AND e.failure_stage = 'gmail_send')
          )
          AND p.rendered_delivery_status <> CASE e.status
            WHEN 'approved' THEN 'queued'
            WHEN 'sending' THEN 'sending'
            WHEN 'sent' THEN 'sent'
            WHEN 'failed' THEN 'failed'
          END
        ORDER BY e.updated_at ASC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => ({
        draftId: row.draft_id,
        providerMessageId: row.provider_message_id,
        channelId: row.channel_id,
        messageId: row.message_id,
        revision: row.revision,
        subject: row.subject,
        decision: row.decision,
        displayStatus: deliveryStatus(row.status),
        sentAt: row.sent_at ? parseDate(row.sent_at, "email_messages.sent_at") : null,
        failureUserMessage: row.failure_user_message,
      }));
  }

  async markDeliveryStatusRendered(
    draftId: number,
    status: DeliveryDisplayStatus,
  ): Promise<boolean> {
    const result = this.#database
      .prepare<{
        draftId: number;
        status: DeliveryDisplayStatus;
        updatedAt: string;
      }>(`
        UPDATE discord_draft_publications
        SET
          rendered_delivery_status = @status,
          delivery_status_updated_at = @updatedAt
        WHERE draft_id = @draftId
      `)
      .run({ draftId, status, updatedAt: new Date().toISOString() });

    return result.changes === 1;
  }

  async approve(
    draftId: number,
    mode: ReplyMode,
    recipients: RecipientSet,
    reviewerUserId: string,
  ): Promise<StoredReviewDecision | null> {
    return this.#approveTransaction(
      draftId,
      mode,
      recipients,
      reviewerUserId,
    );
  }

  async doNotReply(
    draftId: number,
    reviewerUserId: string,
  ): Promise<StoredReviewDecision | null> {
    return this.#doNotReplyTransaction(draftId, reviewerUserId);
  }

  async findDecision(
    providerMessageId: string,
  ): Promise<StoredReviewDecision | null> {
    const row = this.#database
      .prepare<[string], DecisionRow>(`
        SELECT
          provider_message_id,
          draft_id,
          decision,
          reviewer_user_id,
          decided_at
        FROM email_review_decisions
        WHERE provider_message_id = ?
      `)
      .get(providerMessageId);

    if (!row) return null;

    const recipientRows = this.#database
      .prepare<[string], RecipientRow>(`
        SELECT recipient_kind, position, address, display_name
        FROM email_review_recipients
        WHERE provider_message_id = ?
        ORDER BY recipient_kind DESC, position ASC
      `)
      .all(providerMessageId);

    return {
      providerMessageId: row.provider_message_id,
      draftId: row.draft_id,
      decision: row.decision,
      reviewerUserId: row.reviewer_user_id,
      recipients: {
        to: mapRecipients(recipientRows, "to"),
        cc: mapRecipients(recipientRows, "cc"),
      },
      decidedAt: parseDate(row.decided_at, "email_review_decisions.decided_at"),
    };
  }

  async createRevisionRequest(
    interactionId: string,
    sourceDraftId: number,
    reviewerUserId: string,
    instructions: string,
  ): Promise<RevisionRequest | null> {
    const normalizedInstructions = instructions.trim();
    if (!normalizedInstructions) {
      throw new Error("Revision instructions are required");
    }

    const source = this.#database
      .prepare<[number], { status: string }>(`
        SELECT e.status
        FROM email_drafts AS d
        INNER JOIN email_messages AS e
          ON e.provider_message_id = d.provider_message_id
        WHERE d.id = ?
      `)
      .get(sourceDraftId);

    if (source?.status !== "awaiting_approval") return null;

    const now = new Date().toISOString();
    const result = this.#database
      .prepare<{
        interactionId: string;
        sourceDraftId: number;
        reviewerUserId: string;
        instructions: string;
        now: string;
      }>(`
        INSERT INTO email_revision_requests (
          discord_interaction_id,
          source_draft_id,
          reviewer_user_id,
          instructions,
          status,
          created_at,
          updated_at
        )
        VALUES (
          @interactionId,
          @sourceDraftId,
          @reviewerUserId,
          @instructions,
          'pending',
          @now,
          @now
        )
        ON CONFLICT (discord_interaction_id) DO NOTHING
      `)
      .run({
        interactionId,
        sourceDraftId,
        reviewerUserId,
        instructions: normalizedInstructions,
        now,
      });

    if (result.changes !== 1) return null;

    return this.#findRevisionRequest(Number(result.lastInsertRowid));
  }

  async completeRevisionRequest(
    requestId: number,
    resultDraftId: number,
  ): Promise<boolean> {
    const result = this.#database
      .prepare<{ requestId: number; resultDraftId: number; updatedAt: string }>(`
        UPDATE email_revision_requests
        SET
          result_draft_id = @resultDraftId,
          status = 'completed',
          last_error = NULL,
          updated_at = @updatedAt
        WHERE id = @requestId
          AND status = 'pending'
      `)
      .run({ requestId, resultDraftId, updatedAt: new Date().toISOString() });

    return result.changes === 1;
  }

  async failRevisionRequest(requestId: number, error: string): Promise<boolean> {
    const result = this.#database
      .prepare<{ requestId: number; error: string; updatedAt: string }>(`
        UPDATE email_revision_requests
        SET
          status = 'failed',
          last_error = @error,
          updated_at = @updatedAt
        WHERE id = @requestId
          AND status = 'pending'
      `)
      .run({
        requestId,
        error: error.replaceAll(/\s+/g, " ").trim().slice(0, MAX_STORED_ERROR_LENGTH),
        updatedAt: new Date().toISOString(),
      });

    return result.changes === 1;
  }

  #findRevisionRequest(id: number): RevisionRequest | null {
    const row = this.#database
      .prepare<[number], RevisionRequestRow>(`
        SELECT
          id,
          discord_interaction_id,
          source_draft_id,
          result_draft_id,
          reviewer_user_id,
          instructions,
          status,
          last_error,
          created_at,
          updated_at
        FROM email_revision_requests
        WHERE id = ?
      `)
      .get(id);

    return row ? mapRevisionRequest(row) : null;
  }
}

function claimFinalDecision(
  database: Database.Database,
  draftId: number,
  nextStatus: "approved" | "rejected",
): string | null {
  const draft = database
    .prepare<[number], { provider_message_id: string; status: string }>(`
      SELECT d.provider_message_id, e.status
      FROM email_drafts AS d
      INNER JOIN email_messages AS e
        ON e.provider_message_id = d.provider_message_id
      WHERE d.id = ?
    `)
    .get(draftId);

  if (!draft || draft.status !== "awaiting_approval") return null;

  const result = database
    .prepare<{
      providerMessageId: string;
      nextStatus: "approved" | "rejected";
      updatedAt: string;
    }>(`
      UPDATE email_messages
      SET status = @nextStatus, last_error = NULL, updated_at = @updatedAt
      WHERE provider_message_id = @providerMessageId
        AND status = 'awaiting_approval'
    `)
    .run({
      providerMessageId: draft.provider_message_id,
      nextStatus,
      updatedAt: new Date().toISOString(),
    });

  return result.changes === 1 ? draft.provider_message_id : null;
}

function insertDecision(
  database: Database.Database,
  providerMessageId: string,
  draftId: number,
  decision: ReviewDecision,
  reviewerUserId: string,
  decidedAt: string,
): void {
  database
    .prepare<{
      providerMessageId: string;
      draftId: number;
      decision: ReviewDecision;
      reviewerUserId: string;
      decidedAt: string;
    }>(`
      INSERT INTO email_review_decisions (
        provider_message_id,
        draft_id,
        decision,
        reviewer_user_id,
        decided_at
      )
      VALUES (
        @providerMessageId,
        @draftId,
        @decision,
        @reviewerUserId,
        @decidedAt
      )
    `)
    .run({ providerMessageId, draftId, decision, reviewerUserId, decidedAt });
}

function insertRecipients(
  database: Database.Database,
  providerMessageId: string,
  kind: "to" | "cc",
  recipients: readonly EmailAddress[],
): void {
  const insert = database.prepare<{
    providerMessageId: string;
    kind: "to" | "cc";
    position: number;
    address: string;
    displayName: string | null;
  }>(`
    INSERT INTO email_review_recipients (
      provider_message_id,
      recipient_kind,
      position,
      address,
      display_name
    )
    VALUES (@providerMessageId, @kind, @position, @address, @displayName)
  `);

  recipients.forEach((recipient, position) => {
    insert.run({
      providerMessageId,
      kind,
      position,
      address: recipient.address,
      displayName: recipient.name,
    });
  });
}

function mapPublication(row: PublicationRow): DraftPublication {
  return {
    draftId: row.draft_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    postedAt: parseDate(row.posted_at, "discord_draft_publications.posted_at"),
  };
}

function mapGenerationFailureNotice(
  row: GenerationFailureRow,
): GenerationFailureNotice {
  const hasPublication =
    row.channel_id !== null &&
    row.message_id !== null &&
    row.rendered_failure_at !== null;

  return {
    providerMessageId: row.provider_message_id,
    subject: row.subject,
    userMessage: row.failure_user_message,
    failureCode: row.failure_code,
    automaticAttemptRuns: row.attempt_count,
    manualRetryCount: row.manual_retry_count,
    failedAt: parseDate(row.last_failure_at, "email_messages.last_failure_at"),
    publication: hasPublication
      ? {
          providerMessageId: row.provider_message_id,
          channelId: row.channel_id!,
          messageId: row.message_id!,
          renderedFailureAt: parseDate(
            row.rendered_failure_at!,
            "discord_generation_failure_publications.rendered_failure_at",
          ),
          resolvedAt: row.resolved_at
            ? parseDate(
                row.resolved_at,
                "discord_generation_failure_publications.resolved_at",
              )
            : null,
        }
      : null,
  };
}

function mapGenerationFailurePublication(
  row: GenerationFailurePublicationRow,
): GenerationFailurePublication {
  return {
    providerMessageId: row.provider_message_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    renderedFailureAt: parseDate(
      row.rendered_failure_at,
      "discord_generation_failure_publications.rendered_failure_at",
    ),
    resolvedAt: row.resolved_at
      ? parseDate(
          row.resolved_at,
          "discord_generation_failure_publications.resolved_at",
        )
      : null,
  };
}

function deliveryStatus(
  status: DeliveryUpdateRow["status"],
): DeliveryDisplayStatus {
  if (status === "approved") return "queued";
  return status;
}

function requirePositiveLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Discord status query limit must be a positive integer");
  }
}

function mapRecipients(
  rows: readonly RecipientRow[],
  kind: "to" | "cc",
): readonly EmailAddress[] {
  return rows
    .filter((row) => row.recipient_kind === kind)
    .sort((left, right) => left.position - right.position)
    .map((row) => ({ name: row.display_name, address: row.address }));
}

function mapRevisionRequest(row: RevisionRequestRow): RevisionRequest {
  return {
    id: row.id,
    interactionId: row.discord_interaction_id,
    sourceDraftId: row.source_draft_id,
    resultDraftId: row.result_draft_id,
    reviewerUserId: row.reviewer_user_id,
    instructions: row.instructions,
    status: row.status,
    lastError: row.last_error,
    createdAt: parseDate(row.created_at, "email_revision_requests.created_at"),
    updatedAt: parseDate(row.updated_at, "email_revision_requests.updated_at"),
  };
}

function parseDate(value: string, location: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date in ${location}: ${value}`);
  }
  return date;
}
