import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { OpenRouterEmailClassifier } from "../src/integrations/openrouter/email-classifier.js";

test("OpenRouter classifier requests structured output and returns a category", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImplementation = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "classification-1",
        model: "test/resolved-classifier",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                category: "interview_scheduling",
                confidence: 0.97,
                reason: "The sender proposed an interview time.",
                summary: "The recruiter proposed an interview for Thursday at 2 PM.",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  const classifier = new OpenRouterEmailClassifier(pino({ level: "silent" }), {
    apiKey: "test-key",
    model: "test/cheap-model",
    timeoutMilliseconds: 1_000,
    maxOutputTokens: 500,
    reasoningEffort: "low",
    fetchImplementation,
    retryDelaysMilliseconds: [0, 0],
  });

  const result = await classifier.classify({
    from: "Recruiter <recruiter@example.com>",
    subject: "Interview",
    body: "Can you meet Thursday at 2 PM?",
    previousThreadCategory: "recruiter_opportunity",
  });

  assert.equal(requestBody?.model, "test/cheap-model");
  assert.equal(requestBody?.temperature, 0);
  assert.equal(requestBody?.max_tokens, 500);
  assert.deepEqual(requestBody?.reasoning, { effort: "low" });
  assert.match(
    JSON.stringify(requestBody?.messages),
    /recruiter_opportunity/,
  );
  assert.equal(result.category, "interview_scheduling");
  assert.equal(result.confidence, 0.97);
  assert.equal(result.summary, "The recruiter proposed an interview for Thursday at 2 PM.");
  assert.equal(result.resolvedModel, "test/resolved-classifier");
});
