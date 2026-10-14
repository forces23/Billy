import type { Migration } from "./types.js";

export const addPollCheckpointsMigration: Migration = {
  version: 3,
  name: "add poll checkpoints",
  sql: `
    CREATE TABLE poll_checkpoints (
      name TEXT PRIMARY KEY NOT NULL,
      checkpoint_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
};
