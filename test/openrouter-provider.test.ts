import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { readAiProviderFailureDetails } from "../src/interfaces/ai-provider.js";
import { OpenRouterAiProvider } from "../src/integrations/openrouter/openrouter-provider.js";

function completionResponse(
  draftBody = "Thanks for reaching out.",
  reviewerNote = "Confirm availability.",
): Response {
  return new Response(
    JSON.stringify({
      id: "generation-1",
      model: "test/resolved-model",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({ draftBody, reviewerNote }),
          },
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

test("OpenRouter provider requests structured output and parses a draft", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImplementation = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return completionResponse();
  }) as typeof globalThis.fetch;

  const provider = new OpenRouterAiProvider(pino({ level: "silent" }), {
    apiKey: "test-key",
    model: "test/requested-model",
    timeoutMilliseconds: 1_000,
    maxOutputTokens: 500,
    reasoningEffort: "medium",
    fetchImplementation,
    retryDelaysMilliseconds: [0, 0],
  });

  const reply = await provider.generateReply({
    from: "Recruiter <recruiter@example.com>",
    subject: "Interview availability",
    body: "This full message should be sent to the model.",
  });

  assert.equal(requestBody?.model, "test/requested-model");
  assert.equal(requestBody?.max_tokens, 500);
  assert.deepEqual(requestBody?.reasoning, { effort: "medium" });
  assert.deepEqual(requestBody?.provider, { require_parameters: true });
  assert.equal(
    (requestBody?.response_format as { type: string }).type,
    "json_schema",
  );
  assert.match(JSON.stringify(requestBody?.messages), /This full message/);
  assert.match(
    JSON.stringify(requestBody?.messages),
    /I am available between 9:30 AM and 10 AM/,
  );
  assert.equal(
    reply.body,
    "Thanks for reaching out.\n\nKind Regards,\nBobby Lawson",
  );
  assert.equal(reply.reviewerNote, "Confirm availability.");
  assert.equal(reply.resolvedModel, "test/resolved-model");
  assert.equal(reply.promptTokens, 120);
  assert.equal(reply.completionTokens, 30);
});

test("OpenRouter provider removes em dashes from generated email bodies", async () => {
  const provider = new OpenRouterAiProvider(pino({ level: "silent" }), {
    apiKey: "test-key",
    model: "test/model",
    timeoutMilliseconds: 1_000,
    maxOutputTokens: 500,
    fetchImplementation: async () =>
      completionResponse(
        "No problem—1:00 PM CDT works for me.\n\nKind Regards,\nBobby Lawson",
        "",
      ),
  });

  const reply = await provider.generateReply({
    from: "recruiter@example.com",
    subject: "Updated interview time",
    body: "Can you do 1 PM CDT instead?",
  });

  assert.equal(
    reply.body,
    "No problem - 1 PM CDT works for me.\n\nKind Regards,\nBobby Lawson",
  );
  assert.doesNotMatch(reply.body, /—/);
  assert.doesNotMatch(reply.body, /1:00 PM/);
});

test("OpenRouter provider retries transient failures at most three times", async () => {
  let requestCount = 0;
  const fetchImplementation = (async (): Promise<Response> => {
    requestCount += 1;
    return requestCount < 3
      ? new Response(null, { status: 500 })
      : completionResponse("Final reply\n\nKind Regards,\nBobby Lawson", "");
  }) as typeof globalThis.fetch;

  const provider = new OpenRouterAiProvider(pino({ level: "silent" }), {
    apiKey: "test-key",
    model: "test/model",
    timeoutMilliseconds: 1_000,
    maxOutputTokens: 500,
    fetchImplementation,
    retryDelaysMilliseconds: [0, 0],
  });

  const reply = await provider.generateReply({
    from: "person@example.com",
    subject: "Hello",
    body: "Hello Bobby",
  });

  assert.equal(requestCount, 3);
  assert.equal(reply.reviewerNote, null);
  assert.equal(reply.body, "Final reply\n\nKind Regards,\nBobby Lawson");
});

test("OpenRouter provider preserves incomplete completion diagnostics", async () => {
  let requestCount = 0;
  const fetchImplementation = (async (): Promise<Response> => {
    requestCount += 1;
    return new Response(
      JSON.stringify({
        id: "generation-length-1",
        model: "test/resolved-model",
        choices: [
          {
            finish_reason: "length",
            native_finish_reason: "MAX_TOKENS",
            message: { content: "" },
          },
        ],
        usage: { prompt_tokens: 220, completion_tokens: 500 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  const provider = new OpenRouterAiProvider(pino({ level: "silent" }), {
    apiKey: "test-key",
    model: "test/requested-model",
    timeoutMilliseconds: 1_000,
    maxOutputTokens: 500,
    fetchImplementation,
    retryDelaysMilliseconds: [0, 0],
  });

  await assert.rejects(
    provider.generateReply({
      from: "person@example.com",
      subject: "Hello",
      body: "Hello Bobby",
    }),
    (error: unknown) => {
      const details = readAiProviderFailureDetails(error);
      assert.equal(details?.code, "output_limit");
      assert.equal(details?.finishReason, "length");
      assert.equal(details?.nativeFinishReason, "MAX_TOKENS");
      assert.equal(details?.providerResponseId, "generation-length-1");
      assert.equal(details?.completionTokens, 500);
      return true;
    },
  );
  assert.equal(requestCount, 3);
});

test("OpenRouter provider does not retry permanent HTTP failures", async () => {
  let requestCount = 0;
  const fetchImplementation = (async (): Promise<Response> => {
    requestCount += 1;
    return new Response(null, { status: 401 });
  }) as typeof globalThis.fetch;

  const provider = new OpenRouterAiProvider(pino({ level: "silent" }), {
    apiKey: "test-key",
    model: "test/model",
    timeoutMilliseconds: 1_000,
    maxOutputTokens: 500,
    fetchImplementation,
    retryDelaysMilliseconds: [0, 0],
  });

  await assert.rejects(
    provider.generateReply({
      from: "person@example.com",
      subject: "Hello",
      body: "Hello Bobby",
    }),
    /HTTP 401/,
  );
  assert.equal(requestCount, 1);
});

test("OpenRouter provider sends authorized revision instructions separately", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImplementation = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return completionResponse("Updated reply", "");
  }) as typeof globalThis.fetch;
  const provider = new OpenRouterAiProvider(pino({ level: "silent" }), {
    apiKey: "test-key",
    model: "test/model",
    timeoutMilliseconds: 1_000,
    maxOutputTokens: 500,
    fetchImplementation,
    retryDelaysMilliseconds: [0, 0],
  });

  await provider.generateReply({
    from: "person@example.com",
    subject: "Hello",
    body: "Original message",
    revision: {
      previousDraft: "Old response",
      instructions: "Make it shorter",
    },
  });

  const serializedMessages = JSON.stringify(requestBody?.messages);
  assert.match(serializedMessages, /trustedReviewerRequest/);
  assert.match(serializedMessages, /Old response/);
  assert.match(serializedMessages, /Make it shorter/);
});
