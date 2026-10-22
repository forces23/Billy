import type { AvailabilityService } from "./availability-service.js";
import type { CalendarEventRepository } from "../interfaces/calendar-event-repository.js";
import type { CalendarProvider } from "../interfaces/calendar-provider.js";
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

  async reject(sessionId: number, interactionId: string): Promise<boolean> {
    if (!(await this.#events.rejectProposal(sessionId, interactionId))) return false;
    const session = await this.#scheduling.findById(sessionId);
    const record = await this.#events.findBySessionId(sessionId);
    if (session?.gmailThreadId) {
      await this.#conversations.setStatus(
        session.gmailThreadId,
        record?.status === "created" ? "scheduled" : "rejected",
      );
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
