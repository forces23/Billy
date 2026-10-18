import type { Migration } from "./types.js";

export const addMultipleSchedulingOptionsMigration: Migration = {
  version: 12,
  name: "add multiple scheduling options",
  sql: `
    ALTER TABLE scheduling_sessions
      ADD COLUMN offered_slots_json TEXT;
  `,
};
