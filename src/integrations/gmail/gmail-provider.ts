import type { gmail_v1 } from "googleapis";

import type {
  EmailMessage,
  EmailProvider,
  ListCandidateMessagesOptions,
  OutboundEmailProvider,
  SendEmailReplyInput,
  SentEmail,
} from "../../interfaces/email-provider.js";

const DEFAULT_QUERY = "in:inbox -from:me";
const DEFAULT_MAX_RESULTS = 50;

export interface GmailEmailProviderOptions {
  userId?: string;
  senderAddress?: string;
  query?: string;
  maxResults?: number;
}

export class GmailEmailProvider implements EmailProvider, OutboundEmailProvider {
  readonly #client: gmail_v1.Gmail;
  readonly #userId: string;
  readonly #senderAddress: string | undefined;
  readonly #query: string;
  readonly #maxResults: number;

  constructor(
    client: gmail_v1.Gmail,
    options: GmailEmailProviderOptions = {},
  ) {
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) {
      throw new Error("Gmail maxResults must be an integer from 1 through 500");
    }

    this.#client = client;
    this.#userId = options.userId ?? "me";
    this.#senderAddress = options.senderAddress;
    this.#query = options.query ?? DEFAULT_QUERY;
    this.#maxResults = maxResults;
  }

  async listCandidateMessageIds(
    options: ListCandidateMessagesOptions = {},
  ): Promise<readonly string[]> {
    const query = buildQuery(this.#query, options.receivedAfter);
    const messageIds: string[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.#client.users.messages.list({
        userId: this.#userId,
        q: query,
        maxResults: this.#maxResults,
        ...(pageToken ? { pageToken } : {}),
      });

      messageIds.push(
        ...(response.data.messages ?? []).flatMap((message) =>
          message.id ? [message.id] : [],
        ),
      );

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return messageIds;
  }

  async getMessage(id: string): Promise<EmailMessage> {
    if (!id.trim()) {
      throw new Error("A Gmail message ID is required");
    }

    const response = await this.#client.users.messages.get({
      userId: this.#userId,
      id,
      format: "full",
    });

    const message = response.data;
    const providerMessageId = requireValue(message.id, "message ID", id);
    const threadId = requireValue(message.threadId, "thread ID", id);
    const headers = message.payload?.headers ?? [];
    const from = getHeader(headers, "From") ?? "";
    const to = getHeaders(headers, "To").flatMap(splitAddressHeader);
    const cc = getHeaders(headers, "Cc").flatMap(splitAddressHeader);
    const replyTo = getHeaders(headers, "Reply-To").flatMap(splitAddressHeader);
    const subject = getHeader(headers, "Subject") ?? "";
    const messageIdHeader = getHeader(headers, "Message-ID") ?? "";
    const receivedAt = parseReceivedAt(
      message.internalDate,
      getHeader(headers, "Date"),
      id,
    );

    const plainBody = findBody(message.payload, "text/plain");
    const htmlBody = plainBody ? undefined : findBody(message.payload, "text/html");
    const textBody = plainBody
      ? decodeBody(plainBody)
      : htmlBody
        ? htmlToText(decodeBody(htmlBody))
        : (message.snippet ?? "");
    const automationReason = detectAutomation(headers, from);

    return {
      providerMessageId,
      threadId,
      messageIdHeader,
      from,
      to,
      cc,
      replyTo,
      subject,
      receivedAt,
      textBody,
      automationReason,
    };
  }

  async sendReply(input: SendEmailReplyInput): Promise<SentEmail> {
    if (input.to.length === 0) {
      throw new Error("A Gmail reply requires at least one To recipient");
    }

    const raw = buildRawMessage(input, this.#senderAddress);
    const response = await this.#client.users.messages.send({
      userId: this.#userId,
      requestBody: {
        raw: Buffer.from(raw, "utf8").toString("base64url"),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    });
    const providerMessageId = requireValue(
      response.data.id,
      "sent message ID",
      "outbound reply",
    );
    const threadId = requireValue(
      response.data.threadId,
      "sent thread ID",
      providerMessageId,
    );

    return { providerMessageId, threadId };
  }
}

function buildRawMessage(
  input: SendEmailReplyInput,
  senderAddress: string | undefined,
): string {
  const subject = replySubject(input.subject);
  const headers = [
    ...(senderAddress ? [`From: ${safeHeader(senderAddress, "From")}`] : []),
    `To: ${input.to.map((value) => safeHeader(value, "To")).join(", ")}`,
    ...(input.cc.length > 0
      ? [`Cc: ${input.cc.map((value) => safeHeader(value, "Cc")).join(", ")}`]
      : []),
    `Subject: ${encodeHeader(subject)}`,
    ...(input.inReplyTo
      ? [
          `In-Reply-To: ${safeHeader(input.inReplyTo, "In-Reply-To")}`,
          `References: ${safeHeader(input.inReplyTo, "References")}`,
        ]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = wrapBase64(
    Buffer.from(normalizeCrlf(input.textBody), "utf8").toString("base64"),
  );

  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

function replySubject(subject: string): string {
  const normalized = subject.replaceAll(/[\r\n]+/g, " ").trim();
  return /^(?:re\s*:)/i.test(normalized) ? normalized : `Re: ${normalized}`;
}

function safeHeader(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new Error(`${name} contains an invalid email header value`);
  }
  return normalized;
}

function encodeHeader(value: string): string {
  const safe = safeHeader(value, "Subject");
  return /^[\x20-\x7e]*$/.test(safe)
    ? safe
    : `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

function normalizeCrlf(value: string): string {
  return value.replaceAll(/\r?\n/g, "\r\n");
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function detectAutomation(
  headers: readonly gmail_v1.Schema$MessagePartHeader[],
  from: string,
): string | null {
  const normalizedFrom = from.toLowerCase();
  const automatedMailboxPattern =
    /(?:no[._-]?reply|do[._-]?not[._-]?reply|mailer-daemon|postmaster)@/i;

  if (automatedMailboxPattern.test(normalizedFrom)) {
    return "sender address indicates an automated mailbox";
  }

  const autoSubmitted = getHeader(headers, "Auto-Submitted")?.trim().toLowerCase();

  if (autoSubmitted && autoSubmitted !== "no") {
    return `Auto-Submitted header is ${autoSubmitted}`;
  }

  const precedence = getHeader(headers, "Precedence")?.trim().toLowerCase();

  if (precedence && ["bulk", "list", "junk"].includes(precedence)) {
    return `Precedence header is ${precedence}`;
  }

  if (getHeader(headers, "List-Unsubscribe")) {
    return "message includes a List-Unsubscribe header";
  }

  return null;
}

function buildQuery(query: string, receivedAfter: Date | undefined): string {
  if (!receivedAfter) {
    return query;
  }

  const timestamp = receivedAfter.getTime();

  if (Number.isNaN(timestamp)) {
    throw new Error("receivedAfter must be a valid date");
  }

  const epochSeconds = Math.max(0, Math.floor(timestamp / 1_000) - 1);
  return `${query} after:${epochSeconds}`;
}

function requireValue(
  value: string | null | undefined,
  field: string,
  requestedMessageId: string,
): string {
  if (!value) {
    throw new Error(
      `Gmail response for ${requestedMessageId} did not include a ${field}`,
    );
  }

  return value;
}

function getHeader(
  headers: readonly gmail_v1.Schema$MessagePartHeader[],
  name: string,
): string | undefined {
  return getHeaders(headers, name)[0];
}

function getHeaders(
  headers: readonly gmail_v1.Schema$MessagePartHeader[],
  name: string,
): string[] {
  const normalizedName = name.toLowerCase();

  return headers.flatMap((header) =>
    header.name?.toLowerCase() === normalizedName && header.value
      ? [header.value]
      : [],
  );
}

function splitAddressHeader(header: string): string[] {
  const addresses: string[] = [];
  let current = "";
  let escaped = false;
  let quoted = false;
  let angleDepth = 0;
  let commentDepth = 0;

  for (const character of header) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\" && quoted) {
      current += character;
      escaped = true;
      continue;
    }

    if (character === '"' && commentDepth === 0) {
      quoted = !quoted;
      current += character;
      continue;
    }

    if (!quoted) {
      if (character === "<") angleDepth += 1;
      if (character === ">" && angleDepth > 0) angleDepth -= 1;
      if (character === "(") commentDepth += 1;
      if (character === ")" && commentDepth > 0) commentDepth -= 1;

      if (character === "," && angleDepth === 0 && commentDepth === 0) {
        const address = current.trim();
        if (address) addresses.push(address);
        current = "";
        continue;
      }
    }

    current += character;
  }

  const finalAddress = current.trim();
  if (finalAddress) addresses.push(finalAddress);

  return addresses;
}

function findBody(
  part: gmail_v1.Schema$MessagePart | null | undefined,
  mimeType: string,
): string | undefined {
  if (!part) {
    return undefined;
  }

  if (part.mimeType?.toLowerCase() === mimeType && part.body?.data) {
    return part.body.data;
  }

  for (const child of part.parts ?? []) {
    const body = findBody(child, mimeType);
    if (body) return body;
  }

  return undefined;
}

function decodeBody(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(
    /&(#\d+|#x[\da-f]+|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, code: string) => {
      if (code.startsWith("#x")) {
        return codePointToString(Number.parseInt(code.slice(2), 16), entity);
      }

      if (code.startsWith("#")) {
        return codePointToString(Number.parseInt(code.slice(1), 10), entity);
      }

      return namedEntities[code.toLowerCase()] ?? entity;
    },
  );
}

function codePointToString(codePoint: number, fallback: string): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function parseReceivedAt(
  internalDate: string | null | undefined,
  dateHeader: string | undefined,
  messageId: string,
): Date {
  if (internalDate) {
    const timestamp = Number(internalDate);
    if (Number.isFinite(timestamp) && timestamp >= 0) {
      return new Date(timestamp);
    }
  }

  if (dateHeader) {
    const timestamp = Date.parse(dateHeader);
    if (!Number.isNaN(timestamp)) {
      return new Date(timestamp);
    }
  }

  throw new Error(`Gmail message ${messageId} did not include a valid date`);
}
