import type { Migration } from "./types.js";

export const preserveCalendarEventBeforeReviewMigration: Migration = {
  version: 14,
  name: "preserve calendar event before review",
  sql: `
    ALTER TABLE calendar_event_records
      ADD COLUMN previous_event_json TEXT;
  `,
};
