import type { Migration } from "./types.js";

export const addAssistantConversationsMigration: Migration = {
  version: 15,
  name: "add assistant conversations",
  sql: `
    CREATE TABLE assistant_inbound_messages (
      discord_message_id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX assistant_inbound_messages_status_idx
      ON assistant_inbound_messages (status, updated_at);

    CREATE TABLE assistant_conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      discord_message_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX assistant_conversation_messages_channel_idx
      ON assistant_conversation_messages (channel_id, id);
  `,
};
