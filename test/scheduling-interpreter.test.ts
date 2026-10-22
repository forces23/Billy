import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { OpenRouterSchedulingInterpreter } from "../src/integrations/openrouter/scheduling-interpreter.js";

test("scheduling interpreter requests structured dates without assuming timezone", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const interpreter = new OpenRouterSchedulingInterpreter(
    pino({ level: "silent" }),
    {
      apiKey: "test-key",
      model: "test/model",
      timeoutMilliseconds: 1_000,
      maxOutputTokens: 500,
      fetchImplementation: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [
              {
              finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    summary: "Recruiter screening call",
                    requestedDates: ["2026-03-16"],
                    requestedTime: "14:00",
                    timeZone: null,
                    durationMinutes: 30,
                    availabilityOptionCount: 1,
                    reviewerWantsSelection: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    },
  );

  const result = await interpreter.interpret({
    from: "Recruiter <recruiter@example.com>",
    subject: "Screening call",
    body: "Can we speak next Monday at 2?",
    anchor: new Date("2026-03-10T12:00:00.000Z"),
    defaultTimeZone: "America/Chicago",
  });

  assert.equal(result.timeZone, null);
  assert.equal(result.durationMinutes, 30);
  assert.deepEqual(result.requestedDates, ["2026-03-16"]);
  const messages = requestBody?.messages as Array<{ content: string }>;
  assert.match(messages[0]?.content ?? "", /Do not assume a timezone/);
  assert.match(messages[1]?.content ?? "", /2026-03-10T12:00:00.000Z/);
  assert.deepEqual(
    (requestBody?.response_format as { json_schema: { strict: boolean } })
      .json_schema.strict,
    true,
  );
});

test("scheduling interpreter retries truncated structured output", async () => {
  let attempts = 0;
  const outputTokenBudgets: number[] = [];
  const interpreter = new OpenRouterSchedulingInterpreter(
    pino({ level: "silent" }),
    {
      apiKey: "test-key",
      model: "test/model",
      timeoutMilliseconds: 1_000,
      maxOutputTokens: 500,
      retryDelaysMilliseconds: [0, 0],
      fetchImplementation: async (_input, init) => {
        attempts += 1;
        const request = JSON.parse(String(init?.body)) as {
          max_completion_tokens: number;
        };
        outputTokenBudgets.push(request.max_completion_tokens);
        return new Response(
          JSON.stringify({
            choices: [
              attempts === 1
                ? {
                    finish_reason: "length",
                    message: { content: '{"summary":"Next Wednesday' },
                  }
                : {
                    finish_reason: "stop",
                    message: {
                      content: JSON.stringify({
                        summary: "Call next Wednesday",
                        requestedDates: ["2026-10-21"],
                        requestedTime: null,
                        timeZone: null,
                        durationMinutes: 30,
                        availabilityOptionCount: 3,
                        reviewerWantsSelection: false,
                      }),
                    },
                  },
            ],
          }),
          { status: 200 },
        );
      },
    },
  );

  const result = await interpreter.interpret({
    from: "Bobby",
    subject: "Interview",
    body: "What about next Wednesday?",
    anchor: new Date("2026-10-17T22:03:00.000Z"),
    defaultTimeZone: "America/Chicago",
  });

  assert.equal(attempts, 2);
  assert.deepEqual(outputTokenBudgets, [500, 1_000]);
  assert.deepEqual(result.requestedDates, ["2026-10-21"]);
  assert.equal(result.requestedTime, null);
  assert.equal(result.availabilityOptionCount, 3);
  assert.equal(result.reviewerWantsSelection, false);
});
