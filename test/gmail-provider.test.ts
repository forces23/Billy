import assert from "node:assert/strict";
import test from "node:test";

import type { gmail_v1 } from "googleapis";

import {
  extractLatestReply,
  GmailEmailProvider,
} from "../src/integrations/gmail/gmail-provider.js";

function createClient(
  from: string,
  extraHeaders: readonly gmail_v1.Schema$MessagePartHeader[] = [],
  body = "Hello",
): gmail_v1.Gmail {
  return {
    users: {
      messages: {
        async get() {
          return {
            data: {
              id: "message-1",
              threadId: "thread-1",
              internalDate: "1791763200000",
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "From", value: from },
                  { name: "To", value: "Bobby <bobby@example.com>" },
                  { name: "Subject", value: "Test" },
                  { name: "Message-ID", value: "<message-1@example.com>" },
                  ...extraHeaders,
                ],
                body: {
                  data: Buffer.from(body).toString("base64url"),
                },
              },
            },
          };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
}

test("Gmail provider keeps only the newest text above a quoted reply", async () => {
  const provider = new GmailEmailProvider(
    createClient(
      "Recruiter <recruiter@example.com>",
      [],
      [
        "Wednesday works for me.",
        "",
        "Thank you,",
        "Recruiter",
        "",
        "On Sat, Oct 17, 2026 at 4:35 PM Bobby Lawson <bobby@example.com> wrote:",
        "> Earlier message",
        "> Earlier details",
      ].join("\r\n"),
    ),
  );

  assert.equal(
    (await provider.getMessage("message-1")).textBody,
    "Wednesday works for me.\n\nThank you,\nRecruiter",
  );
});

test("latest-reply extraction preserves forwarded message content", () => {
  const forwarded = [
    "Please review this recruiter email.",
    "",
    "---------- Forwarded message ---------",
    "From: Recruiter <recruiter@example.com>",
    "Can we schedule a call?",
  ].join("\n");

  assert.equal(extractLatestReply(forwarded), forwarded);
});

test("Gmail provider identifies no-reply and mailing-list messages", async () => {
  const noReplyProvider = new GmailEmailProvider(
    createClient("Company <no-reply@example.com>"),
  );
  const listProvider = new GmailEmailProvider(
    createClient("Newsletter <news@example.com>", [
      { name: "List-Unsubscribe", value: "<mailto:leave@example.com>" },
    ]),
  );
  const normalProvider = new GmailEmailProvider(
    createClient("Person <person@example.com>"),
  );

  assert.match(
    (await noReplyProvider.getMessage("message-1")).automationReason ?? "",
    /automated mailbox/,
  );
  assert.match(
    (await listProvider.getMessage("message-1")).automationReason ?? "",
    /List-Unsubscribe/,
  );
  assert.equal(
    (await normalProvider.getMessage("message-1")).automationReason,
    null,
  );
});

test("Gmail provider returns Cc and Reply-To headers", async () => {
  const provider = new GmailEmailProvider(
    createClient("Sender <sender@example.com>", [
      { name: "Cc", value: "Teammate <team@example.com>" },
      { name: "Reply-To", value: "Replies <reply@example.com>" },
    ]),
  );

  const message = await provider.getMessage("message-1");

  assert.deepEqual(message.cc, ["Teammate <team@example.com>"]);
  assert.deepEqual(message.replyTo, ["Replies <reply@example.com>"]);
});

test("Gmail provider sends a threaded plain-text reply", async () => {
  let sentRequest: {
    userId?: string;
    requestBody?: { raw?: string; threadId?: string };
  } | undefined;
  const client = {
    users: {
      messages: {
        async send(request: typeof sentRequest) {
          sentRequest = request;
          return { data: { id: "sent-1", threadId: "thread-1" } };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
  const provider = new GmailEmailProvider(client, {
    userId: "me",
    senderAddress: "bobby@example.com",
  });

  const sent = await provider.sendReply({
    to: ["Sender <sender@example.com>"],
    cc: ["Teammate <team@example.com>"],
    subject: "Question",
    textBody: "Thanks for reaching out.\n\nKind Regards,\nBobby Lawson",
    threadId: "thread-1",
    inReplyTo: "<message-1@example.com>",
  });

  assert.deepEqual(sent, {
    providerMessageId: "sent-1",
    threadId: "thread-1",
  });
  assert.equal(sentRequest?.userId, "me");
  assert.equal(sentRequest?.requestBody?.threadId, "thread-1");

  const raw = Buffer.from(
    sentRequest?.requestBody?.raw ?? "",
    "base64url",
  ).toString("utf8");
  assert.match(raw, /^From: bobby@example\.com\r\n/m);
  assert.match(raw, /^To: Sender <sender@example\.com>\r\n/m);
  assert.match(raw, /^Cc: Teammate <team@example\.com>\r\n/m);
  assert.match(raw, /^Subject: Re: Question\r\n/m);
  assert.match(raw, /^In-Reply-To: <message-1@example\.com>\r\n/m);
  assert.match(raw, /^References: <message-1@example\.com>\r\n/m);

  const encodedBody = raw.split("\r\n\r\n")[1]?.replaceAll("\r\n", "") ?? "";
  assert.equal(
    Buffer.from(encodedBody, "base64").toString("utf8"),
    "Thanks for reaching out.\r\n\r\nKind Regards,\r\nBobby Lawson",
  );
});

test("Gmail provider removes forward prefixes from an outbound subject", async () => {
  let rawMessage = "";
  const client = {
    users: {
      messages: {
        async send(request: { requestBody?: { raw?: string } }) {
          rawMessage = Buffer.from(
            request.requestBody?.raw ?? "",
            "base64url",
          ).toString("utf8");
          return { data: { id: "sent-2", threadId: "thread-2" } };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
  const provider = new GmailEmailProvider(client);

  await provider.sendReply({
    to: ["Recruiter <recruiter@example.com>"],
    cc: [],
    subject: "Fwd: Fw: Interview opportunity",
    textBody: "Thanks for reaching out.",
  });

  assert.match(rawMessage, /^Subject: Re: Interview opportunity\r$/m);
  assert.doesNotMatch(rawMessage, /^(?:Subject: )?.*Fwd?:/im);
  assert.doesNotMatch(rawMessage, /Forwarded message/i);
});
