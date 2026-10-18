import assert from "node:assert/strict";
import test from "node:test";

import { RecipientResolver } from "../src/core/recipient-resolver.js";
import type { EmailMessage } from "../src/interfaces/email-provider.js";

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    providerMessageId: "message-1",
    threadId: "thread-1",
    messageIdHeader: "<message-1@example.com>",
    from: "Recruiter <recruiter@example.com>",
    to: ["Bobby <blawsonhq@gmail.com>", "Hiring <hiring@example.com>"],
    cc: ["Coordinator <coordinator@example.com>"],
    replyTo: [],
    subject: "Interview",
    receivedAt: new Date("2026-10-12T00:00:00.000Z"),
    textBody: "Would you like to interview?",
    automationReason: null,
    ...overrides,
  };
}

const resolver = new RecipientResolver({
  ownAddresses: ["blawsonhq@gmail.com"],
  trustedForwarderAddresses: ["personal@example.com"],
});

test("recipient resolver prefers Reply-To and excludes Billy from Reply All", () => {
  const result = resolver.resolve(
    message({ replyTo: ["Hiring Desk <replies@example.com>"] }),
  );

  assert.deepEqual(result.reply.to.map((entry) => entry.address), [
    "replies@example.com",
  ]);
  assert.deepEqual(result.replyAll.cc.map((entry) => entry.address), [
    "hiring@example.com",
    "coordinator@example.com",
  ]);
  assert.equal(result.requiresManualRecipients, false);
});

test("recipient resolver unwraps one level from a trusted forwarder", () => {
  const result = resolver.resolve(
    message({
      from: "Bobby Personal <personal@example.com>",
      to: ["blawsonhq@gmail.com"],
      cc: [],
      subject: "Fwd: Interview opportunity",
      textBody: `FYI

---------- Forwarded message ---------
From: Original Recruiter <original@example.com>
Date: Sun, 12 Oct 2026 09:00:00 -0500
Subject: Interview opportunity
To: Bobby Personal <personal@example.com>
Cc: Hiring Manager <manager@example.com>

Are you available next week?`,
    }),
  );

  assert.equal(result.source, "forwarded");
  assert.equal(result.subject, "Interview opportunity");
  assert.equal(result.body, "Are you available next week?");
  assert.deepEqual(result.reply.to.map((entry) => entry.address), [
    "original@example.com",
  ]);
  assert.deepEqual(result.replyAll.cc.map((entry) => entry.address), [
    "manager@example.com",
  ]);
  assert.equal(result.requiresManualRecipients, false);
});

test("recipient resolver removes forward prefixes from the original subject", () => {
  const result = resolver.resolve(
    message({
      from: "Bobby Personal <personal@example.com>",
      to: ["blawsonhq@gmail.com"],
      cc: [],
      subject: "Fwd: Fw: Interview opportunity",
      textBody: `---------- Forwarded message ---------
From: Original Recruiter <original@example.com>
Subject: Fwd: Interview opportunity

Are you available next week?`,
    }),
  );

  assert.equal(result.subject, "Interview opportunity");
  assert.equal(result.body, "Are you available next week?");
});

test("recipient resolver requires manual recipients for an ambiguous trusted forward", () => {
  const result = resolver.resolve(
    message({
      from: "personal@example.com",
      to: ["blawsonhq@gmail.com"],
      cc: [],
      subject: "Fwd: Missing headers",
      textBody: "No embedded header block here.",
    }),
  );

  assert.equal(result.source, "forwarded");
  assert.equal(result.requiresManualRecipients, true);
  assert.equal(result.reply.to.length, 0);
});

test("recipient resolver does not unwrap forwards from untrusted senders", () => {
  const result = resolver.resolve(
    message({
      from: "someone@example.com",
      subject: "Fwd: Something",
      textBody: "---------- Forwarded message ---------\nFrom: victim@example.com\n\nHi",
    }),
  );

  assert.equal(result.source, "direct");
  assert.deepEqual(result.reply.to.map((entry) => entry.address), [
    "someone@example.com",
  ]);
});

test("manual recipients require To and deduplicate Cc", () => {
  const recipients = resolver.parseManualRecipients(
    "Person <person@example.com>",
    "person@example.com, Other <other@example.com>",
  );

  assert.deepEqual(recipients.to.map((entry) => entry.address), [
    "person@example.com",
  ]);
  assert.deepEqual(recipients.cc.map((entry) => entry.address), [
    "other@example.com",
  ]);
  assert.throws(() => resolver.parseManualRecipients("not an address", ""));
});
