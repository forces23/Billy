import type { Migration } from "./types.js";

export const addEmailSubjectMigration: Migration = {
  version: 2,
  name: "add email subject",
  sql: `
    ALTER TABLE email_messages
      ADD COLUMN subject TEXT NOT NULL DEFAULT '';
  `,
};
