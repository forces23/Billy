import type { Logger } from "pino";

import type {
  SchedulingInterpretInput,
  SchedulingInterpreter,
  SchedulingRequest,
} from "../../interfaces/scheduling-interpreter.js";
import type { ReasoningEffort } from "../../interfaces/ai-provider.js";
import { SCHEDULING_REQUEST_SYSTEM_PROMPT } from "../../prompts/scheduling-policy.js";

const URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MILLISECONDS = [250, 500] as const;
export interface OpenRouterSchedulingInterpreterOptions {
  apiKey: string;
  model: string;
  timeoutMilliseconds: number;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
  fetchImplementation?: typeof globalThis.fetch;
  retryDelaysMilliseconds?: readonly number[];
}

class SchedulingInterpretationError extends Error {
  readonly retryable: boolean;
  readonly truncated: boolean;

  constructor(
    message: string,
    retryable: boolean,
    options?: ErrorOptions & { truncated?: boolean },
  ) {
    super(message, options);
    this.name = "SchedulingInterpretationError";
    this.retryable = retryable;
    this.truncated = options?.truncated ?? false;
  }
}

export class OpenRouterSchedulingInterpreter implements SchedulingInterpreter {
  readonly #options: OpenRouterSchedulingInterpreterOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #logger: Logger;
  readonly #retryDelaysMilliseconds: readonly number[];

  constructor(logger: Logger, options: OpenRouterSchedulingInterpreterOptions) {
    this.#options = options;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.#retryDelaysMilliseconds =
      options.retryDelaysMilliseconds ?? DEFAULT_RETRY_DELAYS_MILLISECONDS;
    if (this.#retryDelaysMilliseconds.length !== MAX_ATTEMPTS - 1) {
      throw new Error("Scheduling interpreter retry delays must contain two values");
    }
    this.#logger = logger.child({ component: "scheduling-interpreter" });
  }

  async interpret(
    input: SchedulingInterpretInput,
    signal?: AbortSignal,
  ): Promise<SchedulingRequest> {
    let lastError: unknown;
    let maxOutputTokens = this.#options.maxOutputTokens;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.#request(input, maxOutputTokens, signal);
      } catch (error: unknown) {
        lastError = error;
        if (
          signal?.aborted ||
          !(error instanceof SchedulingInterpretationError) ||
          !error.retryable ||
          attempt === MAX_ATTEMPTS
        ) {
          this.#logger.warn({ err: error, attempt }, "Scheduling request interpretation failed");
          throw error;
        }

        const delayMilliseconds = this.#retryDelaysMilliseconds[attempt - 1] ?? 0;
        if (error.truncated) {
          maxOutputTokens *= 2;
        }
        this.#logger.warn(
          {
            err: error,
            attempt,
            nextAttempt: attempt + 1,
            delayMilliseconds,
            nextMaxOutputTokens: maxOutputTokens,
          },
          "Scheduling interpretation returned an incomplete response and will be retried",
        );
        await wait(delayMilliseconds, signal);
      }
    }

    throw lastError;
  }

  async #request(
    input: SchedulingInterpretInput,
    maxOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<SchedulingRequest> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#options.timeoutMilliseconds);
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      let response: Response;
      try {
        response = await this.#fetch(URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildRequest(input, this.#options, maxOutputTokens)),
          signal: controller.signal,
        });
      } catch (error: unknown) {
        if (signal?.aborted) throw new Error("Scheduling interpretation was cancelled");
        throw new SchedulingInterpretationError(
          timedOut
            ? "Scheduling interpretation timed out"
            : "Scheduling interpretation network request failed",
          true,
          { cause: error },
        );
      }
      if (!response.ok) {
        throw new SchedulingInterpretationError(
          `Scheduling interpretation failed with HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }
      try {
        return parseResponse(await response.json());
      } catch (error: unknown) {
        if (error instanceof SchedulingInterpretationError) throw error;
        throw new SchedulingInterpretationError(
          "Scheduling interpreter returned unreadable JSON",
          true,
          { cause: error },
        );
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function buildRequest(
  input: SchedulingInterpretInput,
  options: OpenRouterSchedulingInterpreterOptions,
  maxOutputTokens: number,
): object {
  return {
    model: options.model,
    messages: [
      { role: "system", content: SCHEDULING_REQUEST_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          description: "Untrusted scheduling text",
          from: input.from,
          subject: input.subject,
          body: input.body,
          anchorIso: input.anchor.toISOString(),
          defaultTimeZone: input.defaultTimeZone,
          previousRequest: input.previousRequest ?? null,
        }),
      },
    ],
    temperature: 0,
    max_completion_tokens: maxOutputTokens,
    reasoning: { effort: options.reasoningEffort ?? "low" },
    provider: { require_parameters: true },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "scheduling_request",
        strict: true,
        schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            requestedDates: {
              type: "array",
              items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            },
            requestedTime: {
              anyOf: [
                { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
                { type: "null" },
              ],
            },
            timeZone: { type: ["string", "null"] },
            durationMinutes: { type: "integer", minimum: 1, maximum: 480 },
            availabilityOptionCount: { type: "integer", minimum: 1, maximum: 5 },
            reviewerWantsSelection: { type: "boolean" },
          },
          required: ["summary", "requestedDates", "requestedTime", "timeZone", "durationMinutes", "availabilityOptionCount", "reviewerWantsSelection"],
          additionalProperties: false,
        },
      },
    },
  };
}

function parseResponse(payload: unknown): SchedulingRequest {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new SchedulingInterpretationError("Scheduling interpreter returned an invalid response", true);
  }
  const choice = payload.choices[0];
  if (isRecord(choice) && choice.finish_reason !== "stop") {
    const truncated = choice.finish_reason === "length";
    throw new SchedulingInterpretationError(
      `Scheduling interpreter stopped before completion (${String(choice.finish_reason ?? "missing")})`,
      true,
      { truncated },
    );
  }
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== "string") {
    throw new SchedulingInterpretationError("Scheduling interpreter returned no content", true);
  }
  let result: unknown;
  try {
    result = JSON.parse(choice.message.content);
  } catch (error: unknown) {
    throw new SchedulingInterpretationError(
      "Scheduling interpreter returned malformed structured output",
      true,
      { cause: error },
    );
  }
  if (
    !isRecord(result) ||
    typeof result.summary !== "string" ||
    !Array.isArray(result.requestedDates) ||
    !result.requestedDates.every((value) => typeof value === "string") ||
    !(typeof result.requestedTime === "string" || result.requestedTime === null) ||
    !(typeof result.timeZone === "string" || result.timeZone === null) ||
    !Number.isInteger(result.durationMinutes) ||
    !Number.isInteger(result.availabilityOptionCount) ||
    (result.availabilityOptionCount as number) < 1 ||
    (result.availabilityOptionCount as number) > 5 ||
    typeof result.reviewerWantsSelection !== "boolean"
  ) throw new SchedulingInterpretationError("Scheduling interpreter returned invalid structured data", true);
  if (
    !(result.requestedDates as string[]).every(
      (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    ) ||
    (typeof result.requestedTime === "string" &&
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(result.requestedTime))
  ) {
    throw new SchedulingInterpretationError("Scheduling interpreter returned invalid dates or times", true);
  }
  return {
    summary: result.summary,
    requestedDates: result.requestedDates as string[],
    requestedTime: result.requestedTime as string | null,
    timeZone: result.timeZone as string | null,
    durationMinutes: result.durationMinutes as number,
    availabilityOptionCount: result.availabilityOptionCount as number,
    reviewerWantsSelection: result.reviewerWantsSelection,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Scheduling interpretation was cancelled"));
      },
      { once: true },
    );
  });
}
