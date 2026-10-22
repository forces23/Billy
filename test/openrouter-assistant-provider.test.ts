import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { OpenRouterAssistantProvider } from "../src/integrations/openrouter/assistant-provider.js";

test("OpenRouter assistant sends conversation context and parses text", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new OpenRouterAssistantProvider(pino({ level: "silent" }), {
    apiKey: "test-key",
    model: "test/requested-model",
    timeoutMilliseconds: 1_000,
    fetchImplementation: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "assistant-response-1",
          model: "test/resolved-model",
          choices: [{ message: { content: "Hello from Billy" } }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 4,
            completion_tokens_details: { reasoning_tokens: 2 },
            cost: 0.00042,
          },
        }),
        { status: 200 },
      );
    },
  });

  const response = await provider.respond({
    messages: [{ role: "user", content: "Hello" }],
    context: "Memory #1: The server runs Debian",
  });

  assert.equal(requestBody?.model, "test/requested-model");
  assert.equal("max_completion_tokens" in (requestBody ?? {}), false);
  assert.deepEqual(requestBody?.usage, { include: true });
  assert.deepEqual(requestBody?.reasoning, { effort: "low" });
  assert.match(JSON.stringify(requestBody?.messages), /private personal assistant/);
  assert.match(JSON.stringify(requestBody?.messages), /untrusted reference data/);
  assert.match(JSON.stringify(requestBody?.messages), /server runs Debian/);
  assert.match(JSON.stringify(requestBody?.messages), /Hello/);
  assert.equal(response.text, "Hello from Billy");
  assert.equal(response.resolvedModel, "test/resolved-model");
  assert.equal(response.promptTokens, 20);
  assert.equal(response.reasoningTokens, 2);
  assert.equal(response.costUsd, 0.00042);
});

test("OpenRouter assistant exposes structured tool calls", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new OpenRouterAssistantProvider(pino({ level: "silent" }), {
    apiKey: "test-key",
    model: "test/model",
    timeoutMilliseconds: 1_000,
    fetchImplementation: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "lookup_weather",
                      arguments: JSON.stringify({ location: "Chicago" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  const response = await provider.respond({
    messages: [{ role: "user", content: "How is the weather?" }],
    tools: [
      {
        name: "lookup_weather",
        description: "Look up weather",
        inputSchema: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      },
    ],
  });

  assert.equal(Array.isArray(requestBody?.tools), true);
  assert.equal(requestBody?.tool_choice, "auto");
  assert.deepEqual(response.toolCalls, [
    {
      id: "call-1",
      name: "lookup_weather",
      arguments: { location: "Chicago" },
    },
  ]);
});
