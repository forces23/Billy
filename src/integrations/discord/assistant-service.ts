import type { Logger } from "pino";
import { ChannelType, Client, TextChannel } from "discord.js";
import type { Message } from "discord.js";

import type {
  AssistantConversationOutcome,
  AssistantConversationWorkflow,
} from "../../core/assistant-conversation-workflow.js";
import type { AssistantInboundMessage } from "../../interfaces/assistant-conversation-repository.js";
import type { DiscordFeature } from "./runtime.js";

const DISCORD_MESSAGE_LIMIT = 2_000;
const SAFE_PAGE_LIMIT = 1_900;

export interface DiscordAssistantServiceOptions {
  mainChannelId: string;
  ownerUserId: string;
}

export class DiscordAssistantService implements DiscordFeature {
  readonly name = "assistant";
  readonly #client: Client;
  readonly #workflow: AssistantConversationWorkflow;
  readonly #logger: Logger;
  readonly #mainChannelId: string;
  readonly #ownerUserId: string;
  readonly #channelQueues = new Map<string, Promise<void>>();
  #channel: TextChannel | undefined;

  constructor(
    client: Client,
    workflow: AssistantConversationWorkflow,
    logger: Logger,
    options: DiscordAssistantServiceOptions,
  ) {
    if (!options.mainChannelId.trim()) {
      throw new Error("A Discord main channel ID is required");
    }
    if (!options.ownerUserId.trim()) {
      throw new Error("A Discord owner user ID is required");
    }

    this.#client = client;
    this.#workflow = workflow;
    this.#logger = logger.child({ component: "discord-assistant" });
    this.#mainChannelId = options.mainChannelId;
    this.#ownerUserId = options.ownerUserId;
  }

  async initialize(): Promise<void> {
    const channel = await this.#client.channels.fetch(this.#mainChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(
        "DISCORD_MAIN_CHANNEL_ID must identify a server text channel",
      );
    }
    this.#channel = channel;
    this.#logger.info(
      { mainChannelId: this.#mainChannelId },
      "Discord assistant service started",
    );
  }

  async handleMessage(message: Message, signal?: AbortSignal): Promise<void> {
    if (!isAuthorizedAssistantMessage(
      message,
      this.#mainChannelId,
      this.#ownerUserId,
    )) {
      return;
    }

    const body = message.content.trim();
    if (!body) return;

    const previous = this.#channelQueues.get(message.channelId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.#processMessage(message, body, signal));
    this.#channelQueues.set(message.channelId, next);

    try {
      await next;
    } finally {
      if (this.#channelQueues.get(message.channelId) === next) {
        this.#channelQueues.delete(message.channelId);
      }
    }
  }

  async #processMessage(
    message: Message,
    body: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const input: AssistantInboundMessage = {
      discordMessageId: message.id,
      channelId: message.channelId,
      userId: message.author.id,
      body,
    };
    let outcome: AssistantConversationOutcome | undefined;

    try {
      const channel = this.#channel;
      if (!channel) throw new Error("Discord assistant channel is unavailable");
      await channel.sendTyping();
      outcome = await this.#workflow.begin(input, signal);
      if (outcome.kind === "duplicate") return;

      const pages = paginateAssistantResponse(outcome.response);
      let firstResponseMessageId: string | undefined;
      for (const content of pages) {
        const sent = await channel.send({
          content,
          allowedMentions: { parse: [] },
        });
        firstResponseMessageId ??= sent.id;
      }
      if (!firstResponseMessageId) {
        throw new Error("Discord returned no assistant response message");
      }

      await this.#workflow.complete(input, outcome, firstResponseMessageId);
      if (outcome.kind === "response") {
        this.#logger.info(
          {
            discordMessageId: message.id,
            providerResponseId: outcome.provider.providerResponseId,
            requestedModel: outcome.provider.requestedModel,
            resolvedModel: outcome.provider.resolvedModel,
            promptTokens: outcome.provider.promptTokens,
            completionTokens: outcome.provider.completionTokens,
            reasoningTokens: outcome.provider.reasoningTokens,
            costUsd: outcome.provider.costUsd,
          },
          "Assistant response delivered",
        );
      }
    } catch (error: unknown) {
      if (outcome) {
        await this.#workflow.fail(message.id, error).catch(() => undefined);
      }
      this.#logger.error(
        { err: error, discordMessageId: message.id },
        "Assistant message handling failed",
      );
      if (signal?.aborted) return;
      await message.reply({
        content: "I couldn’t answer that right now. Please try again.",
        allowedMentions: { repliedUser: false },
      }).catch(() => undefined);
    }
  }
}

export function isAuthorizedAssistantMessage(
  message: Pick<Message, "author" | "channelId">,
  mainChannelId: string,
  ownerUserId: string,
): boolean {
  return (
    !message.author.bot &&
    message.channelId === mainChannelId &&
    message.author.id === ownerUserId
  );
}

export function paginateAssistantResponse(
  content: string,
  limit = SAFE_PAGE_LIMIT,
): readonly string[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > DISCORD_MESSAGE_LIMIT) {
    throw new Error("Discord assistant page limit must be between 1 and 2000");
  }
  if (content.length <= limit) return [content];

  const pages: string[] = [];
  let remaining = content;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const splitAt = Math.max(newline, space);
    const pageEnd = splitAt > 0 ? splitAt + 1 : limit;
    pages.push(remaining.slice(0, pageEnd));
    remaining = remaining.slice(pageEnd);
  }
  if (remaining) pages.push(remaining);
  return pages;
}
