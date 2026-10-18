import type { Logger } from "pino";

import type { ReasoningEffort } from "../../interfaces/ai-provider.js";
import {
  schedulingReplyIntents,
  type SchedulingReplyInterpretation,
  type SchedulingReplyInterpreter,
} from "../../interfaces/scheduling-reply-interpreter.js";
import { SCHEDULING_REPLY_SYSTEM_PROMPT } from "../../prompts/scheduling-policy.js";

const URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterSchedulingReplyInterpreterOptions {
  apiKey: string;
  model: string;
  timeoutMilliseconds: number;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
  fetchImplementation?: typeof globalThis.fetch;
}

export class OpenRouterSchedulingReplyInterpreter implements SchedulingReplyInterpreter {
  readonly #options: OpenRouterSchedulingReplyInterpreterOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #logger: Logger;

  constructor(logger: Logger, options: OpenRouterSchedulingReplyInterpreterOptions) {
    this.#options = options;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.#logger = logger.child({ component: "scheduling-reply-interpreter" });
  }

  async interpret(input: Parameters<SchedulingReplyInterpreter["interpret"]>[0], signal?: AbortSignal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMilliseconds);
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.#fetch(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildRequest(input, this.#options)),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Scheduling reply interpretation failed with HTTP ${response.status}`);
      return parseResponse(await response.json());
    } catch (error: unknown) {
      this.#logger.warn({ err: error }, "Scheduling reply interpretation failed");
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function buildRequest(input: Parameters<SchedulingReplyInterpreter["interpret"]>[0], options: OpenRouterSchedulingReplyInterpreterOptions): object {
  return {
    model: options.model,
    messages: [
      {
        role: "system",
        content: SCHEDULING_REPLY_SYSTEM_PROMPT,
      },
      { role: "user", content: JSON.stringify({ ...input, anchorIso: input.anchor.toISOString() }) },
    ],
    temperature: 0,
    max_tokens: options.maxOutputTokens,
    reasoning: { effort: options.reasoningEffort ?? "low" },
    provider: { require_parameters: true },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "scheduling_reply",
        strict: true,
        schema: {
          type: "object",
          properties: {
            intent: { type: "string", enum: schedulingReplyIntents },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
            referencesSelectedSlot: { type: "boolean" },
            explicitDate: { type: ["string", "null"] },
            explicitTime: { type: ["string", "null"] },
            timeZone: { type: ["string", "null"] },
            selectedOptionIndex: {
              anyOf: [
                { type: "integer", minimum: 0, maximum: 4 },
                { type: "null" },
              ],
            },
          },
          required: ["intent", "confidence", "reason", "referencesSelectedSlot", "explicitDate", "explicitTime", "timeZone", "selectedOptionIndex"],
          additionalProperties: false,
        },
      },
    },
  };
}

function parseResponse(payload: unknown): SchedulingReplyInterpretation {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) throw new Error("Invalid scheduling reply response");
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== "string") throw new Error("Scheduling reply returned no content");
  const value: unknown = JSON.parse(choice.message.content);
  if (!isRecord(value) || !schedulingReplyIntents.includes(value.intent as never) ||
      typeof value.confidence !== "number" || typeof value.reason !== "string" ||
      typeof value.referencesSelectedSlot !== "boolean" ||
      !(typeof value.explicitDate === "string" || value.explicitDate === null) ||
      !(typeof value.explicitTime === "string" || value.explicitTime === null) ||
      !(typeof value.timeZone === "string" || value.timeZone === null) ||
      !(Number.isInteger(value.selectedOptionIndex) || value.selectedOptionIndex === null)) {
    throw new Error("Scheduling reply returned invalid fields");
  }
  return value as unknown as SchedulingReplyInterpretation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
