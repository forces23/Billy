import type {
  AssistantMessage,
  AssistantMessageRole,
} from "./assistant-provider.js";

export interface AssistantInboundMessage {
  discordMessageId: string;
  channelId: string;
  userId: string;
  body: string;
}

export interface AssistantConversationMessage extends AssistantMessage {
  id: number;
  channelId: string;
  userId: string;
  discordMessageId: string;
  createdAt: Date;
}

export interface AssistantMemory {
  id: number;
  channelId: string;
  content: string;
  sourceDiscordMessageId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssistantUsageRecord {
  inboundDiscordMessageId: string;
  providerResponseId: string | null;
  requestedModel: string;
  resolvedModel: string;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
}

export interface AssistantUsageSummary {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  costUsd: number;
  requestsWithCost: number;
}

export interface AssistantConversationRepository {
  claimInbound(input: AssistantInboundMessage): Promise<boolean>;
  appendMessage(input: {
    channelId: string;
    userId: string;
    discordMessageId: string;
    role: AssistantMessageRole;
    body: string;
  }): Promise<boolean>;
  listRecent(
    channelId: string,
    limit: number,
  ): Promise<readonly AssistantConversationMessage[]>;
  completeInbound(discordMessageId: string): Promise<boolean>;
  failInbound(discordMessageId: string, error: string): Promise<boolean>;
  resetConversation(channelId: string): Promise<number>;
  searchHistory(
    channelId: string,
    query: string,
    beforeId: number,
    limit: number,
  ): Promise<readonly AssistantConversationMessage[]>;
  saveMemory(input: {
    channelId: string;
    content: string;
    sourceDiscordMessageId: string;
  }): Promise<AssistantMemory>;
  listMemories(channelId: string, limit: number): Promise<readonly AssistantMemory[]>;
  forgetMemory(channelId: string, id: number): Promise<boolean>;
  recordUsage(input: AssistantUsageRecord): Promise<boolean>;
  getUsageSummary(since?: Date): Promise<AssistantUsageSummary>;
}
