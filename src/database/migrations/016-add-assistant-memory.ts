import type { Migration } from "./types.js";

export const addAssistantMemoryMigration: Migration = {
  version: 16,
  name: "add assistant memory and usage tracking",
  sql: `
    CREATE VIRTUAL TABLE assistant_conversation_fts USING fts5(
      body,
      content = 'assistant_conversation_messages',
      content_rowid = 'id',
      tokenize = 'unicode61'
    );

    INSERT INTO assistant_conversation_fts (rowid, body)
      SELECT id, body FROM assistant_conversation_messages;

    CREATE TRIGGER assistant_conversation_fts_insert
    AFTER INSERT ON assistant_conversation_messages BEGIN
      INSERT INTO assistant_conversation_fts (rowid, body)
      VALUES (new.id, new.body);
    END;

    CREATE TRIGGER assistant_conversation_fts_delete
    AFTER DELETE ON assistant_conversation_messages BEGIN
      INSERT INTO assistant_conversation_fts (
        assistant_conversation_fts,
        rowid,
        body
      ) VALUES ('delete', old.id, old.body);
    END;

    CREATE TRIGGER assistant_conversation_fts_update
    AFTER UPDATE ON assistant_conversation_messages BEGIN
      INSERT INTO assistant_conversation_fts (
        assistant_conversation_fts,
        rowid,
        body
      ) VALUES ('delete', old.id, old.body);
      INSERT INTO assistant_conversation_fts (rowid, body)
      VALUES (new.id, new.body);
    END;

    CREATE TABLE assistant_conversation_state (
      channel_id TEXT PRIMARY KEY NOT NULL,
      context_started_after_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE assistant_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_content TEXT NOT NULL,
      source_discord_message_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'forgotten')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (channel_id, normalized_content)
    );

    CREATE INDEX assistant_memories_channel_status_idx
      ON assistant_memories (channel_id, status, id);

    CREATE TABLE assistant_model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inbound_discord_message_id TEXT NOT NULL UNIQUE,
      provider_response_id TEXT,
      requested_model TEXT NOT NULL,
      resolved_model TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      reasoning_tokens INTEGER,
      cost_usd REAL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX assistant_model_usage_created_idx
      ON assistant_model_usage (created_at);
  `,
};
