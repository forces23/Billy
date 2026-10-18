import type { Migration } from "./types.js";

export const allowSentConversationsMigration: Migration = {
  version: 13,
  name: "allow sent conversation status",
  sql: `
    DROP INDEX email_conversations_status_idx;

    ALTER TABLE email_conversation_messages
      RENAME TO email_conversation_messages_before_sent_status;

    ALTER TABLE email_conversations
      RENAME TO email_conversations_before_sent_status;

    CREATE TABLE email_conversations (
      gmail_thread_id TEXT PRIMARY KEY NOT NULL,
      root_provider_message_id TEXT NOT NULL,
      latest_provider_message_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'processing',
        'needs_review',
        'scheduling_needed',
        'draft_awaiting_approval',
        'queued',
        'sending',
        'sent',
        'awaiting_recruiter_confirmation',
        'recruiter_confirmed',
        'calendar_event_awaiting_approval',
        'scheduled',
        'rejected',
        'cancelled',
        'failed'
      )),
      channel_id TEXT,
      parent_message_id TEXT UNIQUE,
      discord_thread_id TEXT UNIQUE,
      rendered_status TEXT,
      ui_version INTEGER NOT NULL DEFAULT 2 CHECK (ui_version = 2),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (root_provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE CASCADE,
      FOREIGN KEY (latest_provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE CASCADE
    );

    INSERT INTO email_conversations (
      gmail_thread_id,
      root_provider_message_id,
      latest_provider_message_id,
      subject,
      summary,
      status,
      channel_id,
      parent_message_id,
      discord_thread_id,
      rendered_status,
      ui_version,
      created_at,
      updated_at
    )
    SELECT
      gmail_thread_id,
      root_provider_message_id,
      latest_provider_message_id,
      subject,
      summary,
      status,
      channel_id,
      parent_message_id,
      discord_thread_id,
      rendered_status,
      ui_version,
      created_at,
      updated_at
    FROM email_conversations_before_sent_status;

    CREATE INDEX email_conversations_status_idx
      ON email_conversations (status, updated_at);

    CREATE TABLE email_conversation_messages (
      provider_message_id TEXT PRIMARY KEY NOT NULL,
      gmail_thread_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      FOREIGN KEY (provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE CASCADE,
      FOREIGN KEY (gmail_thread_id)
        REFERENCES email_conversations (gmail_thread_id)
        ON DELETE CASCADE
    );

    INSERT INTO email_conversation_messages (
      provider_message_id,
      gmail_thread_id,
      added_at
    )
    SELECT
      provider_message_id,
      gmail_thread_id,
      added_at
    FROM email_conversation_messages_before_sent_status;

    DROP TABLE email_conversation_messages_before_sent_status;
    DROP TABLE email_conversations_before_sent_status;

    UPDATE email_conversations
    SET
      status = 'sent',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status IN ('sending', 'failed')
      AND EXISTS (
        SELECT 1
        FROM email_conversation_messages
        INNER JOIN email_messages
          ON email_messages.provider_message_id =
            email_conversation_messages.provider_message_id
        WHERE email_conversation_messages.gmail_thread_id =
          email_conversations.gmail_thread_id
          AND email_messages.status = 'sent'
      );
  `,
};
