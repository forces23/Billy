import type Database from "better-sqlite3";

import type {
  SchedulingAnalysis,
  SchedulingAvailabilityCard,
  SchedulingRepository,
  SchedulingSession,
  SchedulingSessionStatus,
  SchedulingSlot,
} from "../../interfaces/scheduling-repository.js";
import type { SchedulingRequest } from "../../interfaces/scheduling-interpreter.js";

interface SessionRow {
  id: number;
  provider_message_id: string;
  gmail_thread_id: string | null;
  reply_provider_message_id: string | null;
  status: SchedulingSessionStatus;
  request_json: string;
  analysis_json: string;
  selected_slot_json: string | null;
  offered_slots_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface CardRow {
  id: number;
  session_id: number;
  version: number;
  request_json: string;
  analysis_json: string;
  source: SchedulingAvailabilityCard["source"];
  discord_message_id: string | null;
  disabled_at: string | null;
  created_at: string;
}

export class SqliteSchedulingRepository implements SchedulingRepository {
  readonly #database: Database.Database;
  readonly #createTransaction: (
    providerMessageId: string,
    request: SchedulingRequest,
    analysis: SchedulingAnalysis,
  ) => SchedulingSession | null;
  readonly #claimTransaction: (
    sessionId: number,
    interactionId: string,
    slot: SchedulingSlot | null,
    offeredSlots: readonly SchedulingSlot[],
  ) => boolean;
  readonly #draftedTransaction: (sessionId: number, draftId: number) => boolean;

  constructor(database: Database.Database) {
    this.#database = database;
    this.#createTransaction = database.transaction((providerMessageId, request, analysis) => {
      const now = new Date().toISOString();
      const transition = database.prepare<[string, string]>(`
        UPDATE email_messages
        SET status = 'ignored', ignored_reason = 'scheduling:awaiting_selection', updated_at = ?
        WHERE provider_message_id = ? AND status = 'drafting'
      `).run(now, providerMessageId);
      if (transition.changes !== 1) return null;
      const result = database.prepare<{
        providerMessageId: string; request: string; analysis: string; now: string;
      }>(`
        INSERT INTO scheduling_sessions (
          provider_message_id, status, request_json, analysis_json,
          gmail_thread_id, reply_provider_message_id, created_at, updated_at
        ) VALUES (
          @providerMessageId, 'awaiting_selection', @request, @analysis,
          (SELECT thread_id FROM email_messages WHERE provider_message_id = @providerMessageId),
          @providerMessageId, @now, @now
        )
      `).run({
        providerMessageId,
        request: JSON.stringify(request),
        analysis: JSON.stringify(analysis),
        now,
      });
      const sessionId = Number(result.lastInsertRowid);
      database.prepare<[number, string, string]>(`
        INSERT INTO scheduling_lifecycle (session_id, status, created_at, updated_at)
        VALUES (?, 'awaiting_selection', ?, ?)
      `).run(sessionId, now, now);
      database.prepare<[number, string, string, string]>(`
        INSERT INTO scheduling_availability_cards (
          session_id, version, request_json, analysis_json, source, created_at
        ) VALUES (?, 1, ?, ?, 'email', ?)
      `).run(sessionId, JSON.stringify(request), JSON.stringify(analysis), now);
      return this.#findByIdSync(sessionId);
    });
    this.#claimTransaction = database.transaction((sessionId, interactionId, slot, offeredSlots) => {
      const now = new Date().toISOString();
      const session = this.#findByIdSync(sessionId);
      if (!session || session.status !== "awaiting_selection") return false;
      const email = database.prepare<[string, string]>(`
        UPDATE email_messages
        SET status = 'drafting', ignored_reason = NULL, updated_at = ?
        WHERE provider_message_id = ? AND status = 'ignored'
      `).run(now, session.providerMessageId);
      if (email.changes !== 1) return false;
      const updated = database.prepare<{
        sessionId: number;
        interactionId: string;
        slot: string | null;
        offeredSlots: string | null;
        now: string;
      }>(`
        UPDATE scheduling_sessions
        SET status = 'drafting', selected_slot_json = @slot,
            offered_slots_json = @offeredSlots,
            selection_interaction_id = @interactionId, last_error = NULL, updated_at = @now
        WHERE id = @sessionId AND status = 'awaiting_selection'
      `).run({
        sessionId,
        interactionId,
        slot: slot ? JSON.stringify(slot) : null,
        offeredSlots: offeredSlots.length > 0 ? JSON.stringify(offeredSlots) : null,
        now,
      });
      if (updated.changes !== 1) throw new Error("Scheduling selection could not be claimed");
      database.prepare<[string | null, string, number]>(`
        UPDATE scheduling_lifecycle
        SET status = 'draft_awaiting_approval', selected_slot_json = ?, updated_at = ?
        WHERE session_id = ?
      `).run(slot ? JSON.stringify(slot) : null, now, sessionId);
      return true;
    });
    this.#draftedTransaction = database.transaction((sessionId, draftId) => {
      const now = new Date().toISOString();
      const update = database.prepare<[string, number]>(`
        UPDATE scheduling_sessions SET status = 'drafted', updated_at = ?
        WHERE id = ? AND status = 'drafting'
      `).run(now, sessionId);
      if (update.changes !== 1) return false;
      database.prepare<[number, number, string]>(`
        INSERT INTO scheduling_draft_links (draft_id, session_id, created_at)
        VALUES (?, ?, ?)
      `).run(draftId, sessionId, now);
      database.prepare<[string, number]>(`
        UPDATE scheduling_lifecycle SET status = 'draft_awaiting_approval', updated_at = ?
        WHERE session_id = ?
      `).run(now, sessionId);
      return true;
    });
  }

  async createAndAwaitSelection(providerMessageId: string, request: SchedulingRequest, analysis: SchedulingAnalysis) {
    return this.#createTransaction(providerMessageId, request, analysis);
  }
  async findById(id: number) { return this.#findByIdSync(id); }
  async findByProviderMessageId(providerMessageId: string) {
    const row = this.#database.prepare<[string], SessionRow>(`${selectSession} WHERE provider_message_id = ?`).get(providerMessageId);
    return row ? mapRow(row) : null;
  }
  async findByGmailThreadId(gmailThreadId: string) {
    const row = this.#database.prepare<[string], SessionRow>(`
      ${selectSession} WHERE gmail_thread_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(gmailThreadId);
    return row ? mapRow(row) : null;
  }
  async listAcceptedRecruiterProposalsWithoutCalendarEvent(limit: number) {
    return this.#database.prepare<[number], SessionRow>(`
      ${selectSession}
      JOIN scheduling_lifecycle AS lifecycle
        ON lifecycle.session_id = scheduling_sessions.id
      LEFT JOIN calendar_event_records AS calendar_event
        ON calendar_event.session_id = scheduling_sessions.id
      WHERE scheduling_sessions.status = 'resolved'
        AND lifecycle.status IN (
          'awaiting_recruiter_confirmation',
          'calendar_event_awaiting_approval'
        )
        AND calendar_event.session_id IS NULL
        AND scheduling_sessions.selected_slot_json IS NOT NULL
        AND json_extract(scheduling_sessions.selected_slot_json, '$.start') =
          json_extract(scheduling_sessions.analysis_json, '$.requestedSlot.start')
        AND json_extract(scheduling_sessions.selected_slot_json, '$.end') =
          json_extract(scheduling_sessions.analysis_json, '$.requestedSlot.end')
      ORDER BY scheduling_sessions.updated_at ASC
      LIMIT ?
    `).all(limit).map(mapRow);
  }
  async updateAnalysis(sessionId: number, request: SchedulingRequest, analysis: SchedulingAnalysis) {
    const now = new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      const result = this.#database.prepare<{
        sessionId: number; request: string; analysis: string; now: string;
      }>(`
        UPDATE scheduling_sessions
        SET request_json = @request, analysis_json = @analysis,
            updated_at = @now
        WHERE id = @sessionId AND status = 'awaiting_selection'
      `).run({ sessionId, request: JSON.stringify(request), analysis: JSON.stringify(analysis), now });
      if (result.changes !== 1) return false;
      this.#database.prepare<{
        sessionId: number; request: string; analysis: string; now: string;
      }>(`
        INSERT INTO scheduling_availability_cards (
          session_id, version, request_json, analysis_json, source, created_at
        ) VALUES (
          @sessionId,
          (SELECT COALESCE(MAX(version), 0) + 1 FROM scheduling_availability_cards WHERE session_id = @sessionId),
          @request, @analysis, 'reviewer', @now
        )
      `).run({ sessionId, request: JSON.stringify(request), analysis: JSON.stringify(analysis), now });
      return true;
    });
    return transaction();
  }
  async listUnpublishedCards(limit: number) {
    return this.#database.prepare<[number], CardRow>(`
      ${selectCard}
      JOIN scheduling_sessions AS session ON session.id = scheduling_availability_cards.session_id
      WHERE scheduling_availability_cards.discord_message_id IS NULL
        AND session.status = 'awaiting_selection'
      ORDER BY scheduling_availability_cards.created_at ASC
      LIMIT ?
    `).all(limit).map(mapCard);
  }
  async findCardById(cardId: number) {
    const row = this.#database.prepare<[number], CardRow>(
      `${selectCard} WHERE scheduling_availability_cards.id = ?`,
    ).get(cardId);
    return row ? mapCard(row) : null;
  }
  async findLatestCard(sessionId: number) {
    const row = this.#database.prepare<[number], CardRow>(`
      ${selectCard}
      WHERE scheduling_availability_cards.session_id = ?
      ORDER BY scheduling_availability_cards.version DESC
      LIMIT 1
    `).get(sessionId);
    return row ? mapCard(row) : null;
  }
  async saveCardPublication(cardId: number, discordMessageId: string) {
    const result = this.#database.prepare<[string, number]>(`
      UPDATE scheduling_availability_cards
      SET discord_message_id = ?
      WHERE id = ? AND discord_message_id IS NULL
    `).run(discordMessageId, cardId);
    return result.changes === 1;
  }
  async claimSelection(
    sessionId: number,
    interactionId: string,
    slot: SchedulingSlot | null,
    offeredSlots: readonly SchedulingSlot[] = [],
  ) {
    return this.#claimTransaction(sessionId, interactionId, slot, offeredSlots);
  }
  async rejectSession(sessionId: number, interactionId: string) {
    const now = new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      const session = this.#findByIdSync(sessionId);
      if (!session || session.status !== "awaiting_selection") return false;
      const email = this.#database.prepare<[string, string]>(`
        UPDATE email_messages
        SET status = 'rejected', ignored_reason = 'scheduling:rejected_by_reviewer',
            last_error = NULL, updated_at = ?
        WHERE provider_message_id = ? AND status = 'ignored'
      `).run(now, session.providerMessageId);
      if (email.changes !== 1) return false;
      const updated = this.#database.prepare<{
        sessionId: number;
        interactionId: string;
        now: string;
      }>(`
        UPDATE scheduling_sessions
        SET status = 'resolved', selection_interaction_id = @interactionId,
            last_error = NULL, updated_at = @now
        WHERE id = @sessionId AND status = 'awaiting_selection'
      `).run({ sessionId, interactionId, now });
      if (updated.changes !== 1) {
        throw new Error("Scheduling rejection could not be saved");
      }
      this.#database.prepare<[string, number]>(`
        UPDATE scheduling_lifecycle
        SET status = 'cancelled', updated_at = ?
        WHERE session_id = ? AND status = 'awaiting_selection'
      `).run(now, sessionId);
      this.#database.prepare<[string, number]>(`
        UPDATE scheduling_availability_cards
        SET disabled_at = ?
        WHERE session_id = ? AND disabled_at IS NULL
      `).run(now, sessionId);
      return true;
    });
    return transaction();
  }
  async selectOfferedSlot(sessionId: number, slot: SchedulingSlot) {
    const serialized = JSON.stringify(slot);
    const now = new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      const result = this.#database.prepare<[string, string, number]>(`
        UPDATE scheduling_sessions
        SET selected_slot_json = ?, updated_at = ?
        WHERE id = ? AND status = 'resolved' AND selected_slot_json IS NULL
      `).run(serialized, now, sessionId);
      if (result.changes !== 1) return false;
      this.#database.prepare<[string, string, number]>(`
        UPDATE scheduling_lifecycle
        SET selected_slot_json = ?, updated_at = ?
        WHERE session_id = ? AND status = 'awaiting_recruiter_confirmation'
      `).run(serialized, now, sessionId);
      return true;
    });
    return transaction();
  }
  async releaseSelection(sessionId: number, analysis: SchedulingAnalysis, error?: string) {
    const session = this.#findByIdSync(sessionId);
    if (!session || session.status !== "drafting") return false;
    const now = new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      this.#database.prepare<[string, string]>(`
        UPDATE email_messages SET status = 'ignored', ignored_reason = 'scheduling:awaiting_selection', updated_at = ?
        WHERE provider_message_id = ? AND status = 'drafting'
      `).run(now, session.providerMessageId);
      const released = this.#database.prepare<{
        sessionId: number; analysis: string; error: string | null; now: string;
      }>(`
        UPDATE scheduling_sessions
        SET status = 'awaiting_selection', analysis_json = @analysis,
            selected_slot_json = NULL, selection_interaction_id = NULL,
            offered_slots_json = NULL,
            last_error = @error, updated_at = @now
        WHERE id = @sessionId AND status = 'drafting'
      `).run({ sessionId, analysis: JSON.stringify(analysis), error: error ?? null, now }).changes === 1;
      if (released) {
        this.#database.prepare<[string, number]>(`
          UPDATE scheduling_lifecycle
          SET status = 'awaiting_selection', selected_slot_json = NULL, updated_at = ?
          WHERE session_id = ?
        `).run(now, sessionId);
      }
      return released;
    });
    return transaction();
  }
  async markDrafted(sessionId: number, draftId: number) {
    return this.#draftedTransaction(sessionId, draftId);
  }
  async linkDraft(sessionId: number, draftId: number) {
    const result = this.#database.prepare<[number, number, string]>(`
      INSERT INTO scheduling_draft_links (draft_id, session_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT (draft_id) DO NOTHING
    `).run(draftId, sessionId, new Date().toISOString());
    return result.changes === 1;
  }
  async findSessionByDraftId(draftId: number) {
    const row = this.#database.prepare<[number], SessionRow>(`
      ${selectSession}
      JOIN scheduling_draft_links AS link ON link.session_id = scheduling_sessions.id
      WHERE link.draft_id = ?
    `).get(draftId);
    return row ? mapRow(row) : null;
  }
  async markReplySent(draftId: number) {
    const session = await this.findSessionByDraftId(draftId);
    if (!session) return null;
    const now = new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      this.#database.prepare<[string, number]>(`
        UPDATE scheduling_sessions SET status = 'resolved', updated_at = ?
        WHERE id = ? AND status = 'drafted'
      `).run(now, session.id);
      this.#database.prepare<[string, number]>(`
        UPDATE scheduling_lifecycle
        SET status = 'awaiting_recruiter_confirmation', updated_at = ?
        WHERE session_id = ?
      `).run(now, session.id);
    });
    transaction();
    return this.#findByIdSync(session.id);
  }
  async markRecruiterConfirmed(sessionId: number, providerMessageId: string) {
    const result = this.#database.prepare<[string, string, number]>(`
      UPDATE scheduling_lifecycle
      SET status = 'calendar_event_awaiting_approval',
          confirmation_provider_message_id = ?, updated_at = ?
      WHERE session_id = ? AND status = 'awaiting_recruiter_confirmation'
    `).run(providerMessageId, new Date().toISOString(), sessionId);
    return result.changes === 1;
  }
  async markConfirmationNeedsReview(sessionId: number, providerMessageId: string) {
    const result = this.#database.prepare<[string, string, number]>(`
      UPDATE scheduling_lifecycle
      SET status = 'confirmation_needs_review',
          confirmation_provider_message_id = ?, updated_at = ?
      WHERE session_id = ? AND status = 'awaiting_recruiter_confirmation'
    `).run(providerMessageId, new Date().toISOString(), sessionId);
    return result.changes === 1;
  }
  async markCancelled(sessionId: number, providerMessageId: string) {
    const result = this.#database.prepare<[string, string, number]>(`
      UPDATE scheduling_lifecycle
      SET status = 'cancelled', confirmation_provider_message_id = ?, updated_at = ?
      WHERE session_id = ? AND status IN ('awaiting_recruiter_confirmation', 'calendar_event_awaiting_approval')
    `).run(providerMessageId, new Date().toISOString(), sessionId);
    return result.changes === 1;
  }
  async reopenAfterConflict(sessionId: number, analysis: SchedulingAnalysis) {
    const session = this.#findByIdSync(sessionId);
    if (!session) return false;
    const now = new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      this.#database.prepare<[string]>(`
        DELETE FROM email_review_decisions WHERE provider_message_id = ?
      `).run(session.providerMessageId);
      const email = this.#database.prepare<[string, string]>(`
        UPDATE email_messages
        SET status = 'ignored', ignored_reason = 'scheduling:awaiting_selection', updated_at = ?
        WHERE provider_message_id = ?
          AND status IN ('awaiting_approval', 'approved', 'sending')
      `).run(now, session.providerMessageId);
      const updated = this.#database.prepare<{
        sessionId: number; analysis: string; now: string;
      }>(`
        UPDATE scheduling_sessions
        SET status = 'awaiting_selection', analysis_json = @analysis,
            selected_slot_json = NULL, selection_interaction_id = NULL,
            offered_slots_json = NULL,
            last_error = 'Selected slot is no longer available', updated_at = @now
        WHERE id = @sessionId AND status = 'drafted'
      `).run({ sessionId, analysis: JSON.stringify(analysis), now });
      if (updated.changes === 1) {
        this.#database.prepare<[string, number]>(`
          UPDATE scheduling_lifecycle
          SET status = 'awaiting_selection', selected_slot_json = NULL, updated_at = ?
          WHERE session_id = ?
        `).run(now, sessionId);
      }
      return email.changes === 1 && updated.changes === 1;
    });
    return transaction();
  }
  async appendTurn(sessionId: number, discordMessageId: string, userId: string, role: "user" | "assistant", body: string) {
    const result = this.#database.prepare<{
      sessionId: number; discordMessageId: string; userId: string; role: string; body: string; now: string;
    }>(`
      INSERT INTO scheduling_turns (session_id, discord_message_id, user_id, role, body, created_at)
      VALUES (@sessionId, @discordMessageId, @userId, @role, @body, @now)
      ON CONFLICT (discord_message_id) DO NOTHING
    `).run({ sessionId, discordMessageId, userId, role, body, now: new Date().toISOString() });
    return result.changes === 1;
  }

  #findByIdSync(id: number): SchedulingSession | null {
    const row = this.#database.prepare<[number], SessionRow>(`${selectSession} WHERE id = ?`).get(id);
    return row ? mapRow(row) : null;
  }
}

const selectSession = `SELECT scheduling_sessions.id, scheduling_sessions.provider_message_id,
  scheduling_sessions.gmail_thread_id, scheduling_sessions.reply_provider_message_id,
  scheduling_sessions.status, scheduling_sessions.request_json, scheduling_sessions.analysis_json,
  scheduling_sessions.selected_slot_json, scheduling_sessions.offered_slots_json,
  scheduling_sessions.last_error, scheduling_sessions.created_at,
  scheduling_sessions.updated_at FROM scheduling_sessions`;

const selectCard = `SELECT scheduling_availability_cards.id,
  scheduling_availability_cards.session_id, scheduling_availability_cards.version,
  scheduling_availability_cards.request_json, scheduling_availability_cards.analysis_json,
  scheduling_availability_cards.source, scheduling_availability_cards.discord_message_id,
  scheduling_availability_cards.disabled_at, scheduling_availability_cards.created_at
  FROM scheduling_availability_cards`;

function mapRow(row: SessionRow): SchedulingSession {
  return {
    id: row.id,
    providerMessageId: row.provider_message_id,
    gmailThreadId: row.gmail_thread_id,
    replyProviderMessageId: row.reply_provider_message_id ?? row.provider_message_id,
    status: row.status,
    request: JSON.parse(row.request_json) as SchedulingRequest,
    analysis: JSON.parse(row.analysis_json) as SchedulingAnalysis,
    selectedSlot: row.selected_slot_json ? JSON.parse(row.selected_slot_json) as SchedulingSlot : null,
    offeredSlots: row.offered_slots_json
      ? JSON.parse(row.offered_slots_json) as SchedulingSlot[]
      : [],
    lastError: row.last_error,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapCard(row: CardRow): SchedulingAvailabilityCard {
  return {
    id: row.id,
    sessionId: row.session_id,
    version: row.version,
    request: JSON.parse(row.request_json) as SchedulingRequest,
    analysis: JSON.parse(row.analysis_json) as SchedulingAnalysis,
    source: row.source,
    discordMessageId: row.discord_message_id,
    disabledAt: row.disabled_at ? new Date(row.disabled_at) : null,
    createdAt: new Date(row.created_at),
  };
}
