import type Database from "better-sqlite3";

import type {
  AssistantConversationMessage,
  AssistantConversationRepository,
  AssistantInboundMessage,
  AssistantMemory,
  AssistantUsageRecord,
  AssistantUsageSummary,
} from "../../interfaces/assistant-conversation-repository.js";
import type { AssistantMessageRole } from "../../interfaces/assistant-provider.js";

const MAX_STORED_ERROR_LENGTH = 500;
const SEARCH_STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "do", "for", "from",
  "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "that",
  "the", "this", "to", "was", "what", "when", "where", "who", "with", "you",
]);

interface ConversationMessageRow {
  id: number;
  channel_id: string;
  user_id: string;
  discord_message_id: string;
  role: AssistantMessageRole;
  body: string;
  created_at: string;
}

interface MemoryRow {
  id: number;
  channel_id: string;
  content: string;
  source_discord_message_id: string;
  created_at: string;
  updated_at: string;
}

interface UsageSummaryRow {
  request_count: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  requests_with_cost: number;
}

export class SqliteAssistantConversationRepository
  implements AssistantConversationRepository
{
  readonly #database: Database.Database;
  readonly #now: () => Date;

  constructor(
    database: Database.Database,
    options: { now?: () => Date } = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async claimInbound(input: AssistantInboundMessage): Promise<boolean> {
    const now = this.#now().toISOString();
    const result = this.#database.prepare<{
      discordMessageId: string;
      channelId: string;
      userId: string;
      body: string;
      now: string;
    }>(`
      INSERT INTO assistant_inbound_messages (
        discord_message_id, channel_id, user_id, body, status, created_at, updated_at
      ) VALUES (
        @discordMessageId, @channelId, @userId, @body, 'processing', @now, @now
      )
      ON CONFLICT (discord_message_id) DO NOTHING
    `).run({ ...input, now });
    return result.changes === 1;
  }

  async appendMessage(input: {
    channelId: string;
    userId: string;
    discordMessageId: string;
    role: AssistantMessageRole;
    body: string;
  }): Promise<boolean> {
    const inserted = this.#database.prepare<{
      channelId: string;
      userId: string;
      discordMessageId: string;
      role: AssistantMessageRole;
      body: string;
      now: string;
    }>(`
      INSERT INTO assistant_conversation_messages (
        channel_id, user_id, discord_message_id, role, body, created_at
      ) VALUES (
        @channelId, @userId, @discordMessageId, @role, @body, @now
      )
      ON CONFLICT (discord_message_id) DO NOTHING
    `).run({ ...input, now: this.#now().toISOString() });
    return inserted.changes === 1;
  }

  async listRecent(
    channelId: string,
    limit: number,
  ): Promise<readonly AssistantConversationMessage[]> {
    assertPositiveInteger(limit, "Assistant history query limit");
    return this.#database.prepare<{
      channelId: string;
      limit: number;
    }, ConversationMessageRow>(`
      SELECT id, channel_id, user_id, discord_message_id, role, body, created_at
      FROM (
        SELECT id, channel_id, user_id, discord_message_id, role, body, created_at
        FROM assistant_conversation_messages
        WHERE channel_id = @channelId
          AND id > COALESCE((
            SELECT context_started_after_id
            FROM assistant_conversation_state
            WHERE channel_id = @channelId
          ), 0)
        ORDER BY id DESC
        LIMIT @limit
      )
      ORDER BY id ASC
    `).all({ channelId, limit }).map(mapConversationMessage);
  }

  async completeInbound(discordMessageId: string): Promise<boolean> {
    const result = this.#database.prepare<{
      discordMessageId: string;
      now: string;
    }>(`
      UPDATE assistant_inbound_messages
      SET status = 'completed', last_error = NULL, updated_at = @now
      WHERE discord_message_id = @discordMessageId AND status = 'processing'
    `).run({ discordMessageId, now: this.#now().toISOString() });
    return result.changes === 1;
  }

  async failInbound(discordMessageId: string, error: string): Promise<boolean> {
    const result = this.#database.prepare<{
      discordMessageId: string;
      error: string;
      now: string;
    }>(`
      UPDATE assistant_inbound_messages
      SET status = 'failed', last_error = @error, updated_at = @now
      WHERE discord_message_id = @discordMessageId AND status = 'processing'
    `).run({
      discordMessageId,
      error: error.slice(0, MAX_STORED_ERROR_LENGTH),
      now: this.#now().toISOString(),
    });
    return result.changes === 1;
  }

  async resetConversation(channelId: string): Promise<number> {
    const latest = this.#database.prepare<[string], { id: number; count: number }>(`
      SELECT COALESCE(MAX(id), 0) AS id, COUNT(*) AS count
      FROM assistant_conversation_messages
      WHERE channel_id = ?
    `).get(channelId) ?? { id: 0, count: 0 };
    this.#database.prepare<{
      channelId: string;
      latestId: number;
      now: string;
    }>(`
      INSERT INTO assistant_conversation_state (
        channel_id, context_started_after_id, updated_at
      ) VALUES (@channelId, @latestId, @now)
      ON CONFLICT (channel_id) DO UPDATE SET
        context_started_after_id = excluded.context_started_after_id,
        updated_at = excluded.updated_at
    `).run({
      channelId,
      latestId: latest.id,
      now: this.#now().toISOString(),
    });
    return latest.count;
  }

  async searchHistory(
    channelId: string,
    query: string,
    beforeId: number,
    limit: number,
  ): Promise<readonly AssistantConversationMessage[]> {
    assertPositiveInteger(limit, "Assistant search result limit");
    const ftsQuery = createFtsQuery(query);
    if (!ftsQuery) return [];
    return this.#database.prepare<{
      channelId: string;
      query: string;
      beforeId: number;
      limit: number;
    }, ConversationMessageRow>(`
      SELECT messages.id, messages.channel_id, messages.user_id,
        messages.discord_message_id, messages.role, messages.body, messages.created_at
      FROM assistant_conversation_fts
      JOIN assistant_conversation_messages AS messages
        ON messages.id = assistant_conversation_fts.rowid
      WHERE assistant_conversation_fts MATCH @query
        AND messages.channel_id = @channelId
        AND messages.id < @beforeId
      ORDER BY bm25(assistant_conversation_fts), messages.id DESC
      LIMIT @limit
    `).all({ channelId, query: ftsQuery, beforeId, limit }).map(mapConversationMessage);
  }

  async saveMemory(input: {
    channelId: string;
    content: string;
    sourceDiscordMessageId: string;
  }): Promise<AssistantMemory> {
    const content = input.content.trim();
    const normalizedContent = normalizeMemory(content);
    if (!normalizedContent) throw new Error("Memory content cannot be empty");
    const now = this.#now().toISOString();
    this.#database.prepare<{
      channelId: string;
      content: string;
      normalizedContent: string;
      sourceDiscordMessageId: string;
      now: string;
    }>(`
      INSERT INTO assistant_memories (
        channel_id, content, normalized_content, source_discord_message_id,
        status, created_at, updated_at
      ) VALUES (
        @channelId, @content, @normalizedContent, @sourceDiscordMessageId,
        'active', @now, @now
      )
      ON CONFLICT (channel_id, normalized_content) DO UPDATE SET
        content = excluded.content,
        source_discord_message_id = excluded.source_discord_message_id,
        status = 'active',
        updated_at = excluded.updated_at
    `).run({ ...input, content, normalizedContent, now });
    const row = this.#database.prepare<{
      channelId: string;
      normalizedContent: string;
    }, MemoryRow>(`
      SELECT id, channel_id, content, source_discord_message_id, created_at, updated_at
      FROM assistant_memories
      WHERE channel_id = @channelId AND normalized_content = @normalizedContent
    `).get({ channelId: input.channelId, normalizedContent });
    if (!row) throw new Error("Saved memory could not be read");
    return mapMemory(row);
  }

  async listMemories(
    channelId: string,
    limit: number,
  ): Promise<readonly AssistantMemory[]> {
    assertPositiveInteger(limit, "Assistant memory query limit");
    return this.#database.prepare<{
      channelId: string;
      limit: number;
    }, MemoryRow>(`
      SELECT id, channel_id, content, source_discord_message_id, created_at, updated_at
      FROM assistant_memories
      WHERE channel_id = @channelId AND status = 'active'
      ORDER BY updated_at DESC, id DESC
      LIMIT @limit
    `).all({ channelId, limit }).map(mapMemory);
  }

  async forgetMemory(channelId: string, id: number): Promise<boolean> {
    assertPositiveInteger(id, "Memory id");
    const result = this.#database.prepare<{
      channelId: string;
      id: number;
      now: string;
    }>(`
      UPDATE assistant_memories
      SET status = 'forgotten', updated_at = @now
      WHERE channel_id = @channelId AND id = @id AND status = 'active'
    `).run({ channelId, id, now: this.#now().toISOString() });
    return result.changes === 1;
  }

  async recordUsage(input: AssistantUsageRecord): Promise<boolean> {
    const result = this.#database.prepare<AssistantUsageRecord & { now: string }>(`
      INSERT INTO assistant_model_usage (
        inbound_discord_message_id, provider_response_id, requested_model,
        resolved_model, prompt_tokens, completion_tokens, reasoning_tokens,
        cost_usd, created_at
      ) VALUES (
        @inboundDiscordMessageId, @providerResponseId, @requestedModel,
        @resolvedModel, @promptTokens, @completionTokens, @reasoningTokens,
        @costUsd, @now
      )
      ON CONFLICT (inbound_discord_message_id) DO NOTHING
    `).run({ ...input, now: this.#now().toISOString() });
    return result.changes === 1;
  }

  async getUsageSummary(since?: Date): Promise<AssistantUsageSummary> {
    const row = this.#database.prepare<{
      since: string | null;
    }, UsageSummaryRow>(`
      SELECT COUNT(*) AS request_count,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(reasoning_tokens) AS reasoning_tokens,
        SUM(cost_usd) AS cost_usd,
        COUNT(cost_usd) AS requests_with_cost
      FROM assistant_model_usage
      WHERE @since IS NULL OR created_at >= @since
    `).get({ since: since?.toISOString() ?? null });
    return {
      requestCount: row?.request_count ?? 0,
      promptTokens: row?.prompt_tokens ?? 0,
      completionTokens: row?.completion_tokens ?? 0,
      reasoningTokens: row?.reasoning_tokens ?? 0,
      costUsd: row?.cost_usd ?? 0,
      requestsWithCost: row?.requests_with_cost ?? 0,
    };
  }
}

function createFtsQuery(value: string): string | null {
  const terms = value.toLowerCase().match(/[\p{L}\p{N}]+/gu)
    ?.filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term))
    .slice(0, 12) ?? [];
  const uniqueTerms = [...new Set(terms)];
  return uniqueTerms.length > 0
    ? uniqueTerms.map((term) => `"${term}"`).join(" OR ")
    : null;
}

function normalizeMemory(value: string): string {
  return value.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function mapConversationMessage(
  row: ConversationMessageRow,
): AssistantConversationMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    discordMessageId: row.discord_message_id,
    role: row.role,
    content: row.body,
    createdAt: new Date(row.created_at),
  };
}

function mapMemory(row: MemoryRow): AssistantMemory {
  return {
    id: row.id,
    channelId: row.channel_id,
    content: row.content,
    sourceDiscordMessageId: row.source_discord_message_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
