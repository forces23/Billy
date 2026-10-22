import "dotenv/config";

import type { ReasoningEffort } from "../interfaces/ai-provider.js";

// Helper function to read and validate environment variables
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

// If called it will throw an error if the environment variable is not set or is empty
function required(name: string): string {
  const value = read(name);

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

// If called it will return the value of the environment variable or the fallback if not set
function optional(name: string, fallback: number): number;
function optional(name: string, fallback: string): string;
function optional(name: string, fallback: undefined): string | undefined;
function optional(
  name: string,
  fallback: string | number | undefined,
): string | number | undefined {
  const value = process.env[name]?.trim();

  if (!value || (value.startsWith("<") && value.endsWith(">"))) {
    return fallback;
  }

  if (typeof fallback === "number") {
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }

    return parsed;
  }

  return value;
}

function reasoningEffort(
  name: string,
  fallback: ReasoningEffort,
): ReasoningEffort {
  const value = optional(name, fallback);

  if (value !== "low" && value !== "medium" && value !== "high") {
    throw new Error(`${name} must be low, medium, or high`);
  }

  return value;
}

function optionalBoolean(
  name: string,
  fallback: boolean | undefined,
): boolean | undefined {
  const value = read(name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
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
  get google() {
    return Object.freeze({
      clientId: required("GOOGLE_CLIENT_ID"),
      clientSecret: required("GOOGLE_CLIENT_SECRET"),
      refreshToken: required("GOOGLE_REFRESH_TOKEN"),
      userId: optional("GMAIL_USER_ID", "me"),
    });
  },

  get openRouter() {
    const model = required("OPENROUTER_MODEL");
    return Object.freeze({
      apiKey: required("OPENROUTER_API_KEY"),
      model,
      classifierModel: optional("OPENROUTER_CLASSIFIER_MODEL", model),
      assistantModel: optional(
        "OPENROUTER_ASSISTANT_MODEL",
        "google/gemini-flash-latest",
      ),
      timeoutMilliseconds: optional("OPENROUTER_TIMEOUT_MS", 30_000),
      draftReasoningEffort: reasoningEffort("OPENROUTER_DRAFT_REASONING_EFFORT", "medium"),
      classifierReasoningEffort: reasoningEffort("OPENROUTER_CLASSIFIER_REASONING_EFFORT", "low"),
      assistantReasoningEffort: reasoningEffort("OPENROUTER_ASSISTANT_REASONING_EFFORT", "low"),
      maxOutputTokens: optional("OPENROUTER_MAX_OUTPUT_TOKENS", 3_000),
      classifierMaxOutputTokens: optional("OPENROUTER_CLASSIFIER_MAX_OUTPUT_TOKENS", 500),
      schedulingMaxOutputTokens: optional("OPENROUTER_SCHEDULING_MAX_OUTPUT_TOKENS", 1_000),
    });
  },

  get discord() {
    const mainChannelId = optional("DISCORD_MAIN_CHANNEL_ID", "");
    const ownerUserId = optional("DISCORD_OWNER_USER_ID", "");
    const configuredAssistantEnabled = optionalBoolean(
      "BILLY_ASSISTANT_ENABLED",
      undefined,
    );
    const assistantEnabled = configuredAssistantEnabled ?? Boolean(
      mainChannelId && ownerUserId,
    );
    if (assistantEnabled && !mainChannelId) {
      throw new Error(
        "DISCORD_MAIN_CHANNEL_ID is required when BILLY_ASSISTANT_ENABLED is true",
      );
    }
    if (assistantEnabled && !ownerUserId) {
      throw new Error(
        "DISCORD_OWNER_USER_ID is required when BILLY_ASSISTANT_ENABLED is true",
      );
    }

    return Object.freeze({
      botToken: required("DISCORD_BOT_TOKEN"),
      assistantEnabled,
      mainChannelId,
      ownerUserId,
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
      pollIntervalSeconds: optional("GMAIL_POLL_INTERVAL_SECONDS", 60),
      sendIntervalSeconds: optional("GMAIL_SEND_INTERVAL_SECONDS", 2),
      ownAddresses: commaSeparatedList("GMAIL_OWN_ADDRESSES"),
      trustedForwarderAddresses: commaSeparatedList("GMAIL_TRUSTED_FORWARDER_ADDRESSES"),
    });
  },

  get calendar() {
    const billyCalendarId = required("GOOGLE_CALENDAR_BILLY_ID");
    const sharedCalendars = commaSeparatedList("GOOGLE_CALENDAR_SHARED_IDS")
      .map((id, index) => Object.freeze({ id, label: `shared-calendar-${index}` }));

    return Object.freeze({
      billyCalendarId,
      calendars: Object.freeze([
        Object.freeze({ id: billyCalendarId, label: "Billy" }),
        ...sharedCalendars,
      ]),
      timeZone: optional("SCHEDULING_TIME_ZONE", "America/Chicago"),
      workdayStartHour: optional("SCHEDULING_WORKDAY_START_HOUR", 9),
      workdayEndHour: optional("SCHEDULING_WORKDAY_END_HOUR", 18),
      defaultDurationMinutes: optional("SCHEDULING_DEFAULT_DURATION_MINUTES", 30),
      bufferAfterMinutes: optional("SCHEDULING_BUFFER_AFTER_MINUTES", 15),
      searchBusinessDays: optional("SCHEDULING_SEARCH_BUSINESS_DAYS", 10),
    });
  },

  logLevel: optional("LOG_LEVEL", "info"),
});

export type Environment = typeof env;
