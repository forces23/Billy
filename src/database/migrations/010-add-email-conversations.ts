import type { Migration } from "./types.js";

export const addEmailConversationsMigration: Migration = {
  version: 10,
  name: "add conversation centered email and calendar workflow",
  sql: `
    ALTER TABLE email_messages
      ADD COLUMN classification_summary TEXT;

    ALTER TABLE scheduling_sessions
      ADD COLUMN gmail_thread_id TEXT;

    ALTER TABLE scheduling_sessions
      ADD COLUMN reply_provider_message_id TEXT;

    UPDATE scheduling_sessions
    SET
      gmail_thread_id = (
        SELECT thread_id
        FROM email_messages
        WHERE provider_message_id = scheduling_sessions.provider_message_id
      ),
      reply_provider_message_id = provider_message_id;

    CREATE INDEX scheduling_sessions_gmail_thread_idx
      ON scheduling_sessions (gmail_thread_id, created_at DESC);

    CREATE TABLE email_conversations (
      gmail_thread_id TEXT PRIMARY KEY NOT NULL,
      root_provider_message_id TEXT NOT NULL,
      latest_provider_message_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'processing',
        'needs_review',
        'scheduling_needed',
        'draft_awaiting_approval',
        'queued',
        'sending',
        'sent',
        'awaiting_recruiter_confirmation',
        'recruiter_confirmed',
        'calendar_event_awaiting_approval',
        'scheduled',
        'rejected',
        'cancelled',
        'failed'
      )),
      channel_id TEXT,
      parent_message_id TEXT UNIQUE,
      discord_thread_id TEXT UNIQUE,
      rendered_status TEXT,
      ui_version INTEGER NOT NULL DEFAULT 2 CHECK (ui_version = 2),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (root_provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE CASCADE,
      FOREIGN KEY (latest_provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE CASCADE
    );

    CREATE INDEX email_conversations_status_idx
      ON email_conversations (status, updated_at);

    CREATE TABLE email_conversation_messages (
      provider_message_id TEXT PRIMARY KEY NOT NULL,
      gmail_thread_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      FOREIGN KEY (provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE CASCADE,
      FOREIGN KEY (gmail_thread_id)
        REFERENCES email_conversations (gmail_thread_id)
        ON DELETE CASCADE
    );

    CREATE TABLE discord_inbound_publications (
      provider_message_id TEXT NOT NULL,
      page INTEGER NOT NULL CHECK (page >= 0),
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      posted_at TEXT NOT NULL,
      PRIMARY KEY (provider_message_id, page),
      FOREIGN KEY (provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE CASCADE
    );

    CREATE TABLE scheduling_availability_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      request_json TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('email', 'reviewer', 'counterproposal', 'refresh')),
      discord_message_id TEXT UNIQUE,
      disabled_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id)
        REFERENCES scheduling_sessions (id)
        ON DELETE CASCADE,
      UNIQUE (session_id, version)
    );

    CREATE TABLE scheduling_lifecycle (
      session_id INTEGER PRIMARY KEY NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'awaiting_selection',
        'draft_awaiting_approval',
        'queued',
        'awaiting_recruiter_confirmation',
        'confirmation_needs_review',
        'recruiter_confirmed',
        'calendar_event_awaiting_approval',
        'scheduled',
        'cancel_pending',
        'cancelled',
        'failed'
      )),
      selected_slot_json TEXT,
      confirmation_provider_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id)
        REFERENCES scheduling_sessions (id)
        ON DELETE CASCADE,
      FOREIGN KEY (confirmation_provider_message_id)
        REFERENCES email_messages (provider_message_id)
        ON DELETE SET NULL
    );

    INSERT INTO scheduling_lifecycle (
      session_id,
      status,
      selected_slot_json,
      created_at,
      updated_at
    )
    SELECT
      id,
      CASE status
        WHEN 'awaiting_selection' THEN 'awaiting_selection'
        WHEN 'drafting' THEN 'draft_awaiting_approval'
        WHEN 'drafted' THEN 'draft_awaiting_approval'
        WHEN 'resolved' THEN 'awaiting_recruiter_confirmation'
        ELSE 'failed'
      END,
      selected_slot_json,
      created_at,
      updated_at
    FROM scheduling_sessions;

    INSERT INTO scheduling_availability_cards (
      session_id,
      version,
      request_json,
      analysis_json,
      source,
      discord_message_id,
      disabled_at,
      created_at
    )
    SELECT
      id,
      1,
      request_json,
      analysis_json,
      'email',
      NULL,
      CASE WHEN status = 'awaiting_selection' THEN NULL ELSE updated_at END,
      created_at
    FROM scheduling_sessions;

    CREATE TABLE calendar_event_records (
      session_id INTEGER PRIMARY KEY NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'proposed',
        'conflicted',
        'creating',
        'created',
        'update_proposed',
        'updating',
        'cancel_proposed',
        'cancelling',
        'cancelled',
        'failed'
      )),
      event_request_id TEXT NOT NULL UNIQUE,
      event_json TEXT NOT NULL,
      approval_interaction_id TEXT UNIQUE,
      google_event_id TEXT UNIQUE,
      google_event_link TEXT,
      discord_message_id TEXT UNIQUE,
      override_conflict INTEGER NOT NULL DEFAULT 0 CHECK (override_conflict IN (0, 1)),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id)
        REFERENCES scheduling_sessions (id)
        ON DELETE CASCADE
    );
  `,
};
