import type {
  AssistantConversationMessage,
  AssistantConversationRepository,
  AssistantInboundMessage,
  AssistantMemory,
  AssistantUsageSummary,
} from "../interfaces/assistant-conversation-repository.js";
import type {
  AssistantProvider,
  AssistantResponse,
} from "../interfaces/assistant-provider.js";

const DEFAULT_RECENT_MESSAGE_LIMIT = 40;
const DEFAULT_RECENT_TOKEN_BUDGET = 2_500;
const DEFAULT_MEMORY_TOKEN_BUDGET = 500;
const DEFAULT_HISTORY_TOKEN_BUDGET = 1_500;
const MAX_RETRIEVED_ITEMS = 5;
const RESET_RESPONSE =
  "I cleared our recent conversation context. Your saved history and memories are still available for search.";

export type AssistantConversationOutcome =
  | { kind: "duplicate" }
  | { kind: "local"; response: string }
  | { kind: "response"; response: string; provider: AssistantResponse };

interface WorkflowOptions {
  recentMessageLimit?: number;
  recentTokenBudget?: number;
  memoryTokenBudget?: number;
  historyTokenBudget?: number;
  now?: () => Date;
}

type LocalCommand =
  | { kind: "reset" }
  | { kind: "remember"; content: string }
  | { kind: "list-memories"; query?: string }
  | { kind: "forget-memory"; id: number }
  | { kind: "forget-text"; content: string }
  | { kind: "usage" };

export class AssistantConversationWorkflow {
  readonly #provider: AssistantProvider;
  readonly #repository: AssistantConversationRepository;
  readonly #recentMessageLimit: number;
  readonly #recentTokenBudget: number;
  readonly #memoryTokenBudget: number;
  readonly #historyTokenBudget: number;
  readonly #now: () => Date;

  constructor(
    provider: AssistantProvider,
    repository: AssistantConversationRepository,
    options: WorkflowOptions = {},
  ) {
    this.#recentMessageLimit = positiveInteger(
      options.recentMessageLimit ?? DEFAULT_RECENT_MESSAGE_LIMIT,
      "Assistant recent message limit",
    );
    this.#recentTokenBudget = positiveInteger(
      options.recentTokenBudget ?? DEFAULT_RECENT_TOKEN_BUDGET,
      "Assistant recent token budget",
    );
    this.#memoryTokenBudget = positiveInteger(
      options.memoryTokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET,
      "Assistant memory token budget",
    );
    this.#historyTokenBudget = positiveInteger(
      options.historyTokenBudget ?? DEFAULT_HISTORY_TOKEN_BUDGET,
      "Assistant history token budget",
    );
    this.#provider = provider;
    this.#repository = repository;
    this.#now = options.now ?? (() => new Date());
  }

  async begin(
    input: AssistantInboundMessage,
    signal?: AbortSignal,
  ): Promise<AssistantConversationOutcome> {
    const claimed = await this.#repository.claimInbound(input);
    if (!claimed) return { kind: "duplicate" };

    await this.#repository.appendMessage({
      channelId: input.channelId,
      userId: input.userId,
      discordMessageId: input.discordMessageId,
      role: "user",
      body: input.body,
    });

    try {
      const command = parseLocalCommand(input.body);
      if (command) {
        return {
          kind: "local",
          response: await this.#runLocalCommand(input, command),
        };
      }

      const recentRows = await this.#repository.listRecent(
        input.channelId,
        this.#recentMessageLimit,
      );
      const recent = selectRecentContext(
        recentRows,
        this.#recentMessageLimit,
        this.#recentTokenBudget,
      );
      const oldestRecentId = recent[0]?.id ?? Number.MAX_SAFE_INTEGER;
      const [memories, historicalRows] = await Promise.all([
        this.#repository.listMemories(input.channelId, 100),
        this.#repository.searchHistory(
          input.channelId,
          input.body,
          oldestRecentId,
          MAX_RETRIEVED_ITEMS * 2,
        ),
      ]);
      const context = buildRetrievedContext(
        selectRelevantMemories(memories, input.body),
        historicalRows,
        this.#memoryTokenBudget,
        this.#historyTokenBudget,
      );
      const provider = await this.#provider.respond(
        {
          messages: recent.map(({ role, content }) => ({ role, content })),
          ...(context ? { context } : {}),
        },
        signal,
      );
      await this.#repository.recordUsage({
        inboundDiscordMessageId: input.discordMessageId,
        providerResponseId: provider.providerResponseId,
        requestedModel: provider.requestedModel,
        resolvedModel: provider.resolvedModel,
        promptTokens: provider.promptTokens,
        completionTokens: provider.completionTokens,
        reasoningTokens: provider.reasoningTokens,
        costUsd: provider.costUsd,
      });

      if (provider.toolCalls.length > 0) {
        throw new Error("Assistant returned a tool call when no tools were available");
      }
      const response = provider.text?.trim();
      if (!response) throw new Error("Assistant returned an empty response");
      return { kind: "response", response, provider };
    } catch (error: unknown) {
      await this.fail(input.discordMessageId, error);
      throw error;
    }
  }

  async complete(
    input: AssistantInboundMessage,
    outcome: Exclude<AssistantConversationOutcome, { kind: "duplicate" }>,
    responseDiscordMessageId: string,
  ): Promise<void> {
    await this.#repository.appendMessage({
      channelId: input.channelId,
      userId: input.userId,
      discordMessageId: responseDiscordMessageId,
      role: "assistant",
      body: outcome.response,
    });

    const completed = await this.#repository.completeInbound(input.discordMessageId);
    if (!completed) throw new Error("Assistant inbound message could not be completed");
  }

  async fail(discordMessageId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "Unknown assistant failure";
    await this.#repository.failInbound(discordMessageId, message);
  }

  async #runLocalCommand(
    input: AssistantInboundMessage,
    command: LocalCommand,
  ): Promise<string> {
    if (command.kind === "reset") {
      await this.#repository.resetConversation(input.channelId);
      return RESET_RESPONSE;
    }
    if (command.kind === "remember") {
      const memory = await this.#repository.saveMemory({
        channelId: input.channelId,
        content: command.content,
        sourceDiscordMessageId: input.discordMessageId,
      });
      return `Remembered as #${memory.id}: ${memory.content}`;
    }
    if (command.kind === "forget-memory") {
      const forgotten = await this.#repository.forgetMemory(
        input.channelId,
        command.id,
      );
      return forgotten
        ? `Forgot memory #${command.id}.`
        : `I could not find active memory #${command.id}.`;
    }
    if (command.kind === "forget-text") {
      const memories = await this.#repository.listMemories(input.channelId, 100);
      const target = normalizeText(command.content);
      const memory = memories.find((item) => normalizeText(item.content) === target);
      if (!memory) return "I could not find an exact saved memory matching that.";
      await this.#repository.forgetMemory(input.channelId, memory.id);
      return `Forgot memory #${memory.id}: ${memory.content}`;
    }
    if (command.kind === "list-memories") {
      const memories = await this.#repository.listMemories(input.channelId, 100);
      const relevant = command.query
        ? selectRelevantMemories(memories, command.query)
        : memories.slice(0, 20);
      if (relevant.length === 0) return "I do not have any matching saved memories.";
      return [
        command.query ? "Matching saved memories:" : "Saved memories:",
        ...relevant.map((memory) => `#${memory.id} — ${memory.content}`),
      ].join("\n");
    }

    const since = new Date(this.#now());
    since.setUTCDate(since.getUTCDate() - 30);
    const [recent, lifetime] = await Promise.all([
      this.#repository.getUsageSummary(since),
      this.#repository.getUsageSummary(),
    ]);
    return formatUsage(recent, lifetime);
  }
}

export function isResetConversationRequest(body: string): boolean {
  return parseLocalCommand(body)?.kind === "reset";
}

export function estimateAssistantTokens(value: string): number {
  return Math.ceil(value.length / 4) + 4;
}

export function selectRecentContext(
  messages: readonly AssistantConversationMessage[],
  maxMessages: number,
  maxTokens: number,
): readonly AssistantConversationMessage[] {
  const selected: AssistantConversationMessage[] = [];
  let tokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.length >= maxMessages) break;
    const message = messages[index];
    if (!message) continue;
    const cost = estimateAssistantTokens(message.content);
    if (tokens + cost > maxTokens) {
      if (selected.length === 0) {
        selected.unshift({
          ...message,
          content: message.content.slice(-(Math.max(maxTokens - 4, 1) * 4)),
        });
      }
      break;
    }
    selected.unshift(message);
    tokens += cost;
  }
  while (selected[0]?.role === "assistant") selected.shift();
  return selected;
}

function parseLocalCommand(body: string): LocalCommand | null {
  const trimmed = body.trim();
  if (isResetText(trimmed)) return { kind: "reset" };
  if (/^(?:assistant usage|show assistant usage|usage)[.!?]*$/i.test(trimmed)) {
    return { kind: "usage" };
  }
  const list = /^what do you remember(?: about\s+(.+?))?[.!?]*$/is.exec(trimmed);
  if (list) return { kind: "list-memories", ...(list[1] ? { query: list[1] } : {}) };
  const forgetById = /^forget memory\s+#?(\d+)[.!?]*$/i.exec(trimmed);
  if (forgetById?.[1]) return { kind: "forget-memory", id: Number(forgetById[1]) };
  const forgetText = /^forget that\s+(.+?)[.!?]*$/is.exec(trimmed);
  if (forgetText?.[1]) return { kind: "forget-text", content: forgetText[1] };
  const remember = /^remember(?: that)?\s+(.+?)[.!?]*$/is.exec(trimmed);
  if (remember?.[1]) return { kind: "remember", content: remember[1] };
  return null;
}

function isResetText(body: string): boolean {
  const normalized = body.toLowerCase().replaceAll(/[.!?]+$/g, "");
  return [
    "/reset", "reset", "reset conversation", "reset our conversation",
    "clear conversation", "clear our conversation", "clear conversation history",
    "forget our conversation",
  ].includes(normalized);
}

function selectRelevantMemories(
  memories: readonly AssistantMemory[],
  query: string,
): readonly AssistantMemory[] {
  const terms = searchTerms(query);
  return memories
    .map((memory, index) => ({
      memory,
      index,
      score: terms.filter((term) => normalizeText(memory.content).includes(term)).length,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_RETRIEVED_ITEMS)
    .map(({ memory }) => memory);
}

function buildRetrievedContext(
  memories: readonly AssistantMemory[],
  history: readonly AssistantConversationMessage[],
  memoryBudget: number,
  historyBudget: number,
): string | undefined {
  const memoryLines = selectLines(
    memories.map((memory) => `Memory #${memory.id}: ${memory.content}`),
    memoryBudget,
  );
  const historyLines = selectLines(
    history.slice(0, MAX_RETRIEVED_ITEMS).map((message) =>
      `${message.createdAt.toISOString()} ${message.role}: ${message.content}`),
    historyBudget,
  );
  if (memoryLines.length === 0 && historyLines.length === 0) return undefined;
  return [
    ...(memoryLines.length > 0 ? ["Durable memories:", ...memoryLines] : []),
    ...(historyLines.length > 0 ? ["Relevant older conversation excerpts:", ...historyLines] : []),
  ].join("\n");
}

function selectLines(lines: readonly string[], tokenBudget: number): readonly string[] {
  const selected: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    const cost = estimateAssistantTokens(line);
    if (tokens + cost > tokenBudget) break;
    selected.push(line);
    tokens += cost;
  }
  return selected;
}

function searchTerms(value: string): readonly string[] {
  return [...new Set(normalizeText(value).split(" ").filter((term) => term.length > 1))];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function formatUsage(
  recent: AssistantUsageSummary,
  lifetime: AssistantUsageSummary,
): string {
  return [
    "Assistant usage (provider-reported):",
    formatUsagePeriod("Last 30 days", recent),
    formatUsagePeriod("Lifetime", lifetime),
  ].join("\n");
}

function formatUsagePeriod(label: string, usage: AssistantUsageSummary): string {
  const unavailable = usage.requestCount - usage.requestsWithCost;
  const costNote = unavailable > 0 ? ` (${unavailable} request(s) missing cost data)` : "";
  return `${label}: ${usage.requestCount} request(s), ${usage.promptTokens.toLocaleString("en-US")} input tokens, ${usage.completionTokens.toLocaleString("en-US")} output tokens, ${usage.reasoningTokens.toLocaleString("en-US")} reasoning tokens, $${usage.costUsd.toFixed(6)}${costNote}`;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
