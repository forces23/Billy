import type { Migration } from "./types.js";

export const addVersionedDraftsMigration: Migration = {
  version: 4,
  name: "add versioned email drafts",
  sql: `
    ALTER TABLE email_messages RENAME TO email_messages_before_drafts;

    CREATE TABLE email_messages (
      provider_message_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      message_id_header TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'discovered'
        CHECK (status IN (
          'discovered',
          'drafting',
          'awaiting_approval',
          'approved',
          'sending',
          'sent',
          'failed',
          'rejected',
          'expired',
          'ignored'
        )),
      attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),
      last_error TEXT,
      ignored_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO email_messages (
      provider_message_id,
      thread_id,
      message_id_header,
      subject,
      received_at,
      status,
      attempt_count,
      last_error,
      ignored_reason,
      created_at,
      updated_at
    )
    SELECT
      provider_message_id,
      thread_id,
      message_id_header,
      subject,
      received_at,
      status,
      attempt_count,
      last_error,
      NULL,
      created_at,
      updated_at
    FROM email_messages_before_drafts;

    DROP TABLE email_messages_before_drafts;

    CREATE INDEX email_messages_status_received_at_idx
      ON email_messages (status, received_at);

    CREATE TABLE email_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_message_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      body TEXT NOT NULL CHECK (length(body) > 0),
      reviewer_note TEXT,
      provider_response_id TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      resolved_model TEXT NOT NULL,
      prompt_tokens INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
      completion_tokens INTEGER
        CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY (provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE CASCADE,
      UNIQUE (provider_message_id, revision)
    );

    CREATE INDEX email_drafts_provider_message_id_idx
      ON email_drafts (provider_message_id, revision);
  `,
};
