import type { Migration } from "./types.js";

export const addDiscordApprovalsMigration: Migration = {
  version: 5,
  name: "add Discord approval state",
  sql: `
    CREATE TABLE discord_draft_publications (
      draft_id INTEGER PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      posted_at TEXT NOT NULL,
      FOREIGN KEY (draft_id)
        REFERENCES email_drafts (id)
        ON DELETE CASCADE
    );

    CREATE TABLE email_review_decisions (
      provider_message_id TEXT PRIMARY KEY NOT NULL,
      draft_id INTEGER NOT NULL,
      decision TEXT NOT NULL
        CHECK (decision IN ('approved_reply', 'approved_reply_all', 'do_not_reply')),
      reviewer_user_id TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      FOREIGN KEY (provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE CASCADE,
      FOREIGN KEY (draft_id)
        REFERENCES email_drafts (id)
        ON DELETE RESTRICT
    );

    CREATE TABLE email_review_recipients (
      provider_message_id TEXT NOT NULL,
      recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('to', 'cc')),
      position INTEGER NOT NULL CHECK (position >= 0),
      address TEXT NOT NULL,
      display_name TEXT,
      PRIMARY KEY (provider_message_id, recipient_kind, position),
      FOREIGN KEY (provider_message_id)
        REFERENCES email_review_decisions (provider_message_id)
        ON DELETE CASCADE
    );

    CREATE TABLE email_revision_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_interaction_id TEXT NOT NULL UNIQUE,
      source_draft_id INTEGER NOT NULL,
      result_draft_id INTEGER,
      reviewer_user_id TEXT NOT NULL,
      instructions TEXT NOT NULL CHECK (length(instructions) > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (source_draft_id)
        REFERENCES email_drafts (id)
        ON DELETE CASCADE,
      FOREIGN KEY (result_draft_id)
        REFERENCES email_drafts (id)
        ON DELETE SET NULL
    );

    CREATE INDEX email_revision_requests_source_draft_idx
      ON email_revision_requests (source_draft_id, created_at);
  `,
};
