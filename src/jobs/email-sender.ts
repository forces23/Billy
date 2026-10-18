import type { Logger } from "pino";

import { formatEmailAddress } from "../interfaces/approval-repository.js";
import type { ApprovalRepository } from "../interfaces/approval-repository.js";
import type { DraftRepository } from "../interfaces/draft-repository.js";
import type {
  EmailProvider,
  OutboundEmailProvider,
} from "../interfaces/email-provider.js";
import type { EmailRepository } from "../interfaces/email-repository.js";
import type { RecipientResolver } from "../core/recipient-resolver.js";
import type { SchedulingGuard } from "../interfaces/scheduling-repository.js";
import type { ConversationRepository } from "../interfaces/conversation-repository.js";

const SEND_BATCH_SIZE = 25;
const MAX_STORED_ERROR_LENGTH = 500;

export interface EmailSenderOptions {
  intervalMilliseconds: number;
  schedulingGuard?: SchedulingGuard;
  conversationRepository?: ConversationRepository;
}

export class EmailSender {
  readonly #emailProvider: EmailProvider & OutboundEmailProvider;
  readonly #emailRepository: EmailRepository;
  readonly #draftRepository: DraftRepository;
  readonly #approvalRepository: ApprovalRepository;
  readonly #recipientResolver: RecipientResolver;
  readonly #logger: Logger;
  readonly #intervalMilliseconds: number;
  readonly #schedulingGuard: SchedulingGuard | undefined;
  readonly #conversationRepository: ConversationRepository | undefined;

  constructor(
    emailProvider: EmailProvider & OutboundEmailProvider,
    emailRepository: EmailRepository,
    draftRepository: DraftRepository,
    approvalRepository: ApprovalRepository,
    recipientResolver: RecipientResolver,
    logger: Logger,
    options: EmailSenderOptions,
  ) {
    if (
      !Number.isInteger(options.intervalMilliseconds) ||
      options.intervalMilliseconds < 1
    ) {
      throw new Error("Email send interval must be a positive integer");
    }

    this.#emailProvider = emailProvider;
    this.#emailRepository = emailRepository;
    this.#draftRepository = draftRepository;
    this.#approvalRepository = approvalRepository;
    this.#recipientResolver = recipientResolver;
    this.#logger = logger.child({ component: "email-sender" });
    this.#intervalMilliseconds = options.intervalMilliseconds;
    this.#schedulingGuard = options.schedulingGuard;
    this.#conversationRepository = options.conversationRepository;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.#logger.info(
      { intervalMilliseconds: this.#intervalMilliseconds },
      "Email sender started",
    );

    while (!signal.aborted) {
      try {
        await this.processPending();
      } catch (error: unknown) {
        this.#logger.error({ err: error }, "Email sending cycle failed");
      }

      await waitForNextCycle(this.#intervalMilliseconds, signal);
    }

    this.#logger.info("Email sender stopped");
  }

  async processPending(): Promise<void> {
    const pending = await this.#emailRepository.listByStatus(
      "approved",
      SEND_BATCH_SIZE,
    );

    for (const email of pending) {
      let sentProviderMessageId: string | undefined;
      const claimed = await this.#emailRepository.transitionStatus(
        email.providerMessageId,
        "approved",
        "sending",
      );
      if (!claimed) continue;
      await this.#conversationRepository?.setStatusByProviderMessageId(
        email.providerMessageId,
        "sending",
      );

      try {
        const decision = await this.#approvalRepository.findDecision(
          email.providerMessageId,
        );
        if (!decision || decision.decision === "do_not_reply") {
          throw new Error("Approved email does not have an approved review decision");
        }

        const draft = await this.#draftRepository.findById(decision.draftId);
        if (!draft || draft.providerMessageId !== email.providerMessageId) {
          throw new Error("Approved email draft could not be loaded");
        }
        if (
          this.#schedulingGuard &&
          !(await this.#schedulingGuard.validateDraft(draft.id))
        ) {
          throw new Error(
            "The selected scheduling slot is no longer available; the email was not sent",
          );
        }

        const original = await this.#emailProvider.getMessage(
          email.providerMessageId,
        );
        const context = this.#recipientResolver.resolve(original);
        const canThreadReply =
          context.source === "direct" && original.messageIdHeader.length > 0;
        const sent = await this.#emailProvider.sendReply({
          to: decision.recipients.to.map(formatEmailAddress),
          cc: decision.recipients.cc.map(formatEmailAddress),
          subject: context.subject,
          textBody: draft.body,
          ...(canThreadReply
            ? {
                threadId: original.threadId,
                inReplyTo: original.messageIdHeader,
              }
            : {}),
        });
        sentProviderMessageId = sent.providerMessageId;
        const saved = await this.#emailRepository.markSent(
          email.providerMessageId,
          sent.providerMessageId,
        );
        if (!saved) {
          throw new Error("Sent email state could not be persisted");
        }
        const scheduling = this.#schedulingGuard
          ? await this.#schedulingGuard.getDraftContext(draft.id)
          : undefined;
        await this.#conversationRepository?.setStatusByProviderMessageId(
          email.providerMessageId,
          scheduling ? "awaiting_recruiter_confirmation" : "sent",
        );
        await this.#schedulingGuard?.onDraftSent(draft.id);

        this.#logger.info(
          {
            providerMessageId: email.providerMessageId,
            sentProviderMessageId: sent.providerMessageId,
            sentThreadId: sent.threadId,
            draftId: draft.id,
            revision: draft.revision,
            recipientCount:
              decision.recipients.to.length + decision.recipients.cc.length,
            replySource: context.source,
          },
          "Sent an approved Gmail reply",
        );
      } catch (error: unknown) {
        if (sentProviderMessageId) {
          this.#logger.error(
            {
              err: error,
              providerMessageId: email.providerMessageId,
              sentProviderMessageId,
            },
            "Gmail reply was sent, but Billy could not finalize local state",
          );
          continue;
        }

        const message = errorMessage(error);
        await this.#emailRepository.markFailed(
          email.providerMessageId,
          "sending",
          {
            stage: "gmail_send",
            code: "gmail_send_failed",
            technicalMessage: message,
            userMessage: gmailFailureMessage(error),
          },
        );
        await this.#conversationRepository?.setStatusByProviderMessageId(
          email.providerMessageId,
          "failed",
        );
        this.#logger.error(
          { err: error, providerMessageId: email.providerMessageId },
          "Failed to send an approved Gmail reply",
        );
      }
    }
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/g, " ").trim().slice(0, MAX_STORED_ERROR_LENGTH);
}

function gmailFailureMessage(error: unknown): string {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("401") || message.includes("unauthorized")) {
    return "Gmail rejected Billy's authorization.";
  }
  if (message.includes("403") || message.includes("permission")) {
    return "Gmail denied permission to send the approved reply.";
  }
  if (message.includes("429") || message.includes("rate")) {
    return "Gmail rate-limited the send request.";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "Gmail did not respond before the send request timed out.";
  }
  return "Gmail could not send the approved reply.";
}

function waitForNextCycle(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);

    function finish(): void {
      signal.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolve();
    }

    signal.addEventListener("abort", finish, { once: true });
  });
}
