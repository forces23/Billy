import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase } from "../src/database/connection.js";
import { SqliteEmailRepository } from "../src/database/repositories/email-repository.js";
import { SqliteSchedulingRepository } from "../src/database/repositories/scheduling-repository.js";
import { SqliteDraftRepository } from "../src/database/repositories/draft-repository.js";
import { SqliteApprovalRepository } from "../src/database/repositories/approval-repository.js";
import type { EmailMessage } from "../src/interfaces/email-provider.js";

const message: EmailMessage = {
  providerMessageId: "schedule-1",
  threadId: "thread-1",
  messageIdHeader: "<schedule-1@example.com>",
  from: "Recruiter <recruiter@example.com>",
  to: ["bobby@example.com"],
  cc: [],
  replyTo: [],
  subject: "Interview",
  receivedAt: new Date("2026-03-10T12:00:00.000Z"),
  textBody: "Can you meet March 16?",
  automationReason: null,
};

const request = {
  summary: "Recruiter interview",
  requestedDates: ["2026-03-16"],
  requestedTime: null,
  timeZone: null,
  durationMinutes: 30,
} as const;

const analysis = {
  requestedSlot: null,
  requestedSlotAvailable: false,
  timezoneRequired: false,
  options: [
    {
      start: "2026-03-16T14:00:00.000Z",
      end: "2026-03-16T14:30:00.000Z",
      label: "Mon, Mar 16 at 9:00 AM–9:30 AM CDT",
    },
  ],
  advisories: [],
  checkedAt: "2026-03-10T12:00:00.000Z",
} as const;

test("scheduling repository persists and idempotently claims a selection", async () => {
  const database = createDatabase(":memory:");
  try {
    const emails = new SqliteEmailRepository(database);
    const schedules = new SqliteSchedulingRepository(database);
    await emails.register(message);
    await emails.claimForDrafting(message.providerMessageId);

    const session = await schedules.createAndAwaitSelection(
      message.providerMessageId,
      request,
      analysis,
    );
    assert.equal(session?.status, "awaiting_selection");
    const initialCard = await schedules.findLatestCard(session!.id);
    assert.equal(initialCard?.version, 1);
    await schedules.updateAnalysis(session!.id, request, {
      ...analysis,
      checkedAt: "2026-03-10T12:01:00.000Z",
    });
    const refreshedCard = await schedules.findLatestCard(session!.id);
    assert.equal(refreshedCard?.version, 2);
    assert.equal(initialCard?.analysis.checkedAt, "2026-03-10T12:00:00.000Z");
    assert.equal(
      (await emails.findByProviderMessageId(message.providerMessageId))?.ignoredReason,
      "scheduling:awaiting_selection",
    );
    assert.equal(
      await schedules.claimSelection(session!.id, "interaction-1", initialCard!.analysis.options[0]!),
      true,
    );
    assert.equal(
      await schedules.claimSelection(session!.id, "interaction-2", analysis.options[0]!),
      false,
    );
    assert.equal(
      (await emails.findByProviderMessageId(message.providerMessageId))?.status,
      "drafting",
    );
    assert.equal(await schedules.releaseSelection(session!.id, analysis), true);
    assert.equal(
      (await emails.findByProviderMessageId(message.providerMessageId))?.status,
      "ignored",
    );
    assert.equal(
      await schedules.rejectSession(session!.id, "reject-interaction"),
      true,
    );
    assert.equal(
      await schedules.rejectSession(session!.id, "duplicate-rejection"),
      false,
    );
    assert.equal(
      (await emails.findByProviderMessageId(message.providerMessageId))?.status,
      "rejected",
    );
    assert.equal(
      (await emails.findByProviderMessageId(message.providerMessageId))?.ignoredReason,
      "scheduling:rejected_by_reviewer",
    );
    assert.equal((await schedules.findById(session!.id))?.status, "resolved");
    assert.notEqual(
      (await schedules.findLatestCard(session!.id))?.disabledAt,
      null,
    );
  } finally {
    database.close();
  }
});

test("a stale approved scheduling draft is reopened without sending", async () => {
  const database = createDatabase(":memory:");
  try {
    const emails = new SqliteEmailRepository(database);
    const schedules = new SqliteSchedulingRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const approvals = new SqliteApprovalRepository(database);
    await emails.register(message);
    await emails.claimForDrafting(message.providerMessageId);
    const session = await schedules.createAndAwaitSelection(
      message.providerMessageId,
      request,
      analysis,
    );
    await schedules.claimSelection(
      session!.id,
      "approve-then-conflict",
      analysis.options[0]!,
    );
    const draft = await drafts.saveAndAwaitApproval(message.providerMessageId, {
      body: "That time works.\n\nKind Regards,\nBobby Lawson",
      reviewerNote: null,
      providerResponseId: "response-1",
      requestedModel: "test/model",
      resolvedModel: "test/model",
      promptTokens: 10,
      completionTokens: 10,
    });
    await schedules.markDrafted(session!.id, draft!.id);
    await approvals.approve(
      draft!.id,
      "reply",
      { to: [{ name: "Recruiter", address: "recruiter@example.com" }], cc: [] },
      "reviewer-1",
    );
    assert.equal(
      (await emails.findByProviderMessageId(message.providerMessageId))?.status,
      "approved",
    );

    assert.equal(await schedules.reopenAfterConflict(session!.id, analysis), true);
    assert.equal(
      (await emails.findByProviderMessageId(message.providerMessageId))?.status,
      "ignored",
    );
    assert.equal(await approvals.findDecision(message.providerMessageId), null);
    assert.equal((await schedules.findById(session!.id))?.status, "awaiting_selection");
  } finally {
    database.close();
  }
});

test("scheduling repository persists a multi-slot offer and records the recruiter's choice", async () => {
  const database = createDatabase(":memory:");
  try {
    const emails = new SqliteEmailRepository(database);
    const schedules = new SqliteSchedulingRepository(database);
    await emails.register(message);
    await emails.claimForDrafting(message.providerMessageId);
    const multipleAnalysis = {
      ...analysis,
      options: [
        analysis.options[0]!,
        {
          start: "2026-03-17T14:00:00.000Z",
          end: "2026-03-17T14:30:00.000Z",
          label: "Tue, Mar 17 at 9:00 AM–9:30 AM CDT",
        },
      ],
    };
    const session = await schedules.createAndAwaitSelection(
      message.providerMessageId,
      { ...request, availabilityOptionCount: 2 },
      multipleAnalysis,
    );

    assert.equal(
      await schedules.claimSelection(
        session!.id,
        "offer-two",
        null,
        multipleAnalysis.options,
      ),
      true,
    );
    assert.equal((await schedules.findById(session!.id))?.offeredSlots.length, 2);

    const drafts = new SqliteDraftRepository(database);
    const draft = await drafts.saveAndAwaitApproval(message.providerMessageId, {
      body: "I am available at either time.\n\nKind Regards,\nBobby Lawson",
      reviewerNote: null,
      providerResponseId: "multi-response",
      requestedModel: "test/model",
      resolvedModel: "test/model",
      promptTokens: null,
      completionTokens: null,
    });
    await schedules.markDrafted(session!.id, draft!.id);
    await schedules.markReplySent(draft!.id);
    assert.equal(
      await schedules.selectOfferedSlot(session!.id, multipleAnalysis.options[1]!),
      true,
    );
    assert.equal(
      (await schedules.findById(session!.id))?.selectedSlot?.start,
      "2026-03-17T14:00:00.000Z",
    );
  } finally {
    database.close();
  }
});
