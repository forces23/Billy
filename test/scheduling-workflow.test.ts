import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { AvailabilityService } from "../src/core/availability-service.js";
import { RecipientResolver } from "../src/core/recipient-resolver.js";
import { SchedulingWorkflow } from "../src/core/scheduling-workflow.js";
import { createDatabase } from "../src/database/connection.js";
import { SqliteDraftRepository } from "../src/database/repositories/draft-repository.js";
import { SqliteEmailRepository } from "../src/database/repositories/email-repository.js";
import { SqliteSchedulingRepository } from "../src/database/repositories/scheduling-repository.js";
import { SqliteConversationRepository } from "../src/database/repositories/conversation-repository.js";
import { SqliteCalendarEventRepository } from "../src/database/repositories/calendar-event-repository.js";
import type { GenerateReplyInput } from "../src/interfaces/ai-provider.js";
import type { EmailMessage, EmailProvider } from "../src/interfaces/email-provider.js";

test("accepting a recruiter-proposed time creates a calendar proposal after the reply is sent", async () => {
  const database = createDatabase(":memory:");
  try {
    const message: EmailMessage = {
      providerMessageId: "workflow-schedule",
      threadId: "thread-workflow",
      messageIdHeader: "<workflow@example.com>",
      from: "Recruiter <recruiter@example.com>",
      to: ["bobby@example.com"],
      cc: [],
      replyTo: [],
      subject: "Interview time",
      receivedAt: new Date("2026-10-14T12:00:00.000Z"),
      textBody: "Can we meet October 19 at 9 AM Central?",
      automationReason: null,
    };
    const emailProvider: EmailProvider = {
      async listEmailMessageIds() { return []; },
      async getEmailMessage() { return message; },
    };
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const schedules = new SqliteSchedulingRepository(database);
    const conversations = new SqliteConversationRepository(database);
    const calendarEvents = new SqliteCalendarEventRepository(database);
    const availability = new AvailabilityService(
      { async listEvents() { return []; } },
      {
        timeZone: "America/Chicago",
        workdayStartHour: 9,
        workdayEndHour: 18,
        defaultDurationMinutes: 30,
        bufferAfterMinutes: 15,
        searchBusinessDays: 10,
      },
    );
    let generationInput: GenerateReplyInput | undefined;
    const workflow = new SchedulingWorkflow(
      {
        async interpret(input) {
          if (input.body === "Move it to 10 AM.") {
            return {
              ...input.previousRequest!,
              requestedTime: "10:00",
              timeZone: null,
            };
          }
          return {
            summary: "Recruiter interview",
            requestedDates: ["2026-10-19"],
            requestedTime: "09:00",
            timeZone: "America/Chicago",
            durationMinutes: 30,
          };
        },
      },
      availability,
      schedules,
      emailProvider,
      drafts,
      {
        async generateReply(input) {
          generationInput = input;
          return {
            body: "October 19 at 9 AM Central works for me.\n\nKind Regards,\nBobby Lawson",
            reviewerNote: null,
            providerResponseId: "response-schedule",
            requestedModel: "test/model",
            resolvedModel: "test/model",
            promptTokens: 20,
            completionTokens: 20,
          };
        },
      },
      new RecipientResolver({
        ownAddresses: ["bobby@example.com"],
        trustedForwarderAddresses: ["personal@example.com"],
      }),
      pino({ level: "silent" }),
      "America/Chicago",
      {
        conversationRepository: conversations,
        calendarEventRepository: calendarEvents,
      },
    );

    await emails.register(message);
    await conversations.ensureForEmail({
      gmailThreadId: message.threadId,
      providerMessageId: message.providerMessageId,
      subject: message.subject,
      summary: "The recruiter proposed an interview time.",
      status: "processing",
    });
    await emails.claimForDrafting(message.providerMessageId);
    const session = await workflow.start(
      message.providerMessageId,
      {
        from: message.from,
        subject: message.subject,
        body: message.textBody,
        anchor: message.receivedAt,
      },
    );
    const card = await schedules.findLatestCard(session.id);
    const result = await workflow.selectCard(
      card!.id,
      "requested",
      "interaction-workflow",
    );

    assert.equal(result.outcome, "drafted");
    assert.equal(generationInput?.trustedSchedulingContext?.action, "accept");
    assert.equal(
      generationInput?.trustedSchedulingContext?.selectedStart,
      "2026-10-19T14:00:00.000Z",
    );
    assert.equal(
      (await emails.findByProviderMessageId(message.providerMessageId))?.status,
      "awaiting_approval",
    );
    assert.equal((await schedules.findById(session.id))?.status, "drafted");
    if (result.outcome !== "drafted") {
      assert.fail("Expected a scheduling draft");
    }
    await workflow.onDraftSent(result.draft.id);
    assert.equal(
      (await calendarEvents.findBySessionId(session.id))?.status,
      "proposed",
    );
    assert.equal(
      (await conversations.findByGmailThreadId(message.threadId))?.status,
      "calendar_event_awaiting_approval",
    );
    const updatedCalendar = await workflow.updateCalendarFromConversation(
      session.id,
      "Move it to 10 AM.",
      new Date("2026-10-14T13:00:00.000Z"),
    );
    assert.equal(updatedCalendar?.event.start, "2026-10-19T15:00:00.000Z");
    assert.equal(updatedCalendar?.event.end, "2026-10-19T15:30:00.000Z");
    assert.equal(updatedCalendar?.event.timeZone, "America/Chicago");
  } finally {
    database.close();
  }
});

test("a recruiter confirmation is attached to the active schedule and proposes an event", async () => {
  const database = createDatabase(":memory:");
  try {
    const original: EmailMessage = {
      providerMessageId: "original", threadId: "gmail-schedule", messageIdHeader: "<original@example.com>",
      from: "Recruiter <recruiter@example.com>", to: ["bobby@example.com"], cc: [], replyTo: [],
      subject: "Interview", receivedAt: new Date("2026-10-17T12:00:00.000Z"),
      textBody: "October 21 at noon Central?", automationReason: null,
    };
    const confirmation: EmailMessage = {
      ...original,
      providerMessageId: "confirmation",
      messageIdHeader: "<confirmation@example.com>",
      receivedAt: new Date("2026-10-18T12:00:00.000Z"),
      textBody: "That works. See you then.",
    };
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const schedules = new SqliteSchedulingRepository(database);
    const conversations = new SqliteConversationRepository(database);
    const calendarEvents = new SqliteCalendarEventRepository(database);
    await emails.register(original);
    await emails.claimForDrafting(original.providerMessageId);
    const analysis = {
      requestedSlot: { start: "2026-10-21T17:00:00.000Z", end: "2026-10-21T17:30:00.000Z", label: "Wed, Oct 21 at 12:00 PM–12:30 PM CDT" },
      requestedSlotAvailable: true, timezoneRequired: false, options: [], advisories: [], checkedAt: new Date().toISOString(),
    } as const;
    const session = await schedules.createAndAwaitSelection(original.providerMessageId, {
      summary: "Recruiter interview", requestedDates: ["2026-10-21"], requestedTime: "12:00",
      timeZone: "America/Chicago", durationMinutes: 30,
    }, analysis);
    await schedules.claimSelection(session!.id, "selection", analysis.requestedSlot);
    const draft = await drafts.saveAndAwaitApproval(original.providerMessageId, {
      body: "That works.", reviewerNote: null, providerResponseId: "reply", requestedModel: "test", resolvedModel: "test",
      promptTokens: null, completionTokens: null,
    });
    await schedules.markDrafted(session!.id, draft!.id);
    await schedules.markReplySent(draft!.id);
    await conversations.ensureForEmail({
      gmailThreadId: original.threadId, providerMessageId: original.providerMessageId,
      subject: original.subject, summary: "A recruiter proposed an interview.", status: "awaiting_recruiter_confirmation",
    });
    await emails.register(confirmation);
    await emails.claimForDrafting(confirmation.providerMessageId);

    const provider: EmailProvider = {
      async listEmailMessageIds() { return []; },
      async getEmailMessage(id) { return id === confirmation.providerMessageId ? confirmation : original; },
    };
    const availability = new AvailabilityService(
      { async listEvents() { return []; } } as never,
      { timeZone: "America/Chicago", workdayStartHour: 9, workdayEndHour: 18, defaultDurationMinutes: 30, bufferAfterMinutes: 15, searchBusinessDays: 10 },
    );
    const workflow = new SchedulingWorkflow(
      { async interpret() { throw new Error("not used"); } }, availability, schedules, provider, drafts,
      { async generateReply() { throw new Error("not used"); } },
      new RecipientResolver({ ownAddresses: ["bobby@example.com"], trustedForwarderAddresses: [] }),
      pino({ level: "silent" }), "America/Chicago",
      {
        replyInterpreter: { async interpret() { return { intent: "confirmation", confidence: 0.99, reason: "Accepted", referencesSelectedSlot: true, explicitDate: null, explicitTime: null, timeZone: null }; } },
        conversationRepository: conversations, calendarEventRepository: calendarEvents, emailRepository: emails,
      },
    );
    const stored = await emails.findByProviderMessageId(confirmation.providerMessageId);
    assert.equal(await workflow.handleIncomingReply(stored!, confirmation), true);
    assert.equal((await emails.findByProviderMessageId(confirmation.providerMessageId))?.ignoredReason, "scheduling:recruiter_confirmed");
    assert.equal((await calendarEvents.findBySessionId(session!.id))?.status, "proposed");
    assert.equal((await conversations.findByGmailThreadId(original.threadId))?.status, "calendar_event_awaiting_approval");
  } finally {
    database.close();
  }
});

test("selecting an offered time inherits its timezone and proceeds to calendar approval", async () => {
  const database = createDatabase(":memory:");
  try {
    const original: EmailMessage = {
      providerMessageId: "offered-times",
      threadId: "offered-times-thread",
      messageIdHeader: "<offered-times@example.com>",
      from: "Recruiter <recruiter@example.com>",
      to: ["bobby@example.com"],
      cc: [],
      replyTo: [],
      subject: "Interview",
      receivedAt: new Date("2026-10-21T14:16:10.000Z"),
      textBody: "What is your availability this week?",
      automationReason: null,
    };
    const confirmation: EmailMessage = {
      ...original,
      providerMessageId: "offered-time-confirmation",
      messageIdHeader: "<offered-time-confirmation@example.com>",
      receivedAt: new Date("2026-10-21T14:18:13.000Z"),
      textBody: "Friday at 9:30 AM works. I'll give you a call then.",
    };
    const offeredSlots = [
      {
        start: "2026-10-21T14:30:00.000Z",
        end: "2026-10-21T15:00:00.000Z",
        label: "Wed, Oct 21 at 9:30 AM–10:00 AM CDT",
      },
      {
        start: "2026-10-22T15:00:00.000Z",
        end: "2026-10-22T15:30:00.000Z",
        label: "Thu, Oct 22 at 10:00 AM–10:30 AM CDT",
      },
      {
        start: "2026-10-23T14:30:00.000Z",
        end: "2026-10-23T15:00:00.000Z",
        label: "Fri, Oct 23 at 9:30 AM–10:00 AM CDT",
      },
    ];
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const schedules = new SqliteSchedulingRepository(database);
    const conversations = new SqliteConversationRepository(database);
    const calendarEvents = new SqliteCalendarEventRepository(database);
    await emails.register(original);
    await emails.claimForDrafting(original.providerMessageId);
    const session = await schedules.createAndAwaitSelection(
      original.providerMessageId,
      {
        summary: "Recruiter interview",
        requestedDates: ["2026-10-21", "2026-10-22", "2026-10-23"],
        requestedTime: null,
        timeZone: null,
        durationMinutes: 30,
        availabilityOptionCount: 3,
      },
      {
        requestedSlot: null,
        requestedSlotAvailable: false,
        timezoneRequired: false,
        options: offeredSlots,
        advisories: [],
        checkedAt: new Date().toISOString(),
      },
    );
    await schedules.claimSelection(
      session!.id,
      "offer-multiple-times",
      null,
      offeredSlots,
    );
    const draft = await drafts.saveAndAwaitApproval(original.providerMessageId, {
      body: "Here are three times that work for me.",
      reviewerNote: null,
      providerResponseId: "offered-times-draft",
      requestedModel: "test",
      resolvedModel: "test",
      promptTokens: null,
      completionTokens: null,
    });
    await schedules.markDrafted(session!.id, draft!.id);
    await schedules.markReplySent(draft!.id);
    await conversations.ensureForEmail({
      gmailThreadId: original.threadId,
      providerMessageId: original.providerMessageId,
      subject: original.subject,
      summary: "Three interview times were offered.",
      status: "awaiting_recruiter_confirmation",
    });
    await emails.register(confirmation);
    await emails.claimForDrafting(confirmation.providerMessageId);

    let generatedReply = false;
    const workflow = new SchedulingWorkflow(
      { async interpret() { throw new Error("not used"); } },
      new AvailabilityService(
        { async listEvents() { return []; } },
        {
          timeZone: "America/Chicago",
          workdayStartHour: 9,
          workdayEndHour: 18,
          defaultDurationMinutes: 30,
          bufferAfterMinutes: 15,
          searchBusinessDays: 10,
        },
      ),
      schedules,
      {
        async listEmailMessageIds() { return []; },
        async getEmailMessage(id) {
          return id === confirmation.providerMessageId ? confirmation : original;
        },
      },
      drafts,
      {
        async generateReply() {
          generatedReply = true;
          throw new Error("A confirmed offered slot must not generate a reply");
        },
      },
      new RecipientResolver({
        ownAddresses: ["bobby@example.com"],
        trustedForwarderAddresses: [],
      }),
      pino({ level: "silent" }),
      "America/Chicago",
      {
        replyInterpreter: {
          async interpret() {
            return {
              intent: "confirmation",
              confidence: 0.99,
              reason: "The recruiter selected the third offered option.",
              referencesSelectedSlot: false,
              explicitDate: "2026-10-23",
              explicitTime: "09:30",
              timeZone: "America/New_York",
              selectedOptionIndex: 2,
            };
          },
        },
        conversationRepository: conversations,
        calendarEventRepository: calendarEvents,
        emailRepository: emails,
      },
    );

    const stored = await emails.findByProviderMessageId(
      confirmation.providerMessageId,
    );
    assert.equal(
      await workflow.handleIncomingReply(stored!, confirmation),
      true,
    );
    assert.equal(generatedReply, false);
    assert.equal(
      await schedules.findByProviderMessageId(confirmation.providerMessageId),
      null,
    );
    assert.equal(
      (await schedules.findById(session!.id))?.selectedSlot?.start,
      "2026-10-23T14:30:00.000Z",
    );
    assert.equal(
      (await emails.findByProviderMessageId(confirmation.providerMessageId))
        ?.ignoredReason,
      "scheduling:recruiter_confirmed",
    );
    const calendarEvent = await calendarEvents.findBySessionId(session!.id);
    assert.equal(calendarEvent?.status, "proposed");
    assert.equal(calendarEvent?.event.start, "2026-10-23T14:30:00.000Z");
    assert.equal(calendarEvent?.event.timeZone, "America/Chicago");
    assert.equal(
      (await conversations.findByGmailThreadId(original.threadId))?.status,
      "calendar_event_awaiting_approval",
    );
  } finally {
    database.close();
  }
});

test("a time-only recruiter counterproposal keeps the active meeting date", async () => {
  const database = createDatabase(":memory:");
  try {
    const original: EmailMessage = {
      providerMessageId: "counter-original",
      threadId: "counter-thread",
      messageIdHeader: "<counter-original@example.com>",
      from: "Recruiter <recruiter@example.com>",
      to: ["bobby@example.com"],
      cc: [],
      replyTo: [],
      subject: "Interview",
      receivedAt: new Date("2026-10-17T12:00:00.000Z"),
      textBody: "Can we talk Tuesday at 10 AM CDT?",
      automationReason: null,
    };
    const counterproposal: EmailMessage = {
      ...original,
      providerMessageId: "counter-reply",
      messageIdHeader: "<counter-reply@example.com>",
      receivedAt: new Date("2026-10-18T13:38:00.000Z"),
      textBody: "Apologies, I need to change the time. Can you do 1 PM CDT?",
    };
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const schedules = new SqliteSchedulingRepository(database);
    const conversations = new SqliteConversationRepository(database);
    const calendarEvents = new SqliteCalendarEventRepository(database);
    await emails.register(original);
    await emails.claimForDrafting(original.providerMessageId);
    const originalSlot = {
      start: "2026-10-20T15:00:00.000Z",
      end: "2026-10-20T15:30:00.000Z",
      label: "Tue, Oct 20 at 10:00 AM–10:30 AM CDT",
    };
    const originalRequest = {
      summary: "Recruiter interview",
      requestedDates: ["2026-10-20"],
      requestedTime: "10:00",
      timeZone: "America/Chicago",
      durationMinutes: 30,
      availabilityOptionCount: 1,
    };
    const originalSession = await schedules.createAndAwaitSelection(
      original.providerMessageId,
      originalRequest,
      {
        requestedSlot: originalSlot,
        requestedSlotAvailable: true,
        timezoneRequired: false,
        options: [],
        advisories: [],
        checkedAt: new Date().toISOString(),
      },
    );
    await schedules.claimSelection(originalSession!.id, "original-selection", originalSlot);
    const originalDraft = await drafts.saveAndAwaitApproval(original.providerMessageId, {
      body: "Tuesday works.",
      reviewerNote: null,
      providerResponseId: "original-draft",
      requestedModel: "test",
      resolvedModel: "test",
      promptTokens: null,
      completionTokens: null,
    });
    await schedules.markDrafted(originalSession!.id, originalDraft!.id);
    await schedules.markReplySent(originalDraft!.id);
    await calendarEvents.propose(originalSession!.id, {
      requestId: "original-calendar-event",
      title: "Recruiter interview",
      description: "Original confirmed time.",
      start: originalSlot.start,
      end: originalSlot.end,
      timeZone: "America/Chicago",
    });
    await calendarEvents.claimCreate(originalSession!.id, "create-original", false);
    await calendarEvents.markCreated(
      originalSession!.id,
      "google-existing-event",
      "https://calendar.example/existing",
    );
    await conversations.ensureForEmail({
      gmailThreadId: original.threadId,
      providerMessageId: original.providerMessageId,
      subject: original.subject,
      summary: "Interview scheduled for Tuesday.",
      status: "awaiting_recruiter_confirmation",
    });
    await emails.register(counterproposal);
    await emails.claimForDrafting(counterproposal.providerMessageId);

    let previousRequest: typeof originalRequest | undefined;
    let generationInput: GenerateReplyInput | undefined;
    const provider: EmailProvider = {
      async listEmailMessageIds() { return []; },
      async getEmailMessage(id) {
        return id === counterproposal.providerMessageId ? counterproposal : original;
      },
    };
    const workflow = new SchedulingWorkflow(
      {
        async interpret(input) {
          previousRequest = input.previousRequest as typeof originalRequest;
          return {
            ...input.previousRequest!,
            requestedTime: "13:00",
            timeZone: "America/Chicago",
          };
        },
      },
      new AvailabilityService(
        { async listEvents() { return []; } },
        {
          timeZone: "America/Chicago",
          workdayStartHour: 9,
          workdayEndHour: 18,
          defaultDurationMinutes: 30,
          bufferAfterMinutes: 15,
          searchBusinessDays: 10,
        },
      ),
      schedules,
      provider,
      drafts,
      {
        async generateReply(input) {
          generationInput = input;
          return {
            body: "No problem, 1 PM CDT works for me.\n\nKind Regards,\nBobby Lawson",
            reviewerNote: null,
            providerResponseId: "counter-draft",
            requestedModel: "test",
            resolvedModel: "test",
            promptTokens: null,
            completionTokens: null,
          };
        },
      },
      new RecipientResolver({
        ownAddresses: ["bobby@example.com"],
        trustedForwarderAddresses: [],
      }),
      pino({ level: "silent" }),
      "America/Chicago",
      {
        replyInterpreter: {
          async interpret() {
            return {
              intent: "counterproposal",
              confidence: 0.99,
              reason: "The recruiter requested a different time.",
              referencesSelectedSlot: false,
              explicitDate: null,
              explicitTime: "13:00",
              timeZone: "America/Chicago",
              selectedOptionIndex: null,
            };
          },
        },
        conversationRepository: conversations,
        calendarEventRepository: calendarEvents,
        emailRepository: emails,
      },
    );

    const stored = await emails.findByProviderMessageId(
      counterproposal.providerMessageId,
    );
    assert.equal(
      await workflow.handleIncomingReply(stored!, counterproposal),
      true,
    );
    assert.deepEqual(previousRequest?.requestedDates, ["2026-10-20"]);
    assert.equal(previousRequest?.requestedTime, "10:00");

    const counterSession = await schedules.findByProviderMessageId(
      counterproposal.providerMessageId,
    );
    assert.deepEqual(counterSession?.request.requestedDates, ["2026-10-20"]);
    assert.equal(counterSession?.request.requestedTime, "13:00");
    assert.equal(counterSession?.analysis.requestedSlotAvailable, true);
    assert.match(counterSession?.analysis.requestedSlot?.label ?? "", /Tue, Oct 20 at 1:00 PM/);

    const card = await schedules.findLatestCard(counterSession!.id);
    const result = await workflow.selectCard(
      card!.id,
      "requested",
      "counter-selection",
    );
    assert.equal(result.outcome, "drafted");
    assert.equal(generationInput?.trustedSchedulingContext?.action, "accept");
    if (result.outcome !== "drafted") {
      assert.fail("Expected a counterproposal acceptance draft");
    }
    await workflow.onDraftSent(result.draft.id);
    assert.equal(
      (await calendarEvents.findBySessionId(originalSession!.id)),
      null,
    );
    const update = await calendarEvents.findBySessionId(counterSession!.id);
    assert.equal(update?.status, "update_proposed");
    assert.equal(update?.googleEventId, "google-existing-event");
    assert.equal(update?.event.start, "2026-10-20T18:00:00.000Z");
  } finally {
    database.close();
  }
});

test("a timezone clarification completes the pending date and time proposal", async () => {
  const database = createDatabase(":memory:");
  try {
    const proposal: EmailMessage = {
      providerMessageId: "timezone-proposal",
      threadId: "timezone-thread",
      messageIdHeader: "<timezone-proposal@example.com>",
      from: "Recruiter <recruiter@example.com>",
      to: ["bobby@example.com"],
      cc: [],
      replyTo: [],
      subject: "Interview",
      receivedAt: new Date("2026-10-21T15:00:00.000Z"),
      textBody: "Would 5 PM tomorrow work?",
      automationReason: null,
    };
    const clarification: EmailMessage = {
      ...proposal,
      providerMessageId: "timezone-clarification",
      messageIdHeader: "<timezone-clarification@example.com>",
      receivedAt: new Date("2026-10-21T16:00:00.000Z"),
      textBody: "Yes, sorry, Central time zone.",
    };
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const schedules = new SqliteSchedulingRepository(database);
    const conversations = new SqliteConversationRepository(database);
    await emails.register(proposal);
    await emails.claimForDrafting(proposal.providerMessageId);
    const pendingRequest = {
      summary: "Recruiter interview",
      requestedDates: ["2026-10-22"],
      requestedTime: "17:00",
      timeZone: null,
      durationMinutes: 30,
      availabilityOptionCount: 1,
    };
    const pendingSession = await schedules.createAndAwaitSelection(
      proposal.providerMessageId,
      pendingRequest,
      {
        requestedSlot: null,
        requestedSlotAvailable: false,
        timezoneRequired: true,
        options: [],
        advisories: [],
        checkedAt: new Date().toISOString(),
      },
    );
    await schedules.claimSelection(
      pendingSession!.id,
      "ask-for-timezone",
      null,
    );
    const clarificationDraft = await drafts.saveAndAwaitApproval(
      proposal.providerMessageId,
      {
        body: "Which timezone did you mean?",
        reviewerNote: null,
        providerResponseId: "timezone-question",
        requestedModel: "test",
        resolvedModel: "test",
        promptTokens: null,
        completionTokens: null,
      },
    );
    await schedules.markDrafted(pendingSession!.id, clarificationDraft!.id);
    await schedules.markReplySent(clarificationDraft!.id);
    await conversations.ensureForEmail({
      gmailThreadId: proposal.threadId,
      providerMessageId: proposal.providerMessageId,
      subject: proposal.subject,
      summary: "The recruiter proposed 5 PM without a timezone.",
      status: "awaiting_recruiter_confirmation",
    });
    await emails.register(clarification);
    await emails.claimForDrafting(clarification.providerMessageId);

    let suppliedPreviousRequest: typeof pendingRequest | undefined;
    const workflow = new SchedulingWorkflow(
      {
        async interpret(input) {
          suppliedPreviousRequest = input.previousRequest as typeof pendingRequest;
          return {
            summary: "Recruiter interview",
            requestedDates: [],
            requestedTime: null,
            timeZone: "America/Chicago",
            durationMinutes: 30,
            availabilityOptionCount: 1,
          };
        },
      },
      new AvailabilityService(
        { async listEvents() { return []; } },
        {
          timeZone: "America/Chicago",
          workdayStartHour: 9,
          workdayEndHour: 18,
          defaultDurationMinutes: 30,
          bufferAfterMinutes: 15,
          searchBusinessDays: 10,
        },
      ),
      schedules,
      {
        async listEmailMessageIds() { return []; },
        async getEmailMessage() { return clarification; },
      },
      drafts,
      { async generateReply() { throw new Error("not used"); } },
      new RecipientResolver({
        ownAddresses: ["bobby@example.com"],
        trustedForwarderAddresses: [],
      }),
      pino({ level: "silent" }),
      "America/Chicago",
      {
        replyInterpreter: {
          async interpret() {
            throw new Error("timezone continuation should use the saved request");
          },
        },
        conversationRepository: conversations,
        emailRepository: emails,
      },
    );

    const stored = await emails.findByProviderMessageId(
      clarification.providerMessageId,
    );
    assert.equal(
      await workflow.handleIncomingReply(stored!, clarification),
      true,
    );
    assert.deepEqual(suppliedPreviousRequest, pendingRequest);
    const completed = await schedules.findByProviderMessageId(
      clarification.providerMessageId,
    );
    assert.deepEqual(completed?.request.requestedDates, ["2026-10-22"]);
    assert.equal(completed?.request.requestedTime, "17:00");
    assert.equal(completed?.request.timeZone, "America/Chicago");
    assert.equal(completed?.analysis.timezoneRequired, false);
    assert.match(
      completed?.analysis.requestedSlot?.label ?? "",
      /Thu, Oct 22 at 5:00 PM/,
    );
    const completedCard = await schedules.findLatestCard(completed!.id);
    const rejection = await workflow.selectCard(
      completedCard!.id,
      "reject",
      "reject-timezone-follow-up",
    );
    assert.equal(rejection.outcome, "rejected");
    assert.equal(
      (await emails.findByProviderMessageId(clarification.providerMessageId))?.status,
      "rejected",
    );
    assert.equal(
      (await conversations.findByGmailThreadId(clarification.threadId))?.status,
      "rejected",
    );
  } finally {
    database.close();
  }
});
