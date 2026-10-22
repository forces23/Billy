import assert from "node:assert/strict";
import test from "node:test";

import { env } from "../src/config/env.js";

const openRouterVariables = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_CLASSIFIER_MODEL",
  "OPENROUTER_ASSISTANT_MODEL",
  "OPENROUTER_TIMEOUT_MS",
  "OPENROUTER_DRAFT_REASONING_EFFORT",
  "OPENROUTER_CLASSIFIER_REASONING_EFFORT",
  "OPENROUTER_ASSISTANT_REASONING_EFFORT",
  "OPENROUTER_MAX_OUTPUT_TOKENS",
  "OPENROUTER_CLASSIFIER_MAX_OUTPUT_TOKENS",
  "OPENROUTER_SCHEDULING_MAX_OUTPUT_TOKENS",
] as const;

test("environment converts numeric settings and preserves typed choices", () => {
  withEnvironment(
    {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "test/model",
      OPENROUTER_CLASSIFIER_MODEL: undefined,
      OPENROUTER_TIMEOUT_MS: "45000",
      OPENROUTER_DRAFT_REASONING_EFFORT: "high",
      OPENROUTER_CLASSIFIER_REASONING_EFFORT: "low",
      OPENROUTER_MAX_OUTPUT_TOKENS: "2500",
      OPENROUTER_CLASSIFIER_MAX_OUTPUT_TOKENS: "400",
      OPENROUTER_SCHEDULING_MAX_OUTPUT_TOKENS: "900",
    },
    () => {
      const config = env.openRouter;

      assert.equal(config.classifierModel, "test/model");
      assert.equal(config.assistantModel, "google/gemini-flash-latest");
      assert.equal(config.timeoutMilliseconds, 45_000);
      assert.equal(typeof config.timeoutMilliseconds, "number");
      assert.equal(config.draftReasoningEffort, "high");
      assert.equal(config.classifierReasoningEffort, "low");
      assert.equal(config.assistantReasoningEffort, "low");
      assert.equal(config.maxOutputTokens, 2_500);
      assert.equal(config.classifierMaxOutputTokens, 400);
      assert.equal(config.schedulingMaxOutputTokens, 900);
    },
  );
});

test("environment rejects invalid numeric and reasoning settings", () => {
  withEnvironment(
    defaultOpenRouterEnvironment({ OPENROUTER_TIMEOUT_MS: "3.5" }),
    () => {
      assert.throws(
        () => env.openRouter,
        /OPENROUTER_TIMEOUT_MS must be a positive integer/,
      );
    },
  );

  withEnvironment(
    defaultOpenRouterEnvironment({
      OPENROUTER_DRAFT_REASONING_EFFORT: "extreme",
    }),
    () => {
      assert.throws(
        () => env.openRouter,
        /OPENROUTER_DRAFT_REASONING_EFFORT must be low, medium, or high/,
      );
    },
  );
});

test("environment ignores example placeholders for optional settings", () => {
  withEnvironment(
    defaultOpenRouterEnvironment({
      OPENROUTER_CLASSIFIER_MODEL: "<provider/cheap-model-name>",
    }),
    () => {
      assert.equal(env.openRouter.classifierModel, "test/model");
    },
  );

  withEnvironment(
    {
      DISCORD_BOT_TOKEN: "test-token",
      BILLY_ASSISTANT_ENABLED: "false",
      DISCORD_MAIN_CHANNEL_ID: "<your-discord-channel-id>",
      DISCORD_OWNER_USER_ID: undefined,
      DISCORD_EMAIL_CHANNEL_ID: "email-channel",
      DISCORD_APPROVER_USER_IDS: "approver-1",
    },
    () => {
      assert.equal(env.discord.mainChannelId, "");
    },
  );
});

test("environment requires assistant ownership and channel settings when enabled", () => {
  withEnvironment(
    {
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_EMAIL_CHANNEL_ID: "email-channel",
      DISCORD_APPROVER_USER_IDS: "approver-1",
      BILLY_ASSISTANT_ENABLED: "true",
      DISCORD_MAIN_CHANNEL_ID: "main-channel",
      DISCORD_OWNER_USER_ID: "owner-1",
    },
    () => {
      const config = env.discord;
      assert.equal(config.assistantEnabled, true);
      assert.equal(config.mainChannelId, "main-channel");
      assert.equal(config.ownerUserId, "owner-1");
    },
  );

  withEnvironment(
    {
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_EMAIL_CHANNEL_ID: "email-channel",
      DISCORD_APPROVER_USER_IDS: "approver-1",
      BILLY_ASSISTANT_ENABLED: "true",
      DISCORD_MAIN_CHANNEL_ID: undefined,
      DISCORD_OWNER_USER_ID: "owner-1",
    },
    () => {
      assert.throws(
        () => env.discord,
        /DISCORD_MAIN_CHANNEL_ID is required/,
      );
    },
  );
});

test("environment enables the assistant when both required IDs are configured", () => {
  withEnvironment(
    {
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_EMAIL_CHANNEL_ID: "email-channel",
      DISCORD_APPROVER_USER_IDS: "approver-1",
      BILLY_ASSISTANT_ENABLED: undefined,
      DISCORD_MAIN_CHANNEL_ID: "main-channel",
      DISCORD_OWNER_USER_ID: "owner-1",
    },
    () => {
      assert.equal(env.discord.assistantEnabled, true);
    },
  );
});

function defaultOpenRouterEnvironment(
  overrides: Partial<Record<(typeof openRouterVariables)[number], string>>,
): Record<(typeof openRouterVariables)[number], string | undefined> {
  return {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "test/model",
    OPENROUTER_CLASSIFIER_MODEL: undefined,
    OPENROUTER_ASSISTANT_MODEL: undefined,
    OPENROUTER_TIMEOUT_MS: undefined,
    OPENROUTER_DRAFT_REASONING_EFFORT: undefined,
    OPENROUTER_CLASSIFIER_REASONING_EFFORT: undefined,
    OPENROUTER_ASSISTANT_REASONING_EFFORT: undefined,
    OPENROUTER_MAX_OUTPUT_TOKENS: undefined,
    OPENROUTER_CLASSIFIER_MAX_OUTPUT_TOKENS: undefined,
    OPENROUTER_SCHEDULING_MAX_OUTPUT_TOKENS: undefined,
    ...overrides,
  };
}

function withEnvironment(
  values: Readonly<Record<string, string | undefined>>,
  run: () => void,
): void {
  const previous = new Map<string, string | undefined>();

  try {
    for (const [name, value] of Object.entries(values)) {
      previous.set(name, process.env[name]);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
