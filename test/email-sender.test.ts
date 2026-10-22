import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { RecipientResolver } from "../src/core/recipient-resolver.js";
import { createDatabase } from "../src/database/connection.js";
import { SqliteApprovalRepository } from "../src/database/repositories/approval-repository.js";
import { SqliteDraftRepository } from "../src/database/repositories/draft-repository.js";
import { SqliteEmailRepository } from "../src/database/repositories/email-repository.js";
import type {
  EmailMessage,
  EmailProvider,
  OutboundEmailProvider,
  SendEmailReplyInput,
} from "../src/interfaces/email-provider.js";
import { EmailSender } from "../src/jobs/email-sender.js";

function message(
  providerMessageId: string,
  overrides: Partial<EmailMessage> = {},
): EmailMessage {
  return {
    providerMessageId,
    threadId: `thread-${providerMessageId}`,
    messageIdHeader: `<${providerMessageId}@example.com>`,
    from: "Sender <sender@example.com>",
    to: ["blawsonhq@gmail.com"],
    cc: [],
    replyTo: [],
    subject: "Question",
    receivedAt: new Date("2026-10-12T00:00:00.000Z"),
    textBody: "Can we meet next week?",
    automationReason: null,
    ...overrides,
  };
}

test("email sender sends approved direct replies and records Gmail metadata", async () => {
  const database = createDatabase(":memory:");

  try {
    const original = message("direct-1");
    const sentInputs: SendEmailReplyInput[] = [];
    const provider: EmailProvider & OutboundEmailProvider = {
      async listEmailMessageIds() {
        return [];
      },
      async getEmailMessage() {
        return original;
      },
      async sendReply(input) {
        sentInputs.push(input);
        return { providerMessageId: "sent-direct-1", threadId: "thread-direct-1" };
      },
    };
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const approvals = new SqliteApprovalRepository(database);
    const resolver = new RecipientResolver({
      ownAddresses: ["blawsonhq@gmail.com"],
      trustedForwarderAddresses: ["personal@example.com"],
    });

    await emails.register(original);
    await emails.claimForDrafting(original.providerMessageId);
    const draft = await drafts.saveAndAwaitApproval(original.providerMessageId, {
      body: "Yes, next week works.\n\nKind Regards,\nBobby Lawson",
      reviewerNote: null,
      providerResponseId: "response-1",
      requestedModel: "test/model",
      resolvedModel: "test/model",
      promptTokens: 10,
      completionTokens: 5,
    });
    assert.ok(draft);
    const recipients = resolver.resolve(original).reply;
    assert.ok(await approvals.approve(draft.id, "reply", recipients, "reviewer-1"));

    const sender = new EmailSender(
      provider,
      emails,
      drafts,
      approvals,
      resolver,
      pino({ level: "silent" }),
      { intervalMilliseconds: 1 },
    );
    await sender.processPending();

    assert.equal(sentInputs.length, 1);
    assert.equal(sentInputs[0]?.threadId, original.threadId);
    assert.equal(sentInputs[0]?.inReplyTo, original.messageIdHeader);
    assert.deepEqual(sentInputs[0]?.to, ["Sender <sender@example.com>"]);
    const stored = await emails.findByProviderMessageId(original.providerMessageId);
    assert.equal(stored?.status, "sent");
    assert.equal(stored?.sentProviderMessageId, "sent-direct-1");
    assert.ok(stored?.sentAt instanceof Date);
  } finally {
    database.close();
  }
});

test("email sender does not attach forwarded replies to the forwarding thread", async () => {
  const database = createDatabase(":memory:");

  try {
    const original = message("forwarded-1", {
      from: "Personal <personal@example.com>",
      subject: "Fwd: Original question",
      textBody: [
        "---------- Forwarded message ---------",
        "From: Original Sender <original@example.com>",
        "To: Personal <personal@example.com>",
        "Subject: Original question",
        "",
        "Could you help with this?",
      ].join("\n"),
    });
    let sentInput: SendEmailReplyInput | undefined;
    const provider: EmailProvider & OutboundEmailProvider = {
      async listEmailMessageIds() {
        return [];
      },
      async getEmailMessage() {
        return original;
      },
      async sendReply(input) {
        sentInput = input;
        return { providerMessageId: "sent-forwarded-1", threadId: "new-thread-1" };
      },
    };
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const approvals = new SqliteApprovalRepository(database);
    const resolver = new RecipientResolver({
      ownAddresses: ["blawsonhq@gmail.com"],
      trustedForwarderAddresses: ["personal@example.com"],
    });

    await emails.register(original);
    await emails.claimForDrafting(original.providerMessageId);
    const draft = await drafts.saveAndAwaitApproval(original.providerMessageId, {
      body: "I can help.\n\nKind Regards,\nBobby Lawson",
      reviewerNote: null,
      providerResponseId: "response-2",
      requestedModel: "test/model",
      resolvedModel: "test/model",
      promptTokens: null,
      completionTokens: null,
    });
    assert.ok(draft);
    const recipients = resolver.resolve(original).reply;
    assert.ok(await approvals.approve(draft.id, "reply", recipients, "reviewer-1"));

    const sender = new EmailSender(
      provider,
      emails,
      drafts,
      approvals,
      resolver,
      pino({ level: "silent" }),
      { intervalMilliseconds: 1 },
    );
    await sender.processPending();

    assert.deepEqual(sentInput?.to, ["Original Sender <original@example.com>"]);
    assert.equal(sentInput?.subject, "Original question");
    assert.equal(sentInput?.threadId, undefined);
    assert.equal(sentInput?.inReplyTo, undefined);
  } finally {
    database.close();
  }
});

test("email sender records a Gmail failure and continues", async () => {
  const database = createDatabase(":memory:");

  try {
    const original = message("failure-1");
    const provider: EmailProvider & OutboundEmailProvider = {
      async listEmailMessageIds() {
        return [];
      },
      async getEmailMessage() {
        return original;
      },
      async sendReply() {
        throw new Error("Gmail unavailable");
      },
    };
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const approvals = new SqliteApprovalRepository(database);
    const resolver = new RecipientResolver({
      ownAddresses: ["blawsonhq@gmail.com"],
      trustedForwarderAddresses: [],
    });

    await emails.register(original);
    await emails.claimForDrafting(original.providerMessageId);
    const draft = await drafts.saveAndAwaitApproval(original.providerMessageId, {
      body: "Reply body",
      reviewerNote: null,
      providerResponseId: "response-3",
      requestedModel: "test/model",
      resolvedModel: "test/model",
      promptTokens: null,
      completionTokens: null,
    });
    assert.ok(draft);
    assert.ok(
      await approvals.approve(
        draft.id,
        "reply",
        resolver.resolve(original).reply,
        "reviewer-1",
      ),
    );

    const sender = new EmailSender(
      provider,
      emails,
      drafts,
      approvals,
      resolver,
      pino({ level: "silent" }),
      { intervalMilliseconds: 1 },
    );
    await sender.processPending();

    const stored = await emails.findByProviderMessageId(original.providerMessageId);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.attemptCount, 1);
    assert.equal(stored?.lastError, "Gmail unavailable");
  } finally {
    database.close();
  }
});
