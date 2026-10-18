import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase } from "../src/database/connection.js";
import { SqliteConversationRepository } from "../src/database/repositories/conversation-repository.js";
import { SqliteEmailRepository } from "../src/database/repositories/email-repository.js";
import type { EmailMessage } from "../src/interfaces/email-provider.js";

test("one Discord conversation is reused for every message in a Gmail thread", async () => {
  const database = createDatabase(":memory:");
  try {
    const emails = new SqliteEmailRepository(database);
    const conversations = new SqliteConversationRepository(database);
    const first = message("message-1");
    const second = message("message-2");
    await emails.register(first);
    await emails.register(second);

    const created = await conversations.ensureForEmail({
      gmailThreadId: first.threadId,
      providerMessageId: first.providerMessageId,
      subject: first.subject,
      summary: "A recruiter asked to arrange an interview.",
      status: "scheduling_needed",
    });
    assert.ok(created);
    assert.equal(await conversations.attachEmail(first.threadId, second.providerMessageId), true);
    assert.equal((await conversations.findByProviderMessageId(second.providerMessageId))?.gmailThreadId, first.threadId);
    assert.deepEqual(await conversations.listInboundNeedingPublication(first.threadId), ["message-1", "message-2"]);

    assert.equal(await conversations.savePublication(first.threadId, "channel", "parent", "thread"), true);
    assert.equal((await conversations.findByDiscordThreadId("thread"))?.subject, "Interview");
  } finally {
    database.close();
  }
});

function message(providerMessageId: string): EmailMessage {
  return {
    providerMessageId,
    threadId: "gmail-thread",
    messageIdHeader: `<${providerMessageId}@example.com>`,
    from: "Recruiter <recruiter@example.com>",
    to: ["bobby@example.com"],
    cc: [],
    replyTo: [],
    subject: "Interview",
    receivedAt: new Date(`2026-10-17T${providerMessageId === "message-1" ? "10" : "11"}:00:00.000Z`),
    textBody: "Can we arrange an interview?",
    automationReason: null,
  };
}
