export type AssistantMessageRole = "user" | "assistant";

export interface AssistantMessage {
  role: AssistantMessageRole;
  content: string;
}

export interface AssistantToolDefinition {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface AssistantToolCall {
  id: string;
  name: string;
  arguments: Readonly<Record<string, unknown>>;
}

export interface AssistantRequest {
  messages: readonly AssistantMessage[];
  context?: string;
  tools?: readonly AssistantToolDefinition[];
}

export interface AssistantResponse {
  text: string | null;
  toolCalls: readonly AssistantToolCall[];
  providerResponseId: string | null;
  requestedModel: string;
  resolvedModel: string;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
}

export interface AssistantProvider {
  respond(
    input: AssistantRequest,
    signal?: AbortSignal,
  ): Promise<AssistantResponse>;
}
