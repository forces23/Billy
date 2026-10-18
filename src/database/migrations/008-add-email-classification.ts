import type { Migration } from "./types.js";

export const addEmailClassificationMigration: Migration = {
  version: 8,
  name: "add email and Gmail thread classification",
  sql: `
    ALTER TABLE email_messages
      ADD COLUMN classification_category TEXT
        CHECK (classification_category IS NULL OR classification_category IN (
          'recruiter_opportunity',
          'qualification_question',
          'interview_scheduling',
          'rejection',
          'job_alert',
          'advertisement',
          'scam',
          'other'
        ));

    ALTER TABLE email_messages
      ADD COLUMN classification_confidence REAL
        CHECK (
          classification_confidence IS NULL
          OR (classification_confidence >= 0 AND classification_confidence <= 1)
        );

    ALTER TABLE email_messages
      ADD COLUMN classification_reason TEXT;

    ALTER TABLE email_messages
      ADD COLUMN classification_requested_model TEXT;

    ALTER TABLE email_messages
      ADD COLUMN classification_resolved_model TEXT;

    ALTER TABLE email_messages
      ADD COLUMN classification_provider_response_id TEXT;

    ALTER TABLE email_messages
      ADD COLUMN classified_at TEXT;

    CREATE INDEX email_messages_thread_classified_at_idx
      ON email_messages (thread_id, classified_at DESC);
  `,
};
