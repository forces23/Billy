import "dotenv/config";

import type { ReasoningEffort } from "../interfaces/ai-provider.js";

function read(name: string): string | undefined {
  const value = process.env[name]?.trim();

  if (!value) {
    return undefined;
  }

  if (value.startsWith("<") && value.endsWith(">")) {
    throw new Error(
      `Environment variable ${name} still contains an example value`,
    );
  }

  return value;
}

function required(name: string): string {
  const value = read(name);

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optional(name: string, fallback: string): string {
  return read(name) ?? fallback;
}

function optionalUnconfigured(name: string): string | undefined {
  const value = process.env[name]?.trim();

  if (!value || (value.startsWith("<") && value.endsWith(">"))) {
    return undefined;
  }

  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = read(name);

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function reasoningEffort(
  name: string,
  fallback: ReasoningEffort,
): ReasoningEffort {
  const value = read(name) ?? fallback;
  if (value !== "low" && value !== "medium" && value !== "high") {
    throw new Error(`${name} must be low, medium, or high`);
  }
  return value;
}

function commaSeparatedList(name: string): readonly string[] {
  const values = required(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }

  return Object.freeze(values);
}

export const env = Object.freeze({
  google: Object.freeze({
    clientId: required("GOOGLE_CLIENT_ID"),
    clientSecret: required("GOOGLE_CLIENT_SECRET"),
    refreshToken: required("GOOGLE_REFRESH_TOKEN"),
    userId: optional("GMAIL_USER_ID", "me"),
  }),

  get openRouter() {
    const model = required("OPENROUTER_MODEL");
    return Object.freeze({
      apiKey: required("OPENROUTER_API_KEY"),
      model,
      classifierModel:
        optionalUnconfigured("OPENROUTER_CLASSIFIER_MODEL") ?? model,
      timeoutMilliseconds: positiveInteger("OPENROUTER_TIMEOUT_MS", 30_000),
      draftReasoningEffort: reasoningEffort(
        "OPENROUTER_DRAFT_REASONING_EFFORT",
        "medium",
      ),
      classifierReasoningEffort: reasoningEffort(
        "OPENROUTER_CLASSIFIER_REASONING_EFFORT",
        "low",
      ),
      maxOutputTokens: positiveInteger(
        "OPENROUTER_MAX_OUTPUT_TOKENS",
        3_000,
      ),
      classifierMaxOutputTokens: positiveInteger(
        "OPENROUTER_CLASSIFIER_MAX_OUTPUT_TOKENS",
        500,
      ),
    });
  },

  get discord() {
    return Object.freeze({
      botToken: required("DISCORD_BOT_TOKEN"),
      mainChannelId: optionalUnconfigured("DISCORD_MAIN_CHANNEL_ID"),
      emailChannelId: required("DISCORD_EMAIL_CHANNEL_ID"),
      approverUserIds: commaSeparatedList("DISCORD_APPROVER_USER_IDS"),
    });
  },

  get database() {
    return Object.freeze({
      path: optional("DATABASE_PATH", "./data/billy.sqlite"),
    });
  },

  get profile() {
    return Object.freeze({
      careerPath: optional("PROFILE_CAREER_PATH", "./profile/career.json"),
    });
  },

  get gmail() {
    return Object.freeze({
      pollIntervalSeconds: positiveInteger(
        "GMAIL_POLL_INTERVAL_SECONDS",
        60,
      ),
      sendIntervalSeconds: positiveInteger(
        "GMAIL_SEND_INTERVAL_SECONDS",
        2,
      ),
      ownAddresses: commaSeparatedList("GMAIL_OWN_ADDRESSES"),
      trustedForwarderAddresses: commaSeparatedList(
        "GMAIL_TRUSTED_FORWARDER_ADDRESSES",
      ),
    });
  },

  logLevel: optional("LOG_LEVEL", "info"),
});

export type Environment = typeof env;
