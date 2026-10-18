-- Billy local-data reset for SQLite, intended to be run from DBeaver.
--
-- Before running:
--   1. Stop Billy so it cannot write to the database during this transaction.
--   2. Confirm this connection points to Billy's configured DATABASE_PATH.
--   3. Back up the database if any current state may be needed later.
--   4. Run this file as a script with "stop on error" enabled.
--
-- This preserves Billy's schema and schema_migrations history. It removes only
-- local application state. It does not delete Gmail messages, Discord messages
-- or threads, or events already created in Google Calendar.

PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

-- Refuse to arm the deletes unless this looks like a migrated Billy database.
CREATE TEMP TABLE billy_cleanup_guard (
  armed INTEGER NOT NULL CHECK (armed = 1)
);

INSERT INTO billy_cleanup_guard (armed)
SELECT CASE
  WHEN (
    SELECT COUNT(*)
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'schema_migrations',
        'email_messages',
        'email_drafts',
        'email_conversations',
        'scheduling_sessions',
        'calendar_event_records'
      )
  ) = 6
  AND EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE version >= 10
  )
  THEN 1
  ELSE 0
END;

-- Calendar and scheduling state.
DELETE FROM calendar_event_records
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM scheduling_availability_cards
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM scheduling_lifecycle
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM scheduling_turns
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM scheduling_draft_links
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM scheduling_sessions
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

-- Conversation and Discord publication state.
DELETE FROM discord_inbound_publications
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM email_conversation_messages
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM email_conversations
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM discord_generation_failure_publications
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM discord_draft_publications
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

-- Draft, review, and email-processing state.
DELETE FROM email_review_recipients
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM email_revision_requests
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM email_review_decisions
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM email_drafts
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DELETE FROM email_messages
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

-- Removing the checkpoint makes the next startup behave like a first poll.
DELETE FROM poll_checkpoints
WHERE EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

-- Reset local IDs for a genuinely clean development/test start.
DELETE FROM sqlite_sequence
WHERE name IN (
  'email_drafts',
  'email_revision_requests',
  'scheduling_sessions',
  'scheduling_turns',
  'scheduling_availability_cards'
)
AND EXISTS (SELECT 1 FROM billy_cleanup_guard WHERE armed = 1);

DROP TABLE billy_cleanup_guard;

COMMIT;

-- Both result sets should be empty/zero after a successful reset.
PRAGMA foreign_key_check;

SELECT 'email_messages' AS table_name, COUNT(*) AS row_count FROM email_messages
UNION ALL
SELECT 'email_drafts', COUNT(*) FROM email_drafts
UNION ALL
SELECT 'email_conversations', COUNT(*) FROM email_conversations
UNION ALL
SELECT 'scheduling_sessions', COUNT(*) FROM scheduling_sessions
UNION ALL
SELECT 'calendar_event_records', COUNT(*) FROM calendar_event_records
UNION ALL
SELECT 'poll_checkpoints', COUNT(*) FROM poll_checkpoints;
