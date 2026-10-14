import type { Migration } from "./types.js";

export const addFailureAndDiscordStatusMigration: Migration = {
  version: 7,
  name: "add failure metadata and Discord status tracking",
  sql: `
    ALTER TABLE email_messages
      ADD COLUMN failure_stage TEXT
        CHECK (failure_stage IS NULL OR failure_stage IN ('draft_generation', 'gmail_send'));

    ALTER TABLE email_messages
      ADD COLUMN failure_code TEXT;

    ALTER TABLE email_messages
      ADD COLUMN failure_user_message TEXT;

    ALTER TABLE email_messages
      ADD COLUMN last_failure_at TEXT;

    ALTER TABLE email_messages
      ADD COLUMN manual_retry_count INTEGER NOT NULL DEFAULT 0
        CHECK (manual_retry_count >= 0);

    UPDATE email_messages
    SET
      failure_stage = CASE
        WHEN EXISTS (
          SELECT 1
          FROM email_review_decisions AS decision
          WHERE decision.provider_message_id = email_messages.provider_message_id
            AND decision.decision IN ('approved_reply', 'approved_reply_all')
        ) THEN 'gmail_send'
        ELSE 'draft_generation'
      END,
      failure_code = 'legacy_failure',
      failure_user_message = CASE
        WHEN EXISTS (
          SELECT 1
          FROM email_review_decisions AS decision
          WHERE decision.provider_message_id = email_messages.provider_message_id
            AND decision.decision IN ('approved_reply', 'approved_reply_all')
        ) THEN 'Gmail could not send the approved reply.'
        ELSE 'OpenRouter could not generate a complete draft.'
      END,
      last_failure_at = updated_at
    WHERE status = 'failed';

    CREATE TABLE discord_generation_failure_publications (
      provider_message_id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      rendered_failure_at TEXT NOT NULL,
      resolved_at TEXT,
      posted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE CASCADE
    );

    ALTER TABLE discord_draft_publications
      ADD COLUMN rendered_delivery_status TEXT NOT NULL DEFAULT 'awaiting_approval'
        CHECK (rendered_delivery_status IN (
          'awaiting_approval',
          'queued',
          'sending',
          'sent',
          'failed'
        ));

    ALTER TABLE discord_draft_publications
      ADD COLUMN delivery_status_updated_at TEXT;
  `,
};
