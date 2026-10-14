import type { Migration } from "./types.js";

export const addSentEmailMetadataMigration: Migration = {
  version: 6,
  name: "add sent email metadata",
  sql: `
    ALTER TABLE email_messages
      ADD COLUMN sent_provider_message_id TEXT;

    ALTER TABLE email_messages
      ADD COLUMN sent_at TEXT;
  `,
};
