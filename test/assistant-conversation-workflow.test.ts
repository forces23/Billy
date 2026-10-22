import assert from "node:assert/strict";
import test from "node:test";

import {
  AssistantConversationWorkflow,
  estimateAssistantTokens,
  selectRecentContext,
} from "../src/core/assistant-conversation-workflow.js";
import { createDatabase } from "../src/database/connection.js";
import { SqliteAssistantConversationRepository } from "../src/database/repositories/assistant-conversation-repository.js";
import type {
  AssistantProvider,
  AssistantRequest,
  AssistantResponse,
} from "../src/interfaces/assistant-provider.js";

class FakeAssistantProvider implements AssistantProvider {
  readonly requests: AssistantRequest[] = [];

  async respond(input: AssistantRequest): Promise<AssistantResponse> {
    this.requests.push(input);
    return {
      text: `Reply ${this.requests.length}`,
      toolCalls: [],
      providerResponseId: `response-${this.requests.length}`,
      requestedModel: "test/model",
      resolvedModel: "test/model",
      promptTokens: 10,
      completionTokens: 5,
      reasoningTokens: 2,
      costUsd: 0.0001,
    };
  }
}

test("assistant workflow persists context, completes replies, and ignores duplicates", async () => {
  const database = createDatabase(":memory:");
  try {
    const repository = new SqliteAssistantConversationRepository(database);
    const provider = new FakeAssistantProvider();
    const workflow = new AssistantConversationWorkflow(provider, repository);
    const first = {
      discordMessageId: "user-message-1",
      channelId: "main",
      userId: "owner",
      body: "My favorite color is blue.",
    };

    const firstOutcome = await workflow.begin(first);
    assert.equal(firstOutcome.kind, "response");
    if (firstOutcome.kind !== "response") return;
    await workflow.complete(first, firstOutcome, "assistant-message-1");

    assert.deepEqual(provider.requests[0]?.messages, [
      { role: "user", content: "My favorite color is blue." },
    ]);
    assert.deepEqual(await workflow.begin(first), { kind: "duplicate" });

    const second = {
      discordMessageId: "user-message-2",
      channelId: "main",
      userId: "owner",
      body: "What is my favorite color?",
    };
    const secondOutcome = await workflow.begin(second);
    assert.equal(secondOutcome.kind, "response");
    assert.deepEqual(provider.requests[1]?.messages, [
      { role: "user", content: "My favorite color is blue." },
      { role: "assistant", content: "Reply 1" },
      { role: "user", content: "What is my favorite color?" },
    ]);
  } finally {
    database.close();
  }
});

test("assistant workflow resets recent context without deleting stored history", async () => {
  const database = createDatabase(":memory:");
  try {
    const repository = new SqliteAssistantConversationRepository(database);
    const provider = new FakeAssistantProvider();
    const workflow = new AssistantConversationWorkflow(provider, repository);
    await repository.appendMessage({
      channelId: "main",
      userId: "owner",
      discordMessageId: "old-message",
      role: "user",
      body: "Old context",
    });
    const reset = {
      discordMessageId: "reset-message",
      channelId: "main",
      userId: "owner",
      body: "Reset our conversation!",
    };

    const outcome = await workflow.begin(reset);
    assert.deepEqual(outcome, {
      kind: "local",
      response: "I cleared our recent conversation context. Your saved history and memories are still available for search.",
    });
    if (outcome.kind === "duplicate") return;
    await workflow.complete(reset, outcome, "reset-response");

    assert.equal(provider.requests.length, 0);
    assert.equal((await repository.listRecent("main", 40)).length, 1);
    const stored = database.prepare<[], { count: number }>(`
      SELECT COUNT(*) AS count FROM assistant_conversation_messages
    `).get();
    assert.equal(stored?.count, 3);
  } finally {
    database.close();
  }
});

test("assistant workflow handles memory commands locally", async () => {
  const database = createDatabase(":memory:");
  try {
    const repository = new SqliteAssistantConversationRepository(database);
    const provider = new FakeAssistantProvider();
    const workflow = new AssistantConversationWorkflow(provider, repository);
    const remember = {
      discordMessageId: "remember-1",
      channelId: "main",
      userId: "owner",
      body: "Remember that my server runs Debian.",
    };
    const saved = await workflow.begin(remember);
    assert.equal(saved.kind, "local");
    assert.match(saved.kind === "local" ? saved.response : "", /Remembered as #1/);
    if (saved.kind === "duplicate") return;
    await workflow.complete(remember, saved, "remember-response");

    const list = {
      discordMessageId: "list-1",
      channelId: "main",
      userId: "owner",
      body: "What do you remember?",
    };
    const listed = await workflow.begin(list);
    assert.match(listed.kind === "local" ? listed.response : "", /server runs Debian/);
    assert.equal(provider.requests.length, 0);
  } finally {
    database.close();
  }
});

test("assistant workflow retrieves relevant older history without resending it all", async () => {
  const database = createDatabase(":memory:");
  try {
    const repository = new SqliteAssistantConversationRepository(database);
    const provider = new FakeAssistantProvider();
    const workflow = new AssistantConversationWorkflow(provider, repository);
    await repository.appendMessage({
      channelId: "main",
      userId: "owner",
      discordMessageId: "old-server-detail",
      role: "user",
      body: "My home server uses Caddy as the reverse proxy.",
    });
    await repository.resetConversation("main");
    const question = {
      discordMessageId: "question-1",
      channelId: "main",
      userId: "owner",
      body: "What reverse proxy does my server use?",
    };

    const outcome = await workflow.begin(question);
    assert.equal(outcome.kind, "response");
    assert.deepEqual(provider.requests[0]?.messages, [
      { role: "user", content: question.body },
    ]);
    assert.match(provider.requests[0]?.context ?? "", /Caddy/);
  } finally {
    database.close();
  }
});

test("assistant recent context is constrained by both message and token budgets", () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    channelId: "main",
    userId: "owner",
    discordMessageId: `message-${index}`,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: "x".repeat(80),
    createdAt: new Date("2026-10-21T12:00:00.000Z"),
  }));
  const selected = selectRecentContext(messages, 6, 55);
  assert.ok(selected.length <= 2);
  assert.ok(selected.reduce(
    (total, message) => total + estimateAssistantTokens(message.content),
    0,
  ) <= 55);
  assert.notEqual(selected[0]?.role, "assistant");
});
