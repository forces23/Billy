import type Database from "better-sqlite3";

import type {
  CalendarEventRecord,
  CalendarEventRecordStatus,
  CalendarEventRepository,
} from "../../interfaces/calendar-event-repository.js";
import type { CalendarEventWrite } from "../../interfaces/calendar-provider.js";

interface Row {
  session_id: number;
  status: CalendarEventRecordStatus;
  event_json: string;
  google_event_id: string | null;
  google_event_link: string | null;
  discord_message_id: string | null;
  override_conflict: number;
  last_error: string | null;
}

export class SqliteCalendarEventRepository implements CalendarEventRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  async propose(sessionId: number, event: CalendarEventWrite) {
    const now = new Date().toISOString();
    this.#database.prepare<{
      sessionId: number; requestId: string; event: string; now: string;
    }>(`
      INSERT INTO calendar_event_records (
        session_id, status, event_request_id, event_json, created_at, updated_at
      ) VALUES (@sessionId, 'proposed', @requestId, @event, @now, @now)
      ON CONFLICT (session_id) DO UPDATE SET
        status = CASE WHEN calendar_event_records.status = 'created' THEN 'update_proposed' ELSE 'proposed' END,
        event_json = excluded.event_json,
        discord_message_id = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run({ sessionId, requestId: event.requestId, event: JSON.stringify(event), now });
    return (await this.findBySessionId(sessionId))!;
  }

  async proposeReschedule(
    gmailThreadId: string,
    sessionId: number,
    event: CalendarEventWrite,
  ) {
    const now = new Date().toISOString();
    const transfer = this.#database.transaction(() => {
      const previous = this.#database.prepare<
        [string, number],
        { session_id: number }
      >(`
        SELECT calendar_event_records.session_id
        FROM calendar_event_records
        INNER JOIN scheduling_sessions
          ON scheduling_sessions.id = calendar_event_records.session_id
        WHERE scheduling_sessions.gmail_thread_id = ?
          AND calendar_event_records.session_id <> ?
          AND calendar_event_records.status = 'created'
          AND calendar_event_records.google_event_id IS NOT NULL
        ORDER BY calendar_event_records.updated_at DESC
        LIMIT 1
      `).get(gmailThreadId, sessionId);
      if (!previous) return false;

      const result = this.#database.prepare<{
        previousSessionId: number;
        sessionId: number;
        requestId: string;
        event: string;
        now: string;
      }>(`
        UPDATE calendar_event_records
        SET
          session_id = @sessionId,
          status = 'update_proposed',
          event_request_id = @requestId,
          event_json = @event,
          approval_interaction_id = NULL,
          discord_message_id = NULL,
          override_conflict = 0,
          last_error = NULL,
          updated_at = @now
        WHERE session_id = @previousSessionId
          AND status = 'created'
          AND google_event_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM calendar_event_records
            WHERE session_id = @sessionId
          )
      `).run({
        previousSessionId: previous.session_id,
        sessionId,
        requestId: event.requestId,
        event: JSON.stringify(event),
        now,
      });
      return result.changes === 1;
    });

    return transfer() ? this.findBySessionId(sessionId) : null;
  }

  async findBySessionId(sessionId: number) {
    const row = this.#database.prepare<[number], Row>(`${selectRecord} WHERE session_id = ?`).get(sessionId);
    return row ? mapRow(row) : null;
  }

  async listUnpublished(limit: number) {
    return this.#database.prepare<[number], Row>(`
      ${selectRecord}
      WHERE discord_message_id IS NULL
        AND status IN ('proposed', 'conflicted', 'update_proposed', 'cancel_proposed')
      ORDER BY created_at ASC LIMIT ?
    `).all(limit).map(mapRow);
  }

  async savePublication(sessionId: number, messageId: string) {
    const result = this.#database.prepare<[string, string, number]>(`
      UPDATE calendar_event_records SET discord_message_id = ?, updated_at = ?
      WHERE session_id = ? AND discord_message_id IS NULL
    `).run(messageId, new Date().toISOString(), sessionId);
    return result.changes === 1;
  }

  async updateProposal(sessionId: number, event: CalendarEventWrite, conflicted: boolean) {
    const result = this.#database.prepare<[CalendarEventRecordStatus, string, string, number]>(`
      UPDATE calendar_event_records
      SET status = CASE WHEN google_event_id IS NULL THEN ? ELSE 'update_proposed' END,
          event_json = ?, approval_interaction_id = NULL,
          discord_message_id = NULL, last_error = NULL, updated_at = ?
      WHERE session_id = ?
        AND status IN ('proposed', 'conflicted', 'created', 'update_proposed')
    `).run(conflicted ? "conflicted" : "proposed", JSON.stringify(event), new Date().toISOString(), sessionId);
    return result.changes === 1;
  }

  async proposeDelete(sessionId: number) {
    const result = this.#database.prepare<[string, number]>(`
      UPDATE calendar_event_records
      SET status = 'cancel_proposed', discord_message_id = NULL, updated_at = ?
      WHERE session_id = ? AND status = 'created' AND google_event_id IS NOT NULL
    `).run(new Date().toISOString(), sessionId);
    return result.changes === 1;
  }

  async claimCreate(sessionId: number, interactionId: string, overrideConflict: boolean) {
    const allowed = overrideConflict ? "('proposed', 'conflicted')" : "('proposed')";
    const result = this.#database.prepare(`
      UPDATE calendar_event_records
      SET status = 'creating', approval_interaction_id = ?, override_conflict = ?, updated_at = ?
      WHERE session_id = ? AND status IN ${allowed}
    `).run(interactionId, overrideConflict ? 1 : 0, new Date().toISOString(), sessionId);
    return result.changes === 1;
  }

  async markCreated(sessionId: number, providerEventId: string, htmlLink: string | null) {
    const result = this.#database.prepare<[string, string | null, string, number]>(`
      UPDATE calendar_event_records
      SET status = 'created', google_event_id = ?, google_event_link = ?,
          last_error = NULL, updated_at = ?
      WHERE session_id = ? AND status = 'creating'
    `).run(providerEventId, htmlLink, new Date().toISOString(), sessionId);
    return result.changes === 1;
  }

  async claimUpdate(sessionId: number, interactionId: string) {
    const result = this.#database.prepare<[string, string, number]>(`
      UPDATE calendar_event_records SET status = 'updating', approval_interaction_id = ?, updated_at = ?
      WHERE session_id = ? AND status = 'update_proposed' AND google_event_id IS NOT NULL
    `).run(interactionId, new Date().toISOString(), sessionId);
    return result.changes === 1;
  }

  async markUpdated(sessionId: number, htmlLink: string | null) {
    const result = this.#database.prepare<[string | null, string, number]>(`
      UPDATE calendar_event_records SET status = 'created', google_event_link = ?,
        last_error = NULL, discord_message_id = NULL, updated_at = ?
      WHERE session_id = ? AND status = 'updating'
    `).run(htmlLink, new Date().toISOString(), sessionId);
    return result.changes === 1;
  }

  async claimDelete(sessionId: number, interactionId: string) {
    const result = this.#database.prepare<[string, string, number]>(`
      UPDATE calendar_event_records SET status = 'cancelling', approval_interaction_id = ?, updated_at = ?
      WHERE session_id = ? AND status IN ('created', 'cancel_proposed') AND google_event_id IS NOT NULL
    `).run(interactionId, new Date().toISOString(), sessionId);
    return result.changes === 1;
  }

  async markCancelled(sessionId: number) {
    const result = this.#database.prepare<[string, number]>(`
      UPDATE calendar_event_records SET status = 'cancelled', discord_message_id = NULL,
        last_error = NULL, updated_at = ? WHERE session_id = ? AND status = 'cancelling'
    `).run(new Date().toISOString(), sessionId);
    return result.changes === 1;
  }

  async markFailed(sessionId: number, error: string) {
    const result = this.#database.prepare<[string, string, number]>(`
      UPDATE calendar_event_records SET status = 'failed', last_error = ?, updated_at = ?
      WHERE session_id = ?
    `).run(error.slice(0, 500), new Date().toISOString(), sessionId);
    return result.changes === 1;
  }
}

const selectRecord = `SELECT session_id, status, event_json, google_event_id,
  google_event_link, discord_message_id, override_conflict, last_error
  FROM calendar_event_records`;

function mapRow(row: Row): CalendarEventRecord {
  return {
    sessionId: row.session_id,
    status: row.status,
    event: JSON.parse(row.event_json) as CalendarEventWrite,
    googleEventId: row.google_event_id,
    googleEventLink: row.google_event_link,
    discordMessageId: row.discord_message_id,
    overrideConflict: row.override_conflict === 1,
    lastError: row.last_error,
  };
}
