import type Database from "better-sqlite3";

import type {
  ConversationInboundPublication,
  ConversationRepository,
  ConversationStatus,
  EmailConversation,
} from "../../interfaces/conversation-repository.js";

interface ConversationRow {
  gmail_thread_id: string;
  root_provider_message_id: string;
  latest_provider_message_id: string;
  subject: string;
  summary: string;
  status: ConversationStatus;
  channel_id: string | null;
  parent_message_id: string | null;
  discord_thread_id: string | null;
  rendered_status: string | null;
  created_at: string;
  updated_at: string;
}

interface InboundPublicationRow {
  provider_message_id: string;
  page: number;
  channel_id: string;
  message_id: string;
}

export class SqliteConversationRepository implements ConversationRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  async ensureForEmail(input: {
    gmailThreadId: string;
    providerMessageId: string;
    subject: string;
    summary: string;
    status: ConversationStatus;
  }): Promise<EmailConversation | null> {
    const transaction = this.#database.transaction(() => {
      const now = new Date().toISOString();
      this.#database.prepare<{
        gmailThreadId: string;
        providerMessageId: string;
        subject: string;
        summary: string;
        status: ConversationStatus;
        now: string;
      }>(`
        INSERT INTO email_conversations (
          gmail_thread_id,
          root_provider_message_id,
          latest_provider_message_id,
          subject,
          summary,
          status,
          created_at,
          updated_at
        ) VALUES (
          @gmailThreadId,
          @providerMessageId,
          @providerMessageId,
          @subject,
          @summary,
          @status,
          @now,
          @now
        )
        ON CONFLICT (gmail_thread_id) DO UPDATE SET
          latest_provider_message_id = excluded.latest_provider_message_id,
          subject = excluded.subject,
          summary = excluded.summary,
          status = excluded.status,
          updated_at = excluded.updated_at
      `).run({ ...input, now });

      this.#database.prepare<{
        providerMessageId: string;
        gmailThreadId: string;
        now: string;
      }>(`
        INSERT INTO email_conversation_messages (
          provider_message_id,
          gmail_thread_id,
          added_at
        ) VALUES (@providerMessageId, @gmailThreadId, @now)
        ON CONFLICT (provider_message_id) DO NOTHING
      `).run({
        providerMessageId: input.providerMessageId,
        gmailThreadId: input.gmailThreadId,
        now,
      });

      return this.#findByGmailThreadIdSync(input.gmailThreadId);
    });

    return transaction();
  }

  async attachEmail(gmailThreadId: string, providerMessageId: string) {
    const now = new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      const attached = this.#database.prepare<{
        providerMessageId: string;
        gmailThreadId: string;
        now: string;
      }>(`
        INSERT INTO email_conversation_messages (
          provider_message_id,
          gmail_thread_id,
          added_at
        ) VALUES (@providerMessageId, @gmailThreadId, @now)
        ON CONFLICT (provider_message_id) DO NOTHING
      `).run({ providerMessageId, gmailThreadId, now });
      this.#database.prepare<{
        providerMessageId: string;
        gmailThreadId: string;
        now: string;
      }>(`
        UPDATE email_conversations
        SET latest_provider_message_id = @providerMessageId, updated_at = @now
        WHERE gmail_thread_id = @gmailThreadId
      `).run({ providerMessageId, gmailThreadId, now });
      return attached.changes === 1;
    });
    return transaction();
  }

  async findByGmailThreadId(gmailThreadId: string) {
    return this.#findByGmailThreadIdSync(gmailThreadId);
  }

  async findByDiscordThreadId(discordThreadId: string) {
    const row = this.#database.prepare<[string], ConversationRow>(`
      ${selectConversation}
      WHERE discord_thread_id = ?
    `).get(discordThreadId);
    return row ? mapConversation(row) : null;
  }

  async findByProviderMessageId(providerMessageId: string) {
    const row = this.#database.prepare<[string], ConversationRow>(`
      ${selectConversation}
      INNER JOIN email_conversation_messages AS messages
        ON messages.gmail_thread_id = email_conversations.gmail_thread_id
      WHERE messages.provider_message_id = ?
    `).get(providerMessageId);
    return row ? mapConversation(row) : null;
  }

  async listUnpublished(limit: number) {
    requireLimit(limit);
    return this.#database.prepare<[number], ConversationRow>(`
      ${selectConversation}
      WHERE parent_message_id IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit).map(mapConversation);
  }

  async savePublication(
    gmailThreadId: string,
    channelId: string,
    parentMessageId: string,
    discordThreadId: string,
  ) {
    const result = this.#database.prepare<{
      gmailThreadId: string;
      channelId: string;
      parentMessageId: string;
      discordThreadId: string;
      now: string;
    }>(`
      UPDATE email_conversations
      SET channel_id = @channelId,
          parent_message_id = @parentMessageId,
          discord_thread_id = @discordThreadId,
          rendered_status = NULL,
          updated_at = @now
      WHERE gmail_thread_id = @gmailThreadId
        AND parent_message_id IS NULL
    `).run({
      gmailThreadId,
      channelId,
      parentMessageId,
      discordThreadId,
      now: new Date().toISOString(),
    });
    return result.changes === 1;
  }

  async setStatus(gmailThreadId: string, status: ConversationStatus) {
    const result = this.#database.prepare<{
      gmailThreadId: string;
      status: ConversationStatus;
      now: string;
    }>(`
      UPDATE email_conversations
      SET status = @status, updated_at = @now
      WHERE gmail_thread_id = @gmailThreadId
    `).run({ gmailThreadId, status, now: new Date().toISOString() });
    return result.changes === 1;
  }

  async setStatusByProviderMessageId(
    providerMessageId: string,
    status: ConversationStatus,
  ) {
    const result = this.#database.prepare<{
      providerMessageId: string;
      status: ConversationStatus;
      now: string;
    }>(`
      UPDATE email_conversations
      SET status = @status, updated_at = @now
      WHERE gmail_thread_id = (
        SELECT gmail_thread_id
        FROM email_conversation_messages
        WHERE provider_message_id = @providerMessageId
      )
    `).run({ providerMessageId, status, now: new Date().toISOString() });
    return result.changes === 1;
  }

  async listNeedingRender(limit: number) {
    requireLimit(limit);
    return this.#database.prepare<[number], ConversationRow>(`
      ${selectConversation}
      WHERE parent_message_id IS NOT NULL
        AND (rendered_status IS NULL OR rendered_status <> status)
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(limit).map(mapConversation);
  }

  async markRendered(gmailThreadId: string, status: ConversationStatus) {
    const result = this.#database.prepare<{
      gmailThreadId: string;
      status: ConversationStatus;
      now: string;
    }>(`
      UPDATE email_conversations
      SET rendered_status = @status, updated_at = @now
      WHERE gmail_thread_id = @gmailThreadId AND status = @status
    `).run({ gmailThreadId, status, now: new Date().toISOString() });
    return result.changes === 1;
  }

  async listInboundNeedingPublication(gmailThreadId: string) {
    return this.#database.prepare<[string], { provider_message_id: string }>(`
      SELECT messages.provider_message_id
      FROM email_conversation_messages AS messages
      LEFT JOIN discord_inbound_publications AS publication
        ON publication.provider_message_id = messages.provider_message_id
       AND publication.page = 0
      INNER JOIN email_messages AS email
        ON email.provider_message_id = messages.provider_message_id
      WHERE messages.gmail_thread_id = ?
        AND publication.provider_message_id IS NULL
      ORDER BY email.received_at ASC
    `).all(gmailThreadId).map((row) => row.provider_message_id);
  }

  async listInboundPublications(providerMessageId: string) {
    return this.#database.prepare<[string], InboundPublicationRow>(`
      SELECT provider_message_id, page, channel_id, message_id
      FROM discord_inbound_publications
      WHERE provider_message_id = ?
      ORDER BY page ASC
    `).all(providerMessageId).map(mapInboundPublication);
  }

  async saveInboundPublication(
    providerMessageId: string,
    page: number,
    channelId: string,
    messageId: string,
  ) {
    const result = this.#database.prepare<{
      providerMessageId: string;
      page: number;
      channelId: string;
      messageId: string;
      now: string;
    }>(`
      INSERT INTO discord_inbound_publications (
        provider_message_id, page, channel_id, message_id, posted_at
      ) VALUES (
        @providerMessageId, @page, @channelId, @messageId, @now
      )
      ON CONFLICT (provider_message_id, page) DO NOTHING
    `).run({
      providerMessageId,
      page,
      channelId,
      messageId,
      now: new Date().toISOString(),
    });
    return result.changes === 1;
  }

  #findByGmailThreadIdSync(gmailThreadId: string): EmailConversation | null {
    const row = this.#database.prepare<[string], ConversationRow>(`
      ${selectConversation}
      WHERE gmail_thread_id = ?
    `).get(gmailThreadId);
    return row ? mapConversation(row) : null;
  }

}

const selectConversation = `
  SELECT
    email_conversations.gmail_thread_id,
    email_conversations.root_provider_message_id,
    email_conversations.latest_provider_message_id,
    email_conversations.subject,
    email_conversations.summary,
    email_conversations.status,
    email_conversations.channel_id,
    email_conversations.parent_message_id,
    email_conversations.discord_thread_id,
    email_conversations.rendered_status,
    email_conversations.created_at,
    email_conversations.updated_at
  FROM email_conversations
`;

function mapConversation(row: ConversationRow): EmailConversation {
  return {
    gmailThreadId: row.gmail_thread_id,
    rootProviderMessageId: row.root_provider_message_id,
    latestProviderMessageId: row.latest_provider_message_id,
    subject: row.subject,
    summary: row.summary,
    status: row.status,
    channelId: row.channel_id,
    parentMessageId: row.parent_message_id,
    discordThreadId: row.discord_thread_id,
    renderedStatus: row.rendered_status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapInboundPublication(
  row: InboundPublicationRow,
): ConversationInboundPublication {
  return {
    providerMessageId: row.provider_message_id,
    page: row.page,
    channelId: row.channel_id,
    messageId: row.message_id,
  };
}

function requireLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Conversation query limit must be a positive integer");
  }
}
