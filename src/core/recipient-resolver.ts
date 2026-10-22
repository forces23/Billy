import emailAddresses from "email-addresses";

import type { EmailMessage } from "../interfaces/email-provider.js";

const FORWARD_SUBJECT_PATTERN = /^\s*(?:fwd?|wg)\s*:/i;
const FORWARD_MARKERS = [
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/gim,
  /^Begin forwarded message:\s*$/gim,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/gim,
] as const;

export interface EmailAddress {
  name: string | null;
  address: string;
}

export interface RecipientSet {
  to: readonly EmailAddress[];
  cc: readonly EmailAddress[];
}

export type RecipientSource = "direct" | "forwarded";

export interface ResolvedEmailContext {
  source: RecipientSource;
  forwardedBy: EmailAddress | null;
  from: readonly EmailAddress[];
  subject: string;
  body: string;
  reply: RecipientSet;
  replyAll: RecipientSet;
  requiresManualRecipients: boolean;
  warnings: readonly string[];
}

export interface RecipientResolverOptions {
  ownAddresses: readonly string[];
  trustedForwarderAddresses: readonly string[];
}

export interface ForwardingInspection {
  looksForwarded: boolean;
  trusted: boolean;
  forwarder: EmailAddress | null;
}

interface ForwardedBlock {
  headers: ReadonlyMap<string, readonly string[]>;
  body: string;
  markerCount: number;
}

export class RecipientResolver {
  readonly #ownAddresses: ReadonlySet<string>;
  readonly #trustedForwarderAddresses: ReadonlySet<string>;

  constructor(options: RecipientResolverOptions) {
    this.#ownAddresses = normalizeAddressSet(options.ownAddresses);
    this.#trustedForwarderAddresses = normalizeAddressSet(
      options.trustedForwarderAddresses,
    );
  }

  inspectForwarding(message: EmailMessage): ForwardingInspection {
    const outerFrom = parseAddressHeaders([message.from]);
    const forwarder = outerFrom.length === 1 ? outerFrom[0] ?? null : null;

    return {
      looksForwarded:
        FORWARD_SUBJECT_PATTERN.test(message.subject) ||
        hasForwardMarker(message.textBody),
      trusted:
        forwarder !== null &&
        this.#trustedForwarderAddresses.has(normalizeAddress(forwarder.address)),
      forwarder,
    };
  }

  resolve(message: EmailMessage): ResolvedEmailContext {
    const outerFrom = parseAddressHeaders([message.from]);
    const forwarding = this.inspectForwarding(message);

    if (
      forwarding.looksForwarded &&
      forwarding.trusted &&
      forwarding.forwarder
    ) {
      const forwarded = parseForwardedBlock(message.textBody);
      return this.#resolveForwarded(message, forwarding.forwarder, forwarded);
    }

    return this.#resolveDirect(message, outerFrom);
  }

  parseManualRecipients(to: string, cc: string): RecipientSet {
    const parsedTo = deduplicateAddresses(parseAddressHeaders([to]));
    const parsedCc = deduplicateAddresses(parseAddressHeaders([cc])).filter(
      (candidate) =>
        !parsedTo.some(
          (primary) =>
            normalizeAddress(primary.address) ===
            normalizeAddress(candidate.address),
        ),
    );

    if (parsedTo.length === 0) {
      throw new Error("At least one valid To recipient is required");
    }

    return {
      to: parsedTo,
      cc: parsedCc,
    };
  }

  #resolveDirect(
    message: EmailMessage,
    parsedFrom: readonly EmailAddress[],
  ): ResolvedEmailContext {
    const replyTo = parseAddressHeaders(message.replyTo);
    const primary = replyTo.length > 0 ? replyTo : parsedFrom;
    const warnings: string[] = [];

    if (primary.length === 0) {
      warnings.push("No valid Reply-To or From address was found");
    }

    const reply = buildRecipientSet(primary, [], this.#ownAddresses);
    const replyAll = buildRecipientSet(
      primary,
      [
        ...parseAddressHeaders(message.to),
        ...parseAddressHeaders(message.cc),
      ],
      this.#ownAddresses,
    );

    return {
      source: "direct",
      forwardedBy: null,
      from: parsedFrom,
      subject: message.subject,
      body: message.textBody,
      reply,
      replyAll,
      requiresManualRecipients: reply.to.length === 0,
      warnings,
    };
  }

  #resolveForwarded(
    message: EmailMessage,
    outerSender: EmailAddress,
    forwarded: ForwardedBlock | null,
  ): ResolvedEmailContext {
    const warnings: string[] = [];

    if (!forwarded) {
      warnings.push("The subject indicates a forward, but no forwarded header block was found");
      return emptyForwardedContext(message, outerSender, warnings);
    }

    if (forwarded.markerCount > 1) {
      warnings.push("More than one forwarded-message block was found");
    }

    const from = parseAddressHeaders(forwarded.headers.get("from") ?? []);
    const replyTo = parseAddressHeaders(
      forwarded.headers.get("reply-to") ?? [],
    );
    const primary = replyTo.length > 0 ? replyTo : from;
    const excluded = new Set(this.#ownAddresses);
    excluded.add(normalizeAddress(outerSender.address));

    if (primary.length === 0) {
      warnings.push("The forwarded message does not contain a valid original sender");
    }

    if (from.length > 1) {
      warnings.push("The forwarded message contains multiple original senders");
    }

    const reply = buildRecipientSet(primary, [], excluded);
    const replyAll = buildRecipientSet(
      primary,
      [
        ...parseAddressHeaders(forwarded.headers.get("to") ?? []),
        ...parseAddressHeaders(forwarded.headers.get("cc") ?? []),
      ],
      excluded,
    );
    const subject = stripForwardSubjectPrefixes(
      firstHeader(forwarded.headers, "subject") ?? message.subject,
    );

    return {
      source: "forwarded",
      forwardedBy: outerSender,
      from,
      subject,
      body: forwarded.body || message.textBody,
      reply,
      replyAll,
      requiresManualRecipients:
        reply.to.length === 0 || from.length > 1 || forwarded.markerCount > 1,
      warnings,
    };
  }
}

function emptyForwardedContext(
  message: EmailMessage,
  outerSender: EmailAddress,
  warnings: readonly string[],
): ResolvedEmailContext {
  return {
    source: "forwarded",
    forwardedBy: outerSender,
    from: [],
    subject: stripForwardSubjectPrefixes(message.subject),
    body: message.textBody,
    reply: { to: [], cc: [] },
    replyAll: { to: [], cc: [] },
    requiresManualRecipients: true,
    warnings,
  };
}

function stripForwardSubjectPrefixes(subject: string): string {
  const normalized = subject.replaceAll(/[\r\n]+/g, " ").trim();
  const stripped = normalized.replace(/^(?:(?:fwd?|wg)\s*:\s*)+/i, "").trim();
  return stripped || normalized;
}

function buildRecipientSet(
  primaryCandidates: readonly EmailAddress[],
  copyCandidates: readonly EmailAddress[],
  excluded: ReadonlySet<string>,
): RecipientSet {
  const to = deduplicateAddresses(primaryCandidates).filter(
    (candidate) => !excluded.has(normalizeAddress(candidate.address)),
  );
  const primaryAddresses = new Set(
    to.map((candidate) => normalizeAddress(candidate.address)),
  );
  const cc = deduplicateAddresses(copyCandidates).filter((candidate) => {
    const normalized = normalizeAddress(candidate.address);
    return !excluded.has(normalized) && !primaryAddresses.has(normalized);
  });

  return { to, cc };
}

function parseForwardedBlock(body: string): ForwardedBlock | null {
  const matches = FORWARD_MARKERS.flatMap((pattern) => {
    pattern.lastIndex = 0;
    return [...body.matchAll(pattern)];
  }).sort((left, right) => (left.index ?? 0) - (right.index ?? 0));

  const first = matches[0];
  if (!first || first.index === undefined) {
    return null;
  }

  const afterMarker = body.slice(first.index + first[0].length).replace(/^\s*\n/, "");
  const lines = afterMarker.split(/\r?\n/);
  const headerLines: string[] = [];
  let bodyStart = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (!line.trim()) {
      if (headerLines.length === 0) continue;
      bodyStart = index + 1;
      break;
    }

    if (/^[\t ]+/.test(line) && headerLines.length > 0) {
      headerLines[headerLines.length - 1] = `${headerLines.at(-1)} ${line.trim()}`;
      continue;
    }

    if (!/^[A-Za-z-]+\s*:/.test(line)) {
      bodyStart = index;
      break;
    }

    headerLines.push(line);
  }

  const headers = new Map<string, string[]>();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!value) continue;
    const existing = headers.get(name) ?? [];
    existing.push(value);
    headers.set(name, existing);
  }

  return {
    headers,
    body: lines.slice(bodyStart).join("\n").trim(),
    markerCount: matches.length,
  };
}

function hasForwardMarker(body: string): boolean {
  return FORWARD_MARKERS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(body);
  });
}

function firstHeader(
  headers: ReadonlyMap<string, readonly string[]>,
  name: string,
): string | undefined {
  return headers.get(name)?.[0];
}

export function parseAddressHeaders(
  values: readonly string[],
): readonly EmailAddress[] {
  return values.flatMap((value) => {
    const parsed = emailAddresses.parseAddressList({
      input: value,
      rfc6532: true,
    });

    return (parsed ?? []).flatMap((entry) => {
      if (entry.type === "mailbox") {
        return [{ name: entry.name, address: entry.address }];
      }

      return entry.addresses.map((address) => ({
        name: address.name,
        address: address.address,
      }));
    });
  });
}

function deduplicateAddresses(
  addresses: readonly EmailAddress[],
): readonly EmailAddress[] {
  const seen = new Set<string>();
  return addresses.filter((candidate) => {
    const normalized = normalizeAddress(candidate.address);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function normalizeAddressSet(addresses: readonly string[]): ReadonlySet<string> {
  return new Set(
    addresses.map(normalizeAddress).filter((address) => address.length > 0),
  );
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}
