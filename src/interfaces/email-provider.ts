export interface EmailMessage {
  providerMessageId: string;
  threadId: string;
  messageIdHeader: string;
  from: string;
  to: readonly string[];
  cc: readonly string[];
  replyTo: readonly string[];
  subject: string;
  receivedAt: Date;
  textBody: string;
  automationReason: string | null;
  attachments?: readonly EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
}

export interface ListCandidateMessagesOptions {
  receivedAfter?: Date;
}

export interface EmailProvider {
  listCandidateMessageIds(
    options?: ListCandidateMessagesOptions,
  ): Promise<readonly string[]>;
  getMessage(id: string): Promise<EmailMessage>;
}

export interface SendEmailReplyInput {
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  textBody: string;
  threadId?: string;
  inReplyTo?: string;
}

export interface SentEmail {
  providerMessageId: string;
  threadId: string;
}

export interface OutboundEmailProvider {
  sendReply(input: SendEmailReplyInput): Promise<SentEmail>;
}
