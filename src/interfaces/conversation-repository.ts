export const conversationStatuses = [
  "processing",
  "needs_review",
  "scheduling_needed",
  "draft_awaiting_approval",
  "queued",
  "sending",
  "sent",
  "awaiting_recruiter_confirmation",
  "recruiter_confirmed",
  "calendar_event_awaiting_approval",
  "scheduled",
  "rejected",
  "cancelled",
  "failed",
] as const;

export type ConversationStatus = (typeof conversationStatuses)[number];

export interface EmailConversation {
  gmailThreadId: string;
  rootProviderMessageId: string;
  latestProviderMessageId: string;
  subject: string;
  summary: string;
  status: ConversationStatus;
  channelId: string | null;
  parentMessageId: string | null;
  discordThreadId: string | null;
  renderedStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationInboundPublication {
  providerMessageId: string;
  page: number;
  channelId: string;
  messageId: string;
}

export interface ConversationRepository {
  ensureForEmail(input: {
    gmailThreadId: string;
    providerMessageId: string;
    subject: string;
    summary: string;
    status: ConversationStatus;
  }): Promise<EmailConversation | null>;
  attachEmail(
    gmailThreadId: string,
    providerMessageId: string,
  ): Promise<boolean>;
  findByGmailThreadId(gmailThreadId: string): Promise<EmailConversation | null>;
  findByDiscordThreadId(discordThreadId: string): Promise<EmailConversation | null>;
  findByProviderMessageId(
    providerMessageId: string,
  ): Promise<EmailConversation | null>;
  listUnpublished(limit: number): Promise<readonly EmailConversation[]>;
  savePublication(
    gmailThreadId: string,
    channelId: string,
    parentMessageId: string,
    discordThreadId: string,
  ): Promise<boolean>;
  setStatus(
    gmailThreadId: string,
    status: ConversationStatus,
  ): Promise<boolean>;
  setStatusByProviderMessageId(
    providerMessageId: string,
    status: ConversationStatus,
  ): Promise<boolean>;
  listNeedingRender(limit: number): Promise<readonly EmailConversation[]>;
  markRendered(
    gmailThreadId: string,
    status: ConversationStatus,
  ): Promise<boolean>;
  listInboundNeedingPublication(
    gmailThreadId: string,
  ): Promise<readonly string[]>;
  listInboundPublications(
    providerMessageId: string,
  ): Promise<readonly ConversationInboundPublication[]>;
  saveInboundPublication(
    providerMessageId: string,
    page: number,
    channelId: string,
    messageId: string,
  ): Promise<boolean>;
}
