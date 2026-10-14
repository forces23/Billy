import type { Migration } from "./types.js";

export const initialMigration: Migration = {
  version: 1,
  name: "initial email processing state",
  sql: `
    CREATE TABLE email_messages (
      provider_message_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      message_id_header TEXT NOT NULL DEFAULT '',
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
          'expired'
        )),
      attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX email_messages_status_received_at_idx
      ON email_messages (status, received_at);
  `,
};
