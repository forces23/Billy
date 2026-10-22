import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase } from "../src/database/connection.js";
import { SqliteAssistantConversationRepository } from "../src/database/repositories/assistant-conversation-repository.js";

test("assistant repository retains all messages while bounding recent reads", async () => {
  const database = createDatabase(":memory:");
  try {
    const repository = new SqliteAssistantConversationRepository(database, {
      now: () => new Date("2026-10-21T12:00:00.000Z"),
    });
    const inbound = {
      discordMessageId: "incoming-1",
      channelId: "main",
      userId: "owner",
      body: "Hello",
    };
    assert.equal(await repository.claimInbound(inbound), true);
    assert.equal(await repository.claimInbound(inbound), false);

    for (let turn = 0; turn < 22; turn += 1) {
      await repository.appendMessage({
        channelId: "main",
        userId: "owner",
        discordMessageId: `user-${turn}`,
        role: "user",
        body: `question-${turn}`,
      });
      await repository.appendMessage({
        channelId: "main",
        userId: "owner",
        discordMessageId: `assistant-${turn}`,
        role: "assistant",
        body: `answer-${turn}`,
      });
    }

    const recent = await repository.listRecent("main", 40);
    assert.equal(recent.length, 40);
    assert.equal(recent[0]?.content, "question-2");
    assert.equal(recent.at(-1)?.content, "answer-21");
    const stored = database.prepare<[], { count: number }>(`
      SELECT COUNT(*) AS count FROM assistant_conversation_messages
    `).get();
    assert.equal(stored?.count, 44);
    assert.equal(await repository.completeInbound("incoming-1"), true);
    assert.equal(await repository.completeInbound("incoming-1"), false);
  } finally {
    database.close();
  }
});

test("assistant repository preserves failed and reset history for FTS retrieval", async () => {
  const database = createDatabase(":memory:");
  try {
    const repository = new SqliteAssistantConversationRepository(database);
    const inbound = {
      discordMessageId: "incoming-failed",
      channelId: "main",
      userId: "owner",
      body: "The server uses Caddy as its reverse proxy",
    };
    await repository.claimInbound(inbound);
    await repository.appendMessage({
      channelId: inbound.channelId,
      userId: inbound.userId,
      discordMessageId: inbound.discordMessageId,
      role: "user",
      body: inbound.body,
    });

    assert.equal(await repository.failInbound(inbound.discordMessageId, "boom"), true);
    assert.equal((await repository.listRecent("main", 40)).length, 1);
    assert.equal(await repository.claimInbound(inbound), false);
    assert.equal(await repository.resetConversation("main"), 1);
    assert.deepEqual(await repository.listRecent("main", 40), []);

    const matches = await repository.searchHistory(
      "main",
      "What reverse proxy does my server use?",
      Number.MAX_SAFE_INTEGER,
      5,
    );
    assert.equal(matches.length, 1);
    assert.match(matches[0]?.content ?? "", /Caddy/);
  } finally {
    database.close();
  }
});

test("assistant repository stores durable memories and provider usage", async () => {
  const database = createDatabase(":memory:");
  try {
    const repository = new SqliteAssistantConversationRepository(database, {
      now: () => new Date("2026-10-21T12:00:00.000Z"),
    });
    const memory = await repository.saveMemory({
      channelId: "main",
      content: "My server runs Debian",
      sourceDiscordMessageId: "remember-1",
    });
    assert.equal(memory.id, 1);
    assert.equal((await repository.listMemories("main", 10)).length, 1);
    assert.equal(await repository.forgetMemory("main", memory.id), true);
    assert.deepEqual(await repository.listMemories("main", 10), []);

    assert.equal(await repository.recordUsage({
      inboundDiscordMessageId: "request-1",
      providerResponseId: "response-1",
      requestedModel: "google/gemini-flash-latest",
      resolvedModel: "google/gemini-3.8-flash",
      promptTokens: 1_200,
      completionTokens: 150,
      reasoningTokens: 40,
      costUsd: 0.0015,
    }), true);
    assert.equal(await repository.recordUsage({
      inboundDiscordMessageId: "request-1",
      providerResponseId: "response-1",
      requestedModel: "google/gemini-flash-latest",
      resolvedModel: "google/gemini-3.8-flash",
      promptTokens: 1_200,
      completionTokens: 150,
      reasoningTokens: 40,
      costUsd: 0.0015,
    }), false);
    assert.deepEqual(await repository.getUsageSummary(), {
      requestCount: 1,
      promptTokens: 1_200,
      completionTokens: 150,
      reasoningTokens: 40,
      costUsd: 0.0015,
      requestsWithCost: 1,
    });
  } finally {
    database.close();
  }
});
