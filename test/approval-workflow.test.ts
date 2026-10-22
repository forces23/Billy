import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { ApprovalWorkflow } from "../src/core/approval-workflow.js";
import { RecipientResolver } from "../src/core/recipient-resolver.js";
import { createDatabase } from "../src/database/connection.js";
import { SqliteApprovalRepository } from "../src/database/repositories/approval-repository.js";
import { SqliteDraftRepository } from "../src/database/repositories/draft-repository.js";
import { SqliteEmailRepository } from "../src/database/repositories/email-repository.js";
import type { AiProvider, GenerateReplyInput } from "../src/interfaces/ai-provider.js";
import type { EmailMessage, EmailProvider } from "../src/interfaces/email-provider.js";

test("revision 1 remains approvable after revision 2 is generated", async () => {
  const database = createDatabase(":memory:");

  try {
    const message: EmailMessage = {
      providerMessageId: "message-1",
      threadId: "thread-1",
      messageIdHeader: "<message-1@example.com>",
      from: "Sender <sender@example.com>",
      to: ["blawsonhq@gmail.com"],
      cc: [],
      replyTo: [],
      subject: "Question",
      receivedAt: new Date("2026-10-12T00:00:00.000Z"),
      textBody: "Can we meet next week?",
      automationReason: null,
    };
    const emailProvider: EmailProvider = {
      async listEmailMessageIds() {
        return [];
      },
      async getEmailMessage() {
        return message;
      },
    };
    let revisionInput: GenerateReplyInput | undefined;
    const aiProvider: AiProvider = {
      async generateReply(input) {
        revisionInput = input;
        return {
          body: "Revised reply\n\nKind Regards,\nBobby Lawson",
          reviewerNote: null,
          providerResponseId: "response-2",
          requestedModel: "test/model",
          resolvedModel: "test/model",
          promptTokens: 10,
          completionTokens: 5,
        };
      },
    };
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const approvals = new SqliteApprovalRepository(database);
    const resolver = new RecipientResolver({
      ownAddresses: ["blawsonhq@gmail.com"],
      trustedForwarderAddresses: ["personal@example.com"],
    });
    const workflow = new ApprovalWorkflow(
      emailProvider,
      drafts,
      approvals,
      aiProvider,
      resolver,
      pino({ level: "silent" }),
    );

    await emails.register(message);
    await emails.claimForDrafting(message.providerMessageId);
    const first = await drafts.saveAndAwaitApproval(message.providerMessageId, {
      body: "First reply\n\nKind Regards,\nBobby Lawson",
      reviewerNote: null,
      providerResponseId: "response-1",
      requestedModel: "test/model",
      resolvedModel: "test/model",
      promptTokens: 10,
      completionTokens: 5,
    });
    assert.ok(first);

    const revision = await workflow.requestRevision(
      "interaction-1",
      first.id,
      "reviewer-1",
      "Make the response shorter",
    );
    assert.equal(revision?.draft.revision, 2);
    assert.equal(revisionInput?.revision?.previousDraft, first.body);
    assert.equal(
      revisionInput?.revision?.instructions,
      "Make the response shorter",
    );

    const approval = await workflow.approve(
      first.id,
      "reply",
      "reviewer-1",
    );
    assert.equal(approval.outcome, "approved");
    assert.equal(
      (await approvals.findDecision(message.providerMessageId))?.draftId,
      first.id,
    );
    assert.equal(
      (await emails.findByProviderMessageId(message.providerMessageId))?.status,
      "approved",
    );
  } finally {
    database.close();
  }
});
