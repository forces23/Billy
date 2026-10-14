import type Database from "better-sqlite3";

import type { GeneratedReply } from "../../interfaces/ai-provider.js";
import type {
  DraftRepository,
  StoredDraft,
} from "../../interfaces/draft-repository.js";

interface DraftRow {
  id: number;
  provider_message_id: string;
  revision: number;
  body: string;
  reviewer_note: string | null;
  provider_response_id: string;
  requested_model: string;
  resolved_model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
}

interface RevisionRow {
  next_revision: number;
}

export class SqliteDraftRepository implements DraftRepository {
  readonly #saveTransaction: (
    providerMessageId: string,
    generatedReply: GeneratedReply,
  ) => StoredDraft | null;
  readonly #database: Database.Database;
  readonly #saveRevisionTransaction: (
    providerMessageId: string,
    generatedReply: GeneratedReply,
  ) => StoredDraft | null;

  constructor(database: Database.Database) {
    this.#database = database;
    this.#saveTransaction = database.transaction(
      (
        providerMessageId: string,
        generatedReply: GeneratedReply,
      ): StoredDraft | null => {
        const email = database
          .prepare<[string], { status: string }>(`
            SELECT status
            FROM email_messages
            WHERE provider_message_id = ?
          `)
          .get(providerMessageId);

        if (email?.status !== "drafting") {
          return null;
        }

        const revision = database
          .prepare<[string], RevisionRow>(`
            SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
            FROM email_drafts
            WHERE provider_message_id = ?
          `)
          .get(providerMessageId)?.next_revision;

        if (!revision) {
          throw new Error("Could not allocate an email draft revision");
        }

        const createdAt = new Date().toISOString();
        const result = database
          .prepare<{
            providerMessageId: string;
            revision: number;
            body: string;
            reviewerNote: string | null;
            providerResponseId: string;
            requestedModel: string;
            resolvedModel: string;
            promptTokens: number | null;
            completionTokens: number | null;
            createdAt: string;
          }>(`
            INSERT INTO email_drafts (
              provider_message_id,
              revision,
              body,
              reviewer_note,
              provider_response_id,
              requested_model,
              resolved_model,
              prompt_tokens,
              completion_tokens,
              created_at
            )
            VALUES (
              @providerMessageId,
              @revision,
              @body,
              @reviewerNote,
              @providerResponseId,
              @requestedModel,
              @resolvedModel,
              @promptTokens,
              @completionTokens,
              @createdAt
            )
          `)
          .run({
            providerMessageId,
            revision,
            body: generatedReply.body,
            reviewerNote: generatedReply.reviewerNote,
            providerResponseId: generatedReply.providerResponseId,
            requestedModel: generatedReply.requestedModel,
            resolvedModel: generatedReply.resolvedModel,
            promptTokens: generatedReply.promptTokens,
            completionTokens: generatedReply.completionTokens,
            createdAt,
          });

        const transition = database
          .prepare<[string, string]>(`
            UPDATE email_messages
            SET
              status = 'awaiting_approval',
              last_error = NULL,
              ignored_reason = NULL,
              failure_stage = NULL,
              failure_code = NULL,
              failure_user_message = NULL,
              last_failure_at = NULL,
              updated_at = ?
            WHERE provider_message_id = ?
              AND status = 'drafting'
          `)
          .run(createdAt, providerMessageId);

        if (transition.changes !== 1) {
          throw new Error("Email left drafting before its draft could be saved");
        }

        return {
          id: Number(result.lastInsertRowid),
          providerMessageId,
          revision,
          body: generatedReply.body,
          reviewerNote: generatedReply.reviewerNote,
          providerResponseId: generatedReply.providerResponseId,
          requestedModel: generatedReply.requestedModel,
          resolvedModel: generatedReply.resolvedModel,
          promptTokens: generatedReply.promptTokens,
          completionTokens: generatedReply.completionTokens,
          createdAt: new Date(createdAt),
        };
      },
    );
    this.#saveRevisionTransaction = database.transaction(
      (
        providerMessageId: string,
        generatedReply: GeneratedReply,
      ): StoredDraft | null => {
        const email = database
          .prepare<[string], { status: string }>(`
            SELECT status
            FROM email_messages
            WHERE provider_message_id = ?
          `)
          .get(providerMessageId);

        if (email?.status !== "awaiting_approval") {
          return null;
        }

        return insertDraft(database, providerMessageId, generatedReply);
      },
    );
  }

  async saveAndAwaitApproval(
    providerMessageId: string,
    generatedReply: GeneratedReply,
  ): Promise<StoredDraft | null> {
    return this.#saveTransaction(providerMessageId, generatedReply);
  }

  async listByProviderMessageId(
    providerMessageId: string,
  ): Promise<readonly StoredDraft[]> {
    return this.#database
      .prepare<[string], DraftRow>(`
        SELECT
          id,
          provider_message_id,
          revision,
          body,
          reviewer_note,
          provider_response_id,
          requested_model,
          resolved_model,
          prompt_tokens,
          completion_tokens,
          created_at
        FROM email_drafts
        WHERE provider_message_id = ?
        ORDER BY revision ASC
      `)
      .all(providerMessageId)
      .map(mapDraftRow);
  }

  async findById(id: number): Promise<StoredDraft | null> {
    if (!Number.isInteger(id) || id < 1) {
      return null;
    }

    const row = this.#database
      .prepare<[number], DraftRow>(`
        SELECT
          id,
          provider_message_id,
          revision,
          body,
          reviewer_note,
          provider_response_id,
          requested_model,
          resolved_model,
          prompt_tokens,
          completion_tokens,
          created_at
        FROM email_drafts
        WHERE id = ?
      `)
      .get(id);

    return row ? mapDraftRow(row) : null;
  }

  async saveRevisionWhileAwaitingApproval(
    providerMessageId: string,
    generatedReply: GeneratedReply,
  ): Promise<StoredDraft | null> {
    return this.#saveRevisionTransaction(providerMessageId, generatedReply);
  }
}

function insertDraft(
  database: Database.Database,
  providerMessageId: string,
  generatedReply: GeneratedReply,
): StoredDraft {
  const revision = database
    .prepare<[string], RevisionRow>(`
      SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
      FROM email_drafts
      WHERE provider_message_id = ?
    `)
    .get(providerMessageId)?.next_revision;

  if (!revision) {
    throw new Error("Could not allocate an email draft revision");
  }

  const createdAt = new Date().toISOString();
  const result = database
    .prepare<{
      providerMessageId: string;
      revision: number;
      body: string;
      reviewerNote: string | null;
      providerResponseId: string;
      requestedModel: string;
      resolvedModel: string;
      promptTokens: number | null;
      completionTokens: number | null;
      createdAt: string;
    }>(`
      INSERT INTO email_drafts (
        provider_message_id,
        revision,
        body,
        reviewer_note,
        provider_response_id,
        requested_model,
        resolved_model,
        prompt_tokens,
        completion_tokens,
        created_at
      )
      VALUES (
        @providerMessageId,
        @revision,
        @body,
        @reviewerNote,
        @providerResponseId,
        @requestedModel,
        @resolvedModel,
        @promptTokens,
        @completionTokens,
        @createdAt
      )
    `)
    .run({
      providerMessageId,
      revision,
      body: generatedReply.body,
      reviewerNote: generatedReply.reviewerNote,
      providerResponseId: generatedReply.providerResponseId,
      requestedModel: generatedReply.requestedModel,
      resolvedModel: generatedReply.resolvedModel,
      promptTokens: generatedReply.promptTokens,
      completionTokens: generatedReply.completionTokens,
      createdAt,
    });

  return {
    id: Number(result.lastInsertRowid),
    providerMessageId,
    revision,
    body: generatedReply.body,
    reviewerNote: generatedReply.reviewerNote,
    providerResponseId: generatedReply.providerResponseId,
    requestedModel: generatedReply.requestedModel,
    resolvedModel: generatedReply.resolvedModel,
    promptTokens: generatedReply.promptTokens,
    completionTokens: generatedReply.completionTokens,
    createdAt: new Date(createdAt),
  };
}

function mapDraftRow(row: DraftRow): StoredDraft {
  const createdAt = new Date(row.created_at);

  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(`Invalid date in email_drafts.created_at: ${row.created_at}`);
  }

  return {
    id: row.id,
    providerMessageId: row.provider_message_id,
    revision: row.revision,
    body: row.body,
    reviewerNote: row.reviewer_note,
    providerResponseId: row.provider_response_id,
    requestedModel: row.requested_model,
    resolvedModel: row.resolved_model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    createdAt,
  };
}
