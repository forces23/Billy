import type { Logger } from "pino";
import { DateTime } from "luxon";

import type { AiProvider } from "../interfaces/ai-provider.js";
import type { TrustedSchedulingContext } from "../interfaces/ai-provider.js";
import type { DraftRepository, StoredDraft } from "../interfaces/draft-repository.js";
import type { EmailProvider } from "../interfaces/email-provider.js";
import type {
  SchedulingAnalysis,
  SchedulingGuard,
  SchedulingRepository,
  SchedulingSession,
  SchedulingSlot,
} from "../interfaces/scheduling-repository.js";
import type {
  SchedulingInterpreter,
  SchedulingRequest,
} from "../interfaces/scheduling-interpreter.js";
import type { AvailabilityService } from "./availability-service.js";
import type { RecipientResolver } from "./recipient-resolver.js";
import type { SchedulingReplyInterpreter } from "../interfaces/scheduling-reply-interpreter.js";
import type { ConversationRepository } from "../interfaces/conversation-repository.js";
import type {
  CalendarEventRecord,
  CalendarEventRepository,
} from "../interfaces/calendar-event-repository.js";
import type { StoredEmail, EmailRepository } from "../interfaces/email-repository.js";
import type { EmailMessage } from "../interfaces/email-provider.js";

export type SchedulingSelection =
  | "requested"
  | "multiple"
  | "clarify_timezone"
  | "reject"
  | number;

export type SchedulingSelectionResult =
  | { outcome: "drafted"; draft: StoredDraft }
  | { outcome: "conflict"; session: SchedulingSession }
  | { outcome: "rejected"; session: SchedulingSession }
  | { outcome: "unavailable" };

export class SchedulingWorkflow implements SchedulingGuard {
  readonly #interpreter: SchedulingInterpreter;
  readonly #availability: AvailabilityService;
  readonly #repository: SchedulingRepository;
  readonly #emailProvider: EmailProvider;
  readonly #draftRepository: DraftRepository;
  readonly #aiProvider: AiProvider;
  readonly #recipientResolver: RecipientResolver;
  readonly #timeZone: string;
  readonly #logger: Logger;
  readonly #replyInterpreter: SchedulingReplyInterpreter | undefined;
  readonly #conversationRepository: ConversationRepository | undefined;
  readonly #calendarEventRepository: CalendarEventRepository | undefined;
  readonly #emailRepository: EmailRepository | undefined;

  constructor(
    interpreter: SchedulingInterpreter,
    availability: AvailabilityService,
    repository: SchedulingRepository,
    emailProvider: EmailProvider,
    draftRepository: DraftRepository,
    aiProvider: AiProvider,
    recipientResolver: RecipientResolver,
    logger: Logger,
    timeZone: string,
    options: {
      replyInterpreter?: SchedulingReplyInterpreter;
      conversationRepository?: ConversationRepository;
      calendarEventRepository?: CalendarEventRepository;
      emailRepository?: EmailRepository;
    } = {},
  ) {
    this.#interpreter = interpreter;
    this.#availability = availability;
    this.#repository = repository;
    this.#emailProvider = emailProvider;
    this.#draftRepository = draftRepository;
    this.#aiProvider = aiProvider;
    this.#recipientResolver = recipientResolver;
    this.#logger = logger.child({ component: "scheduling-workflow" });
    this.#timeZone = timeZone;
    this.#replyInterpreter = options.replyInterpreter;
    this.#conversationRepository = options.conversationRepository;
    this.#calendarEventRepository = options.calendarEventRepository;
    this.#emailRepository = options.emailRepository;
  }

  async start(
    providerMessageId: string,
    input: {
      from: string;
      subject: string;
      body: string;
      anchor: Date;
      previousRequest?: SchedulingRequest;
    },
    signal?: AbortSignal,
  ): Promise<SchedulingSession> {
    const existing = await this.#repository.findByProviderMessageId(providerMessageId);
    if (existing) return existing;
    const request = await this.#interpreter.interpret({
      ...input,
      defaultTimeZone: this.#timeZone,
    }, signal);
    return this.#createSession(providerMessageId, request, input.anchor, signal);
  }

  async #createSession(
    providerMessageId: string,
    request: SchedulingRequest,
    anchor: Date,
    signal?: AbortSignal,
  ): Promise<SchedulingSession> {
    const analysis = await this.#availability.analyze(request, anchor, signal);
    const session = await this.#repository.createAndAwaitSelection(
      providerMessageId,
      request,
      analysis,
    );
    if (!session) throw new Error("Scheduling email left drafting before its session was saved");
    this.#logger.info({ providerMessageId, sessionId: session.id }, "Created calendar scheduling session");
    return session;
  }

  async updateFromConversation(
    sessionId: number,
    body: string,
    anchor: Date,
    signal?: AbortSignal,
  ): Promise<SchedulingSession | null> {
    const session = await this.#repository.findById(sessionId);
    if (!session || session.status !== "awaiting_selection") return null;
    const message = await this.#emailProvider.getEmailMessage(session.providerMessageId);
    const context = this.#recipientResolver.resolve(message);
    const request = await this.#interpreter.interpret({
      from: context.from.map(formatAddress).join(", ") || message.from,
      subject: context.subject,
      body,
      anchor,
      defaultTimeZone: this.#timeZone,
      previousRequest: session.request,
    }, signal);
    const analysis = await this.#availability.analyze(request, anchor, signal);
    const saved = await this.#repository.updateAnalysis(sessionId, request, analysis);
    return saved ? this.#repository.findById(sessionId) : null;
  }

  async updateCalendarFromConversation(
    sessionId: number,
    body: string,
    anchor: Date,
    signal?: AbortSignal,
  ): Promise<CalendarEventRecord | null> {
    if (!this.#calendarEventRepository) return null;
    const session = await this.#repository.findById(sessionId);
    const current = await this.#calendarEventRepository.findBySessionId(sessionId);
    if (
      !session ||
      !current ||
      !["proposed", "conflicted", "created", "update_proposed"].includes(
        current.status,
      )
    ) return null;

    const start = DateTime.fromISO(current.event.start, { setZone: true })
      .setZone(current.event.timeZone);
    const end = DateTime.fromISO(current.event.end, { setZone: true })
      .setZone(current.event.timeZone);
    const currentDate = start.toISODate();
    if (!start.isValid || !end.isValid || !currentDate) return null;

    const message = await this.#emailProvider.getEmailMessage(
      session.providerMessageId,
    );
    const context = this.#recipientResolver.resolve(message);
    const previousRequest: SchedulingRequest = {
      ...session.request,
      summary: current.event.title,
      requestedDates: [currentDate],
      requestedTime: start.toFormat("HH:mm"),
      timeZone: current.event.timeZone,
      durationMinutes: Math.max(1, Math.round(end.diff(start, "minutes").minutes)),
      availabilityOptionCount: 1,
    };
    const interpreted = await this.#interpreter.interpret({
      from: context.from.map(formatAddress).join(", ") || message.from,
      subject: context.subject,
      body,
      anchor,
      defaultTimeZone: this.#timeZone,
      previousRequest,
    }, signal);
    const request: SchedulingRequest = {
      ...interpreted,
      requestedDates: interpreted.requestedDates.length > 0
        ? interpreted.requestedDates
        : previousRequest.requestedDates,
      requestedTime: interpreted.requestedTime ?? previousRequest.requestedTime,
      timeZone: interpreted.timeZone ?? previousRequest.timeZone,
    };
    const analysis = await this.#availability.analyze(request, anchor, signal);
    if (!analysis.requestedSlot) return null;
    const requestedSlotAvailable = await this.#availability.isStillAvailable(
      analysis.requestedSlot,
      signal,
      current.googleEventId ?? undefined,
    );

    const updated = await this.#calendarEventRepository.updateProposal(
      sessionId,
      {
        ...current.event,
        title: request.summary.trim() || current.event.title,
        start: analysis.requestedSlot.start,
        end: analysis.requestedSlot.end,
        timeZone: request.timeZone ?? current.event.timeZone,
      },
      !requestedSlotAvailable,
    );
    if (!updated) return null;
    await this.#conversationRepository?.setStatusByProviderMessageId(
      session.providerMessageId,
      "calendar_event_awaiting_approval",
    );
    return this.#calendarEventRepository.findBySessionId(sessionId);
  }

  async selectCard(
    cardId: number,
    selection: SchedulingSelection,
    interactionId: string,
    signal?: AbortSignal,
  ): Promise<SchedulingSelectionResult> {
    const card = await this.#repository.findCardById(cardId);
    if (!card) return { outcome: "unavailable" };
    const session = await this.#repository.findById(card.sessionId);
    if (!session || session.status !== "awaiting_selection") {
      return { outcome: "unavailable" };
    }
    if (selection === "reject") {
      if (!(await this.#repository.rejectSession(session.id, interactionId))) {
        return { outcome: "unavailable" };
      }
      await this.#conversationRepository?.setStatusByProviderMessageId(
        session.providerMessageId,
        "rejected",
      );
      return {
        outcome: "rejected",
        session: (await this.#repository.findById(session.id)) ?? session,
      };
    }
    const offeredSlots = selection === "multiple"
      ? card.analysis.options.slice(
          0,
          Math.max(2, card.request.availabilityOptionCount ?? 3),
        )
      : [];
    const slot = resolveSlot(card.analysis, selection);
    if (selection !== "clarify_timezone") {
      const slotsToCheck = offeredSlots.length > 0
        ? offeredSlots
        : slot
          ? [slot]
          : [];
      const availability = await Promise.all(
        slotsToCheck.map((candidate) =>
          this.#availability.isStillAvailable(candidate, signal),
        ),
      );
      if (slotsToCheck.length === 0 || availability.some((value) => !value)) {
        const refreshed = await this.#availability.analyze(
          card.request,
          new Date(),
          signal,
        );
        await this.#repository.updateAnalysis(session.id, card.request, refreshed);
        return {
          outcome: "conflict",
          session: (await this.#repository.findById(session.id)) ?? session,
        };
      }
    }
    return this.#createDraftForSelection(
      session,
      card.analysis,
      selection,
      slot,
      offeredSlots,
      interactionId,
      signal,
    );
  }

  async #createDraftForSelection(
    session: SchedulingSession,
    analysis: SchedulingAnalysis,
    selection: SchedulingSelection,
    slot: SchedulingSlot | null,
    offeredSlots: readonly SchedulingSlot[],
    interactionId: string,
    signal?: AbortSignal,
  ): Promise<SchedulingSelectionResult> {
    const clarify = selection === "clarify_timezone";
    const claimed = await this.#repository.claimSelection(
      session.id,
      interactionId,
      slot,
      offeredSlots,
    );
    if (!claimed) return { outcome: "unavailable" };
    try {
      const message = await this.#emailProvider.getEmailMessage(session.providerMessageId);
      const context = this.#recipientResolver.resolve(message);
      const generated = await this.#aiProvider.generateReply({
        from: context.from.map(formatAddress).join(", ") || message.from,
        subject: context.subject,
        body: context.body,
        trustedSchedulingContext: clarify
          ? { action: "clarify_timezone", timeZone: this.#timeZone }
          : offeredSlots.length > 0
            ? {
                action: "propose_multiple",
                proposedSlots: offeredSlots.map((item) => ({
                  start: item.start,
                  end: item.end,
                  displayLabel: item.label,
                })),
                timeZone: this.#timeZone,
              }
          : {
              action: analysis.requestedSlot?.start === slot?.start ? "accept" : "propose",
              selectedStart: slot!.start,
              selectedEnd: slot!.end,
              displayLabel: slot!.label,
              timeZone: this.#timeZone,
            },
      }, signal);
      const draft = await this.#draftRepository.saveAndAwaitApproval(
        session.providerMessageId,
        generated,
      );
      if (!draft) throw new Error("Scheduling draft could not be saved");
      if (!(await this.#repository.markDrafted(session.id, draft.id))) {
        throw new Error("Scheduling draft link could not be saved");
      }
      await this.#conversationRepository?.setStatusByProviderMessageId(
        session.providerMessageId,
        "draft_awaiting_approval",
      );
      return { outcome: "drafted", draft };
    } catch (error: unknown) {
      const refreshed = await this.#availability.analyze(
        session.request,
        new Date(),
        signal,
      );
      await this.#repository.releaseSelection(
        session.id,
        refreshed,
        error instanceof Error ? error.message : "Draft generation failed",
      );
      await this.#conversationRepository?.setStatusByProviderMessageId(
        session.providerMessageId,
        "scheduling_needed",
      );
      throw error;
    }
  }

  async validateDraft(draftId: number, signal?: AbortSignal): Promise<boolean> {
    const session = await this.#repository.findSessionByDraftId(draftId);
    if (!session) return true;
    if (session.status !== "drafted") return false;
    const slots = session.selectedSlot
      ? [session.selectedSlot]
      : session.offeredSlots;
    if (slots.length === 0) return true;
    const available = await Promise.all(
      slots.map((slot) => this.#availability.isStillAvailable(slot, signal)),
    );
    if (available.every(Boolean)) return true;
    const refreshed = await this.#availability.analyze(
      session.request,
      new Date(),
      signal,
    );
    await this.#repository.reopenAfterConflict(session.id, refreshed);
    await this.#conversationRepository?.setStatusByProviderMessageId(
      session.providerMessageId,
      "scheduling_needed",
    );
    return false;
  }

  async getDraftContext(
    draftId: number,
  ): Promise<TrustedSchedulingContext | undefined> {
    const session = await this.#repository.findSessionByDraftId(draftId);
    if (!session) return undefined;
    if (!session.selectedSlot && session.offeredSlots.length === 0) {
      return { action: "clarify_timezone", timeZone: this.#timeZone };
    }
    if (!session.selectedSlot) {
      return {
        action: "propose_multiple",
        proposedSlots: session.offeredSlots.map((item) => ({
          start: item.start,
          end: item.end,
          displayLabel: item.label,
        })),
        timeZone: this.#timeZone,
      };
    }
    const requested = session.analysis.requestedSlot;
    return {
      action:
        requested?.start === session.selectedSlot.start ? "accept" : "propose",
      selectedStart: session.selectedSlot.start,
      selectedEnd: session.selectedSlot.end,
      displayLabel: session.selectedSlot.label,
      timeZone: this.#timeZone,
    };
  }

  async linkRevision(sourceDraftId: number, resultDraftId: number): Promise<boolean> {
    const session = await this.#repository.findSessionByDraftId(sourceDraftId);
    if (!session) return true;
    return this.#repository.linkDraft(session.id, resultDraftId);
  }

  async onDraftSent(draftId: number): Promise<void> {
    const session = await this.#repository.markReplySent(draftId);
    if (!session) return;
    const requestedSlot = session.analysis.requestedSlot;
    const acceptedRecruiterProposal =
      session.selectedSlot !== null &&
      requestedSlot !== null &&
      session.selectedSlot.start === requestedSlot.start &&
      session.selectedSlot.end === requestedSlot.end;
    if (
      acceptedRecruiterProposal &&
      session.selectedSlot &&
      this.#calendarEventRepository
    ) {
      const confirmed = await this.#repository.markRecruiterConfirmed(
        session.id,
        session.providerMessageId,
      );
      if (confirmed) {
        await this.#proposeCalendarEvent(
          session,
          session.selectedSlot,
          "Confirmed when Bobby sent an acceptance reply.",
        );
        return;
      }
    }
    await this.#conversationRepository?.setStatusByProviderMessageId(
      session.providerMessageId,
      "awaiting_recruiter_confirmation",
    );
  }

  async reconcileAcceptedRecruiterProposals(limit = 25): Promise<number> {
    if (!this.#calendarEventRepository) return 0;
    const sessions =
      await this.#repository.listAcceptedRecruiterProposalsWithoutCalendarEvent(
        limit,
      );
    for (const session of sessions) {
      if (!session.selectedSlot) continue;
      await this.#repository.markRecruiterConfirmed(
        session.id,
        session.providerMessageId,
      );
      await this.#proposeCalendarEvent(
        session,
        session.selectedSlot,
        "Confirmed when Bobby sent an acceptance reply.",
      );
    }
    return sessions.length;
  }

  async handleIncomingReply(
    email: StoredEmail,
    message: EmailMessage,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.#emailRepository) return false;
    const session = await this.#repository.findByGmailThreadId(email.threadId);
    if (!session || session.status !== "resolved") return false;

    if (isAwaitingTimezoneClarification(session)) {
      const context = this.#recipientResolver.resolve(message);
      const interpreted = await this.#interpreter.interpret({
        from: context.from.map(formatAddress).join(", ") || message.from,
        subject: context.subject,
        body: context.body,
        anchor: message.receivedAt,
        defaultTimeZone: this.#timeZone,
        previousRequest: session.request,
      }, signal);
      if (interpreted.timeZone === null) return false;
      const request = {
        ...interpreted,
        requestedDates: interpreted.requestedDates.length > 0
          ? interpreted.requestedDates
          : session.request.requestedDates,
        requestedTime: interpreted.requestedTime ?? session.request.requestedTime,
      };
      await this.#createSession(
        email.providerMessageId,
        request,
        message.receivedAt,
        signal,
      );
      await this.#attachIncomingSchedulingEmail(email, message);
      await this.#conversationRepository?.setStatus(
        email.threadId,
        "scheduling_needed",
      );
      return true;
    }

    if (!session.selectedSlot && session.offeredSlots.length === 0) return false;
    if (!this.#replyInterpreter) return false;
    const result = await this.#replyInterpreter.interpret({
      subject: message.subject,
      body: message.textBody,
      anchor: message.receivedAt,
      selectedSlot: session.selectedSlot,
      offeredSlots: session.offeredSlots,
      defaultTimeZone: this.#timeZone,
    }, signal);

    await this.#attachIncomingSchedulingEmail(email, message);

    let selectedSlot = session.selectedSlot;
    let selectedOfferedSlot: SchedulingSlot | null = null;
    if (
      !selectedSlot &&
      (result.intent === "confirmation" || result.intent === "counterproposal")
    ) {
      selectedOfferedSlot = resolveOfferedSlot(
        session.offeredSlots,
        result,
        result.timeZone ?? this.#timeZone,
        result.intent === "confirmation",
      );
      if (selectedOfferedSlot) {
        selectedSlot = selectedOfferedSlot;
        await this.#repository.selectOfferedSlot(session.id, selectedOfferedSlot);
      }
    }
    const selectedLocal = selectedSlot
      ? DateTime.fromISO(selectedSlot.start, { setZone: true })
          .setZone(result.timeZone ?? this.#timeZone)
      : null;
    const statedDifferentSlot =
      selectedLocal !== null && (
        (result.explicitDate !== null && result.explicitDate !== selectedLocal.toISODate()) ||
        (result.explicitTime !== null && result.explicitTime !== selectedLocal.toFormat("HH:mm"))
      );
    const unmatchedOfferedSlot =
      session.selectedSlot === null &&
      selectedSlot === null &&
      (result.explicitDate !== null || result.explicitTime !== null);
    const effectiveIntent = selectedOfferedSlot
      ? "confirmation"
      : result.intent === "confirmation" && (statedDifferentSlot || unmatchedOfferedSlot)
        ? "counterproposal"
        : result.intent;

    if (effectiveIntent === "counterproposal") {
      await this.start(email.providerMessageId, {
        from: message.from,
        subject: message.subject,
        body: message.textBody,
        anchor: message.receivedAt,
        previousRequest: counterproposalContext(session, this.#timeZone),
      }, signal);
      await this.#conversationRepository?.setStatus(
        email.threadId,
        "scheduling_needed",
      );
      return true;
    }

    if (
      effectiveIntent === "confirmation" &&
      result.confidence >= 0.7 &&
      selectedSlot
    ) {
      const confirmed = await this.#repository.markRecruiterConfirmed(
        session.id,
        email.providerMessageId,
      );
      if (confirmed && this.#calendarEventRepository) {
        await this.#proposeCalendarEvent(
          session,
          selectedSlot,
          `Confirmed by email from ${message.from}.`,
          signal,
        );
      }
      await this.#emailRepository.markIgnored(
        email.providerMessageId,
        "drafting",
        "scheduling:recruiter_confirmed",
      );
      await this.#conversationRepository?.setStatus(
        email.threadId,
        "calendar_event_awaiting_approval",
      );
      return true;
    }

    if (effectiveIntent === "cancellation" && result.confidence >= 0.7) {
      await this.#repository.markCancelled(session.id, email.providerMessageId);
      await this.#emailRepository.markIgnored(
        email.providerMessageId,
        "drafting",
        "scheduling:cancellation",
      );
      const deleteProposed = await this.#calendarEventRepository?.proposeDelete(
        session.id,
      );
      await this.#conversationRepository?.setStatus(
        email.threadId,
        deleteProposed ? "calendar_event_awaiting_approval" : "cancelled",
      );
      return true;
    }

    await this.#repository.markConfirmationNeedsReview(
      session.id,
      email.providerMessageId,
    );
    await this.#emailRepository.markIgnored(
      email.providerMessageId,
      "drafting",
      `scheduling:${effectiveIntent}`,
    );
    await this.#conversationRepository?.setStatus(email.threadId, "needs_review");
    return true;
  }

  async #attachIncomingSchedulingEmail(
    email: StoredEmail,
    message: EmailMessage,
  ): Promise<void> {
    const conversation = await this.#conversationRepository?.findByGmailThreadId(
      email.threadId,
    );
    if (conversation) {
      await this.#conversationRepository?.attachEmail(
        email.threadId,
        email.providerMessageId,
      );
      return;
    }
    await this.#conversationRepository?.ensureForEmail({
      gmailThreadId: email.threadId,
      providerMessageId: email.providerMessageId,
      subject: message.subject,
      summary: "A reply arrived in an active scheduling conversation.",
      status: "processing",
    });
  }

  async #proposeCalendarEvent(
    session: SchedulingSession,
    slot: SchedulingSlot,
    description: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#calendarEventRepository) return;
    const event = {
      requestId: `scheduling-${session.id}`,
      title: session.request.summary || "Professional meeting",
      description,
      start: slot.start,
      end: slot.end,
      timeZone: this.#timeZone,
    };
    const existingEvent = session.gmailThreadId
      ? await this.#calendarEventRepository.proposeReschedule(
          session.gmailThreadId,
          session.id,
          event,
        )
      : null;
    const record = existingEvent ??
      await this.#calendarEventRepository.propose(session.id, event);
    if (!(await this.#availability.isStillAvailable(
      slot,
      signal,
      record.googleEventId ?? undefined,
    ))) {
      await this.#calendarEventRepository.updateProposal(
        session.id,
        event,
        true,
      );
    }
    await this.#conversationRepository?.setStatusByProviderMessageId(
      session.providerMessageId,
      "calendar_event_awaiting_approval",
    );
  }
}

function isAwaitingTimezoneClarification(
  session: SchedulingSession,
): boolean {
  return session.selectedSlot === null &&
    session.offeredSlots.length === 0 &&
    session.analysis.timezoneRequired &&
    session.request.requestedDates.length > 0 &&
    session.request.requestedTime !== null;
}

function counterproposalContext(
  session: SchedulingSession,
  timeZone: string,
): SchedulingRequest {
  if (!session.selectedSlot) return session.request;

  const selectedStart = DateTime.fromISO(session.selectedSlot.start, {
    setZone: true,
  }).setZone(timeZone);
  const selectedDate = selectedStart.toISODate();

  if (!selectedDate) return session.request;

  return {
    ...session.request,
    requestedDates: [selectedDate],
    requestedTime: selectedStart.toFormat("HH:mm"),
    timeZone,
    availabilityOptionCount: 1,
  };
}

function resolveSlot(
  analysis: SchedulingAnalysis,
  selection: SchedulingSelection,
): SchedulingSlot | null {
  if (selection === "requested") {
    return analysis.requestedSlotAvailable ? analysis.requestedSlot : null;
  }
  if (selection === "clarify_timezone" || selection === "reject") return null;
  if (selection === "multiple") return null;
  return analysis.options[selection] ?? null;
}

function resolveOfferedSlot(
  offeredSlots: readonly SchedulingSlot[],
  result: {
    referencesSelectedSlot: boolean;
    explicitDate: string | null;
    explicitTime: string | null;
    selectedOptionIndex?: number | null;
  },
  timeZone: string,
  trustSelectedOptionIndex = false,
): SchedulingSlot | null {
  if (
    Number.isInteger(result.selectedOptionIndex) &&
    result.selectedOptionIndex !== null &&
    result.selectedOptionIndex !== undefined
  ) {
    const indexedSlot = offeredSlots[result.selectedOptionIndex] ?? null;
    if (!indexedSlot) return null;
    if (trustSelectedOptionIndex) return indexedSlot;
    const indexedLocal = DateTime.fromISO(indexedSlot.start, { setZone: true })
      .setZone(timeZone);
    if (
      (result.explicitDate !== null &&
        result.explicitDate !== indexedLocal.toISODate()) ||
      (result.explicitTime !== null &&
        result.explicitTime !== indexedLocal.toFormat("HH:mm"))
    ) return null;
    return indexedSlot;
  }
  const matches = offeredSlots.filter((slot) => {
    const local = DateTime.fromISO(slot.start, { setZone: true }).setZone(timeZone);
    return (
      (result.explicitDate === null || result.explicitDate === local.toISODate()) &&
      (result.explicitTime === null || result.explicitTime === local.toFormat("HH:mm"))
    );
  });
  if (
    (result.explicitDate !== null || result.explicitTime !== null) &&
    matches.length === 1
  ) return matches[0] ?? null;
  if (result.referencesSelectedSlot && offeredSlots.length === 1) {
    return offeredSlots[0] ?? null;
  }
  return null;
}

function formatAddress(address: { name: string | null; address: string }): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}
