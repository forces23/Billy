import { DateTime } from "luxon";

import type { AvailabilityService } from "./availability-service.js";
import type { CalendarEventRepository } from "../interfaces/calendar-event-repository.js";
import type { CalendarEventWrite, CalendarProvider } from "../interfaces/calendar-provider.js";
import type { ConversationRepository } from "../interfaces/conversation-repository.js";
import type { SchedulingRepository } from "../interfaces/scheduling-repository.js";

export class CalendarEventWorkflow {
  readonly #events: CalendarEventRepository;
  readonly #calendar: CalendarProvider;
  readonly #availability: AvailabilityService;
  readonly #scheduling: SchedulingRepository;
  readonly #conversations: ConversationRepository;

  constructor(
    events: CalendarEventRepository,
    calendar: CalendarProvider,
    availability: AvailabilityService,
    scheduling: SchedulingRepository,
    conversations: ConversationRepository,
  ) {
    this.#events = events;
    this.#calendar = calendar;
    this.#availability = availability;
    this.#scheduling = scheduling;
    this.#conversations = conversations;
  }

  async edit(sessionId: number, input: {
    title: string;
    localStart: string;
    timeZone: string;
    durationMinutes: number;
    description: string;
  }): Promise<boolean> {
    const current = await this.#events.findBySessionId(sessionId);
    if (!current) return false;
    const start = DateTime.fromISO(input.localStart, { zone: input.timeZone });
    if (!start.isValid || !DateTime.now().setZone(input.timeZone).isValid) {
      throw new Error("Enter a valid local date/time and IANA timezone");
    }
    if (!input.title.trim()) throw new Error("Calendar event title is required");
    if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 480) {
      throw new Error("Duration must be between 1 and 480 minutes");
    }
    const event: CalendarEventWrite = {
      ...current.event,
      title: input.title.trim(),
      description: input.description.trim(),
      start: start.toUTC().toISO()!,
      end: start.plus({ minutes: input.durationMinutes }).toUTC().toISO()!,
      timeZone: input.timeZone,
    };
    const conflicted = !(await this.#availability.isStillAvailable(
      {
        start: event.start,
        end: event.end,
        label: start.toFormat("ccc, LLL d 'at' h:mm a ZZZZ"),
      },
      undefined,
      current.googleEventId ?? undefined,
    ));
    return this.#events.updateProposal(sessionId, event, conflicted);
  }

  async create(
    sessionId: number,
    interactionId: string,
    overrideConflict: boolean,
  ): Promise<"created" | "conflict" | "unavailable"> {
    const record = await this.#events.findBySessionId(sessionId);
    if (!record || !["proposed", "conflicted"].includes(record.status)) {
      return "unavailable";
    }
    const slot = { start: record.event.start, end: record.event.end, label: record.event.start };
    const available = await this.#availability.isStillAvailable(slot);
    if (!available && !overrideConflict) {
      await this.#events.updateProposal(sessionId, record.event, true);
      return "conflict";
    }
    if (!(await this.#events.claimCreate(sessionId, interactionId, overrideConflict))) {
      return "unavailable";
    }
    try {
      const created = await this.#calendar.createEvent(record.event);
      await this.#events.markCreated(sessionId, created.providerEventId, created.htmlLink);
      const session = await this.#scheduling.findById(sessionId);
      if (session?.gmailThreadId) {
        await this.#conversations.setStatus(session.gmailThreadId, "scheduled");
      }
      return "created";
    } catch (error: unknown) {
      await this.#events.markFailed(
        sessionId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async update(sessionId: number, interactionId: string): Promise<boolean> {
    const record = await this.#events.findBySessionId(sessionId);
    if (!record?.googleEventId || record.status !== "update_proposed") return false;
    const available = await this.#availability.isStillAvailable(
      {
        start: record.event.start,
        end: record.event.end,
        label: record.event.start,
      },
      undefined,
      record.googleEventId,
    );
    if (!available) {
      await this.#events.updateProposal(sessionId, record.event, true);
      return false;
    }
    if (!(await this.#events.claimUpdate(sessionId, interactionId))) return false;
    const updated = await this.#calendar.updateEvent(record.googleEventId, record.event);
    if (!(await this.#events.markUpdated(sessionId, updated.htmlLink))) return false;
    const session = await this.#scheduling.findById(sessionId);
    if (session?.gmailThreadId) {
      await this.#conversations.setStatus(session.gmailThreadId, "scheduled");
    }
    return true;
  }

  async delete(sessionId: number, interactionId: string): Promise<boolean> {
    const record = await this.#events.findBySessionId(sessionId);
    if (
      !record?.googleEventId ||
      !["created", "cancel_proposed"].includes(record.status)
    ) return false;
    if (!(await this.#events.claimDelete(sessionId, interactionId))) return false;
    await this.#calendar.deleteEvent(record.googleEventId);
    await this.#events.markCancelled(sessionId);
    const session = await this.#scheduling.findById(sessionId);
    if (session?.gmailThreadId) {
      await this.#conversations.setStatus(session.gmailThreadId, "cancelled");
    }
    return true;
  }
}
