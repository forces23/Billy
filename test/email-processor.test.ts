import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { EmailProcessor } from "../src/core/email-processor.js";
import { createDatabase } from "../src/database/connection.js";
import { SqliteDraftRepository } from "../src/database/repositories/draft-repository.js";
import { SqliteEmailRepository } from "../src/database/repositories/email-repository.js";
import type { AiProvider } from "../src/interfaces/ai-provider.js";
import type { GenerateReplyInput } from "../src/interfaces/ai-provider.js";
import type { EmailCategory } from "../src/interfaces/email-classifier.js";
import type {
  EmailMessage,
  EmailProvider,
} from "../src/interfaces/email-provider.js";

function createMessage(
  providerMessageId: string,
  automationReason: string | null = null,
): EmailMessage {
  return {
    providerMessageId,
    threadId: `thread-${providerMessageId}`,
    messageIdHeader: `<${providerMessageId}@example.com>`,
    from: "Sender <sender@example.com>",
    to: ["bobby@example.com"],
    cc: [],
    replyTo: [],
    subject: "Test subject",
    receivedAt: new Date("2026-10-12T00:00:00.000Z"),
    textBody: "Please reply to this complete message.",
    automationReason,
  };
}

test("processor stores a versioned draft and ignores automated mail", async () => {
  const database = createDatabase(":memory:");

  try {
    const normalMessage = createMessage("normal-1");
    const automatedMessage = createMessage(
      "automated-1",
      "message includes a List-Unsubscribe header",
    );
    const messages = new Map([
      [normalMessage.providerMessageId, normalMessage],
      [automatedMessage.providerMessageId, automatedMessage],
    ]);
    const emailProvider: EmailProvider = {
      async listCandidateMessageIds() {
        return [];
      },
      async getMessage(id) {
        const message = messages.get(id);
        if (!message) throw new Error("Message not found");
        return message;
      },
    };
    let generationCount = 0;
    const aiProvider: AiProvider = {
      async generateReply() {
        generationCount += 1;
        return {
          body: "A generated reply\n\nKind Regards,\nBobby Lawson",
          reviewerNote: "Verify the proposed date.",
          providerResponseId: `response-${generationCount}`,
          requestedModel: "test/model",
          resolvedModel: "test/model",
          promptTokens: 50,
          completionTokens: 20,
        };
      },
    };
    const emailRepository = new SqliteEmailRepository(database);
    const draftRepository = new SqliteDraftRepository(database);
    const processor = new EmailProcessor(
      emailProvider,
      emailRepository,
      draftRepository,
      aiProvider,
      pino({ level: "silent" }),
    );

    await emailRepository.register(normalMessage);
    await emailRepository.register(automatedMessage);
    await processor.processPending();

    const normalEmail = await emailRepository.findByProviderMessageId("normal-1");
    const automatedEmail = await emailRepository.findByProviderMessageId(
      "automated-1",
    );
    const drafts = await draftRepository.listByProviderMessageId("normal-1");

    assert.equal(normalEmail?.status, "awaiting_approval");
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.revision, 1);
    assert.equal(drafts[0]?.reviewerNote, "Verify the proposed date.");
    assert.equal(automatedEmail?.status, "ignored");
    assert.equal(
      automatedEmail?.ignoredReason,
      "message includes a List-Unsubscribe header",
    );
    assert.equal(generationCount, 1);

    const returnedToDrafting = await emailRepository.transitionStatus(
      "normal-1",
      "awaiting_approval",
      "drafting",
    );
    assert.equal(returnedToDrafting, true);

    const secondDraft = await draftRepository.saveAndAwaitApproval("normal-1", {
      body: "A second draft\n\nKind Regards,\nBobby Lawson",
      reviewerNote: null,
      providerResponseId: "response-2",
      requestedModel: "test/model",
      resolvedModel: "test/model",
      promptTokens: 40,
      completionTokens: 15,
    });
    const versionedDrafts = await draftRepository.listByProviderMessageId(
      "normal-1",
    );

    assert.equal(secondDraft?.revision, 2);
    assert.equal(versionedDrafts.length, 2);
    assert.match(versionedDrafts[0]?.body ?? "", /A generated reply/);
    assert.match(versionedDrafts[1]?.body ?? "", /A second draft/);
  } finally {
    database.close();
  }
});

test("processor marks generation failures without stopping the batch", async () => {
  const database = createDatabase(":memory:");

  try {
    const firstMessage = createMessage("failure-1");
    const secondMessage = createMessage("success-2");
    secondMessage.textBody = "This message should produce a successful draft.";
    const messages = new Map([
      [firstMessage.providerMessageId, firstMessage],
      [secondMessage.providerMessageId, secondMessage],
    ]);
    const emailProvider: EmailProvider = {
      async listCandidateMessageIds() {
        return [];
      },
      async getMessage(id) {
        const message = messages.get(id);
        if (!message) throw new Error("Message not found");
        return message;
      },
    };
    const aiProvider: AiProvider = {
      async generateReply(input) {
        if (input.body === firstMessage.textBody) {
          throw new Error("generation unavailable");
        }

        return {
          body: "Reply\n\nKind Regards,\nBobby Lawson",
          reviewerNote: null,
          providerResponseId: "response-success",
          requestedModel: "test/model",
          resolvedModel: "test/model",
          promptTokens: null,
          completionTokens: null,
        };
      },
    };
    const emailRepository = new SqliteEmailRepository(database);
    const draftRepository = new SqliteDraftRepository(database);
    const processor = new EmailProcessor(
      emailProvider,
      emailRepository,
      draftRepository,
      aiProvider,
      pino({ level: "silent" }),
    );

    await emailRepository.register(firstMessage);
    await emailRepository.register(secondMessage);

    assert.equal(await emailRepository.claimForDrafting("failure-1"), true);
    assert.equal(await emailRepository.releaseInterruptedDrafting(), 1);

    await processor.processPending();

    assert.equal(
      (await emailRepository.findByProviderMessageId("failure-1"))?.status,
      "failed",
    );
    assert.equal(
      (await emailRepository.findByProviderMessageId("success-2"))?.status,
      "awaiting_approval",
    );
  } finally {
    database.close();
  }
});

test("processor retries a stored generation failure exactly once", async () => {
  const database = createDatabase(":memory:");

  try {
    const failedMessage = createMessage("manual-retry-1");
    const emailProvider: EmailProvider = {
      async listCandidateMessageIds() {
        return [];
      },
      async getMessage() {
        return failedMessage;
      },
    };
    let shouldFail = true;
    const aiProvider: AiProvider = {
      async generateReply() {
        if (shouldFail) {
          const error = new Error(
            "OpenRouter did not finish normally (finish_reason=length)",
          ) as Error & {
            aiFailure: {
              code: string;
              userMessage: string;
              finishReason: string;
            };
          };
          error.aiFailure = {
            code: "output_limit",
            userMessage: "The model reached its output-token limit.",
            finishReason: "length",
          };
          throw error;
        }

        return {
          body: "Generated after retry\n\nKind Regards,\nBobby Lawson",
          reviewerNote: null,
          providerResponseId: "response-retry",
          requestedModel: "test/model",
          resolvedModel: "test/model",
          promptTokens: 25,
          completionTokens: 10,
        };
      },
    };
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const processor = new EmailProcessor(
      emailProvider,
      emails,
      drafts,
      aiProvider,
      pino({ level: "silent" }),
    );

    await emails.register(failedMessage);
    await processor.processPending();
    const failed = await emails.findByProviderMessageId("manual-retry-1");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.failureStage, "draft_generation");
    assert.equal(failed?.failureCode, "output_limit");
    assert.equal(
      failed?.failureUserMessage,
      "The model reached its output-token limit.",
    );

    shouldFail = false;
    assert.equal(
      await processor.retryFailedGeneration("manual-retry-1"),
      "generated",
    );
    assert.equal(
      await processor.retryFailedGeneration("manual-retry-1"),
      "unavailable",
    );

    const recovered = await emails.findByProviderMessageId("manual-retry-1");
    assert.equal(recovered?.status, "awaiting_approval");
    assert.equal(recovered?.manualRetryCount, 1);
    assert.equal(recovered?.failureStage, null);
    assert.equal((await drafts.listByProviderMessageId("manual-retry-1")).length, 1);
  } finally {
    database.close();
  }
});

test("processor routes classified email conservatively and limits career context", async () => {
  const database = createDatabase(":memory:");

  try {
    const categories: readonly [string, EmailCategory, number][] = [
      ["recruiter", "recruiter_opportunity", 0.98],
      ["qualification", "qualification_question", 0.93],
      ["interview", "interview_scheduling", 0.96],
      ["alert", "job_alert", 0.99],
      ["advertisement", "advertisement", 0.96],
      ["scam", "scam", 0.97],
      ["rejection", "rejection", 0.95],
      ["ordinary", "other", 0.99],
      ["uncertain-scam", "scam", 0.4],
    ];
    const messages = new Map<string, EmailMessage>();
    for (const [id] of categories) {
      const message = createMessage(id);
      message.subject = id;
      messages.set(id, message);
    }

    const emailProvider: EmailProvider = {
      async listCandidateMessageIds() {
        return [];
      },
      async getMessage(id) {
        const message = messages.get(id);
        if (!message) throw new Error("Message not found");
        return message;
      },
    };
    const generatedInputs: GenerateReplyInput[] = [];
    const aiProvider: AiProvider = {
      async generateReply(input) {
        generatedInputs.push(input);
        return {
          body: "Reply\n\nKind Regards,\nBobby Lawson",
          reviewerNote: null,
          providerResponseId: `draft-${input.subject}`,
          requestedModel: "test/draft",
          resolvedModel: "test/draft",
          promptTokens: 10,
          completionTokens: 5,
        };
      },
    };
    let careerLoadCount = 0;
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const processor = new EmailProcessor(
      emailProvider,
      emails,
      drafts,
      aiProvider,
      pino({ level: "silent" }),
      {
        classifier: {
          async classify(input) {
            const entry = categories.find(([id]) => id === input.subject);
            assert.ok(entry);
            return {
              category: entry[1],
              confidence: entry[2],
              reason: "Test classification",
              requestedModel: "test/classifier",
              resolvedModel: "test/classifier",
              providerResponseId: `classification-${entry[0]}`,
            };
          },
        },
        careerContextProvider: {
          async load() {
            careerLoadCount += 1;
            return { workExperience: [{ title: "AI Engineer" }] };
          },
        },
      },
    );

    for (const message of messages.values()) {
      await emails.register(message);
    }
    await processor.processPending();

    assert.equal(careerLoadCount, 2);
    assert.deepEqual(
      generatedInputs.map((input) => input.subject),
      ["recruiter", "qualification", "rejection", "ordinary", "uncertain-scam"],
    );
    assert.ok(generatedInputs[0]?.trustedCareerContext);
    assert.ok(generatedInputs[1]?.trustedCareerContext);
    assert.equal(generatedInputs[2]?.trustedCareerContext, undefined);
    assert.equal(generatedInputs[3]?.trustedCareerContext, undefined);
    assert.equal(generatedInputs[4]?.trustedCareerContext, undefined);

    for (const id of ["interview", "alert", "advertisement", "scam"]) {
      assert.equal((await emails.findByProviderMessageId(id))?.status, "ignored");
      assert.equal((await drafts.listByProviderMessageId(id)).length, 0);
    }
    assert.equal(
      (await emails.findByProviderMessageId("interview"))?.ignoredReason,
      "classification:interview_scheduling",
    );
    assert.equal(
      (await emails.findByProviderMessageId("uncertain-scam"))?.status,
      "awaiting_approval",
    );
  } finally {
    database.close();
  }
});

test("classifier receives the latest classification from the same Gmail thread", async () => {
  const database = createDatabase(":memory:");

  try {
    const first = createMessage("thread-first");
    const second = createMessage("thread-second");
    first.threadId = "gmail-thread-1";
    second.threadId = "gmail-thread-1";
    first.subject = "Initial opportunity";
    second.subject = "Following up";
    const messages = new Map([
      [first.providerMessageId, first],
      [second.providerMessageId, second],
    ]);
    const previousCategories: Array<EmailCategory | null> = [];
    const emailProvider: EmailProvider = {
      async listCandidateMessageIds() {
        return [];
      },
      async getMessage(id) {
        const message = messages.get(id);
        if (!message) throw new Error("Message not found");
        return message;
      },
    };
    const aiProvider: AiProvider = {
      async generateReply() {
        return {
          body: "Reply\n\nKind Regards,\nBobby Lawson",
          reviewerNote: null,
          providerResponseId: "draft",
          requestedModel: "test/draft",
          resolvedModel: "test/draft",
          promptTokens: null,
          completionTokens: null,
        };
      },
    };
    const emails = new SqliteEmailRepository(database);
    const drafts = new SqliteDraftRepository(database);
    const processor = new EmailProcessor(
      emailProvider,
      emails,
      drafts,
      aiProvider,
      pino({ level: "silent" }),
      {
        classifier: {
          async classify(input) {
            previousCategories.push(input.previousThreadCategory);
            return {
              category: "recruiter_opportunity",
              confidence: 0.98,
              reason: "Recruiting conversation",
              requestedModel: "test/classifier",
              resolvedModel: "test/classifier",
              providerResponseId: input.subject,
            };
          },
        },
        careerContextProvider: {
          async load() {
            return { skills: ["TypeScript"] };
          },
        },
      },
    );

    await emails.register(first);
    await processor.processPending();
    await emails.register(second);
    await processor.processPending();

    assert.deepEqual(previousCategories, [null, "recruiter_opportunity"]);
  } finally {
    database.close();
  }
});
