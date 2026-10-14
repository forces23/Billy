import type { GeneratedReply } from "./ai-provider.js";

export interface StoredDraft {
  id: number;
  providerMessageId: string;
  revision: number;
  body: string;
  reviewerNote: string | null;
  providerResponseId: string;
  requestedModel: string;
  resolvedModel: string;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: Date;
}

export interface DraftRepository {
  saveAndAwaitApproval(
    providerMessageId: string,
    generatedReply: GeneratedReply,
  ): Promise<StoredDraft | null>;

  listByProviderMessageId(
    providerMessageId: string,
  ): Promise<readonly StoredDraft[]>;

  findById(id: number): Promise<StoredDraft | null>;

  saveRevisionWhileAwaitingApproval(
    providerMessageId: string,
    generatedReply: GeneratedReply,
  ): Promise<StoredDraft | null>;
}
