export type ReasoningEffort = "low" | "medium" | "high";

export interface GenerateReplyInput {
  from: string;
  subject: string;
  body: string;
  trustedCareerContext?: Readonly<Record<string, unknown>>;
  revision?: {
    previousDraft: string;
    instructions: string;
  };
}

export interface GeneratedReply {
  body: string;
  reviewerNote: string | null;
  providerResponseId: string;
  requestedModel: string;
  resolvedModel: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface AiProviderFailureDetails {
  code: string;
  userMessage: string;
  finishReason?: string;
  nativeFinishReason?: string;
  providerResponseId?: string;
  requestedModel?: string;
  resolvedModel?: string;
  promptTokens?: number;
  completionTokens?: number;
  httpStatus?: number;
}

export function readAiProviderFailureDetails(
  error: unknown,
): AiProviderFailureDetails | null {
  if (!(error instanceof Error) || !("aiFailure" in error)) return null;
  const details = error.aiFailure;
  if (
    typeof details !== "object" ||
    details === null ||
    !("code" in details) ||
    typeof details.code !== "string" ||
    !("userMessage" in details) ||
    typeof details.userMessage !== "string"
  ) {
    return null;
  }

  return details as AiProviderFailureDetails;
}

export interface AiProvider {
  generateReply(
    input: GenerateReplyInput,
    signal?: AbortSignal,
  ): Promise<GeneratedReply>;
}
