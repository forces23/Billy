import assert from "node:assert/strict";
import test from "node:test";

import { AvailabilityService } from "../src/core/availability-service.js";
import { CalendarEventWorkflow } from "../src/core/calendar-event-workflow.js";
import { createDatabase } from "../src/database/connection.js";
import { SqliteCalendarEventRepository } from "../src/database/repositories/calendar-event-repository.js";
import { SqliteConversationRepository } from "../src/database/repositories/conversation-repository.js";
import { SqliteEmailRepository } from "../src/database/repositories/email-repository.js";
import { SqliteSchedulingRepository } from "../src/database/repositories/scheduling-repository.js";
import type { CalendarEventWrite, CalendarProvider } from "../src/interfaces/calendar-provider.js";
import type { EmailMessage } from "../src/interfaces/email-provider.js";

test("calendar proposals require explicit approval and can be rejected", async () => {
  const database = createDatabase(":memory:");
  try {
    const emails = new SqliteEmailRepository(database);
    const schedules = new SqliteSchedulingRepository(database);
    const conversations = new SqliteConversationRepository(database);
    const events = new SqliteCalendarEventRepository(database);
    const message: EmailMessage = {
      providerMessageId: "calendar-source",
      threadId: "calendar-thread",
      messageIdHeader: "<calendar-source@example.com>",
      from: "Recruiter <recruiter@example.com>",
      to: ["bobby@example.com"], cc: [], replyTo: [], subject: "Interview",
      receivedAt: new Date("2026-10-17T12:00:00.000Z"),
      textBody: "Can we meet?", automationReason: null,
    };
    await emails.register(message);
    await emails.claimForDrafting(message.providerMessageId);
    const session = await schedules.createAndAwaitSelection(
      message.providerMessageId,
      { summary: "Interview", requestedDates: ["2026-10-21"], requestedTime: null, timeZone: null, durationMinutes: 30 },
      { requestedSlot: null, requestedSlotAvailable: false, timezoneRequired: false, options: [], advisories: [], checkedAt: new Date().toISOString() },
    );
    await conversations.ensureForEmail({
      gmailThreadId: message.threadId,
      providerMessageId: message.providerMessageId,
      subject: message.subject,
      summary: "The recruiter confirmed an interview.",
      status: "calendar_event_awaiting_approval",
    });

    let createdInput: CalendarEventWrite | undefined;
    let updatedInput: CalendarEventWrite | undefined;
    let updatedProviderEventId: string | undefined;
    const calendar: CalendarProvider = {
      async listEvents() { return []; },
      async createEvent(input) {
        createdInput = input;
        return { providerEventId: "google-event", htmlLink: "https://calendar.example/event" };
      },
      async updateEvent(providerEventId, input) {
        updatedProviderEventId = providerEventId;
        updatedInput = input;
        return { providerEventId, htmlLink: null };
      },
      async deleteEvent() {},
    };
    const availability = new AvailabilityService(calendar, {
      timeZone: "America/Chicago", workdayStartHour: 9, workdayEndHour: 18,
      defaultDurationMinutes: 30, bufferAfterMinutes: 15, searchBusinessDays: 10,
    });
    const originalEvent = {
      requestId: "scheduling-test", title: "Interview", description: "Confirmed by email.",
      start: "2026-10-21T17:00:00.000Z", end: "2026-10-21T17:30:00.000Z",
      timeZone: "America/Chicago",
    };
    await events.propose(session!.id, originalEvent);
    assert.equal(createdInput, undefined);

    const workflow = new CalendarEventWorkflow(events, calendar, availability, schedules, conversations);
    assert.equal(await workflow.create(session!.id, "discord-interaction", false), "created");
    assert.equal(createdInput?.title, "Interview");
    assert.equal((await conversations.findByGmailThreadId(message.threadId))?.status, "scheduled");

    const movedEvent = {
      requestId: "scheduling-test",
      title: "Interview",
      description: "Recruiter requested a new time.",
      start: "2026-10-21T18:00:00.000Z",
      end: "2026-10-21T18:30:00.000Z",
      timeZone: "America/Chicago",
    };
    assert.equal(await events.updateProposal(session!.id, movedEvent, false), true);
    assert.equal(await workflow.reject(session!.id, "discord-reject-update"), true);
    assert.equal((await events.findBySessionId(session!.id))?.status, "created");
    assert.deepEqual((await events.findBySessionId(session!.id))?.event, originalEvent);
    assert.equal((await conversations.findByGmailThreadId(message.threadId))?.status, "scheduled");

    assert.equal(await events.updateProposal(session!.id, movedEvent, false), true);
    assert.equal(await workflow.update(session!.id, "discord-update"), true);
    assert.equal(updatedProviderEventId, "google-event");
    assert.deepEqual(updatedInput, movedEvent);
    assert.equal((await events.findBySessionId(session!.id))?.status, "created");
    assert.equal((await conversations.findByGmailThreadId(message.threadId))?.status, "scheduled");

    const rejectedMessage: EmailMessage = {
      ...message,
      providerMessageId: "calendar-rejected",
      threadId: "calendar-rejected-thread",
      messageIdHeader: "<calendar-rejected@example.com>",
    };
    await emails.register(rejectedMessage);
    await emails.claimForDrafting(rejectedMessage.providerMessageId);
    const rejectedSession = await schedules.createAndAwaitSelection(
      rejectedMessage.providerMessageId,
      { summary: "Another interview", requestedDates: ["2026-10-22"], requestedTime: null, timeZone: null, durationMinutes: 30 },
      { requestedSlot: null, requestedSlotAvailable: false, timezoneRequired: false, options: [], advisories: [], checkedAt: new Date().toISOString() },
    );
    await conversations.ensureForEmail({
      gmailThreadId: rejectedMessage.threadId,
      providerMessageId: rejectedMessage.providerMessageId,
      subject: rejectedMessage.subject,
      summary: "Another confirmed interview.",
      status: "calendar_event_awaiting_approval",
    });
    await events.propose(rejectedSession!.id, {
      ...originalEvent,
      requestId: "rejected-calendar-event",
      title: "Another interview",
    });
    assert.equal(
      await workflow.reject(rejectedSession!.id, "discord-reject-create"),
      true,
    );
    assert.equal(
      (await events.findBySessionId(rejectedSession!.id))?.status,
      "cancelled",
    );
    assert.equal(
      (await conversations.findByGmailThreadId(rejectedMessage.threadId))?.status,
      "rejected",
    );
  } finally {
    database.close();
  }
});
