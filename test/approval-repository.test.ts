import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase } from "../src/database/connection.js";
import { SqliteApprovalRepository } from "../src/database/repositories/approval-repository.js";
import { SqliteDraftRepository } from "../src/database/repositories/draft-repository.js";
import { SqliteEmailRepository } from "../src/database/repositories/email-repository.js";
import type { GeneratedReply } from "../src/interfaces/ai-provider.js";
import type { EmailMessage } from "../src/interfaces/email-provider.js";

const generatedReply: GeneratedReply = {
  body: "Reply\n\nKind Regards,\nBobby Lawson",
  reviewerNote: null,
  providerResponseId: "response-1",
  requestedModel: "test/model",
  resolvedModel: "test/model",
  promptTokens: 10,
  completionTokens: 5,
};

function email(id: string): EmailMessage {
  return {
    providerMessageId: id,
    threadId: `thread-${id}`,
    messageIdHeader: `<${id}@example.com>`,
    from: "Sender <sender@example.com>",
    to: ["blawsonhq@gmail.com"],
    cc: [],
    replyTo: [],
    subject: "Test",
    receivedAt: new Date("2026-10-12T00:00:00.000Z"),
    textBody: "Hello",
    automationReason: null,
  };
}

test("approval repository stores exact recipients and only accepts one final decision", async () => {
  const database = createDatabase(":memory:");

  try {
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const approvals = new SqliteApprovalRepository(database);
    await emails.register(email("approval-1"));
    assert.equal(await emails.claimForDrafting("approval-1"), true);
    const draft = await drafts.saveAndAwaitApproval(
      "approval-1",
      generatedReply,
    );
    assert.ok(draft);

    assert.deepEqual(
      await approvals.listUnpublishedAwaitingDraftIds(10),
      [draft.id],
    );
    assert.equal(
      await approvals.savePublication(draft.id, "channel-1", "message-1"),
      true,
    );
    assert.deepEqual(
      (await approvals.listPublishedAwaitingDrafts(10)).map(
        (publication) => publication.draftId,
      ),
      [draft.id],
    );
    assert.deepEqual(await approvals.listUnpublishedAwaitingDraftIds(10), []);

    const decision = await approvals.approve(
      draft.id,
      "reply_all",
      {
        to: [{ name: "Sender", address: "sender@example.com" }],
        cc: [{ name: "Teammate", address: "team@example.com" }],
      },
      "reviewer-1",
    );

    assert.equal(decision?.decision, "approved_reply_all");
    assert.equal((await emails.findByProviderMessageId("approval-1"))?.status, "approved");
    assert.equal(
      (await approvals.findDecision("approval-1"))?.recipients.cc[0]?.address,
      "team@example.com",
    );
    assert.equal(await approvals.doNotReply(draft.id, "reviewer-2"), null);
  } finally {
    database.close();
  }
});

test("approval repository tracks versioned revision requests", async () => {
  const database = createDatabase(":memory:");

  try {
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const approvals = new SqliteApprovalRepository(database);
    await emails.register(email("revision-1"));
    await emails.claimForDrafting("revision-1");
    const first = await drafts.saveAndAwaitApproval("revision-1", generatedReply);
    assert.ok(first);

    const request = await approvals.createRevisionRequest(
      "interaction-1",
      first.id,
      "reviewer-1",
      "Make it shorter",
    );
    assert.ok(request);
    assert.equal(
      await approvals.createRevisionRequest(
        "interaction-1",
        first.id,
        "reviewer-1",
        "Make it shorter",
      ),
      null,
    );

    const second = await drafts.saveRevisionWhileAwaitingApproval(
      "revision-1",
      { ...generatedReply, body: "Short reply\n\nKind Regards,\nBobby Lawson" },
    );
    assert.equal(second?.revision, 2);
    assert.equal(
      await approvals.completeRevisionRequest(request.id, second?.id ?? 0),
      true,
    );
    assert.equal((await drafts.listByProviderMessageId("revision-1")).length, 2);
  } finally {
    database.close();
  }
});

test("approval repository tracks generation failure and delivery Discord updates", async () => {
  const database = createDatabase(":memory:");

  try {
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const approvals = new SqliteApprovalRepository(database);

    await emails.register(email("generation-failure-1"));
    await emails.claimForDrafting("generation-failure-1");
    await emails.markFailed("generation-failure-1", "drafting", {
      stage: "draft_generation",
      code: "output_limit",
      technicalMessage: "finish_reason=length",
      userMessage: "The model reached its output-token limit.",
    });

    const failures = await approvals.listGenerationFailuresNeedingPublication(10);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.failureCode, "output_limit");
    assert.equal(failures[0]?.publication, null);
    assert.ok(failures[0]?.failedAt);
    await approvals.saveGenerationFailurePublication(
      "generation-failure-1",
      "channel-1",
      "failure-message-1",
      failures[0]!.failedAt,
    );
    assert.equal(
      (await approvals.listGenerationFailuresNeedingPublication(10)).length,
      0,
    );

    assert.equal(
      await emails.claimFailedGenerationRetry("generation-failure-1"),
      true,
    );
    assert.equal(
      (await approvals.listResolvedGenerationFailurePublications(10)).length,
      0,
    );
    assert.ok(
      await drafts.saveAndAwaitApproval(
        "generation-failure-1",
        generatedReply,
      ),
    );
    const resolved =
      await approvals.listResolvedGenerationFailurePublications(10);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.emailStatus, "awaiting_approval");
    assert.equal(
      await approvals.markGenerationFailurePublicationResolved(
        "generation-failure-1",
      ),
      true,
    );

    await emails.register(email("delivery-1"));
    await emails.claimForDrafting("delivery-1");
    const draft = await drafts.saveAndAwaitApproval("delivery-1", generatedReply);
    assert.ok(draft);
    await approvals.savePublication(draft.id, "channel-1", "draft-message-1");
    await approvals.approve(
      draft.id,
      "reply",
      { to: [{ name: "Sender", address: "sender@example.com" }], cc: [] },
      "reviewer-1",
    );

    let deliveryUpdates = await approvals.listDeliveryStatusUpdates(10);
    assert.equal(deliveryUpdates[0]?.displayStatus, "queued");
    await approvals.markDeliveryStatusRendered(draft.id, "queued");
    await emails.transitionStatus("delivery-1", "approved", "sending");
    deliveryUpdates = await approvals.listDeliveryStatusUpdates(10);
    assert.equal(deliveryUpdates[0]?.displayStatus, "sending");
    await approvals.markDeliveryStatusRendered(draft.id, "sending");
    await emails.markFailed("delivery-1", "sending", {
      stage: "gmail_send",
      code: "gmail_send_failed",
      technicalMessage: "HTTP 503",
      userMessage: "Gmail could not send the approved reply.",
    });
    deliveryUpdates = await approvals.listDeliveryStatusUpdates(10);
    assert.equal(deliveryUpdates[0]?.displayStatus, "failed");
    assert.equal(
      deliveryUpdates[0]?.failureUserMessage,
      "Gmail could not send the approved reply.",
    );
  } finally {
    database.close();
  }
});
