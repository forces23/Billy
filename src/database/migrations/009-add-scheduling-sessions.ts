import type { Migration } from "./types.js";

export const addSchedulingSessionsMigration: Migration = {
  version: 9,
  name: "add calendar scheduling sessions",
  sql: `
    CREATE TABLE scheduling_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_message_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN (
        'awaiting_selection', 'drafting', 'drafted', 'resolved', 'failed'
      )),
      request_json TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      selected_slot_json TEXT,
      selection_interaction_id TEXT UNIQUE,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE CASCADE
    );

    CREATE INDEX scheduling_sessions_status_idx
      ON scheduling_sessions (status, created_at);

    CREATE TABLE scheduling_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      discord_message_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id)
        REFERENCES scheduling_sessions (id)
        ON DELETE CASCADE
    );

    CREATE TABLE scheduling_draft_links (
      draft_id INTEGER PRIMARY KEY NOT NULL,
      session_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draft_id)
        REFERENCES email_drafts (id)
        ON DELETE CASCADE,
      FOREIGN KEY (session_id)
        REFERENCES scheduling_sessions (id)
        ON DELETE CASCADE
    );
  `,
};
