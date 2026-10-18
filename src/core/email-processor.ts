import type { Logger } from "pino";

import type { CareerContextProvider } from "../interfaces/career-context-provider.js";
import type { ConversationRepository } from "../interfaces/conversation-repository.js";
import type {
  EmailCategory,
  EmailClassification,
  EmailClassifier,
} from "../interfaces/email-classifier.js";
import {
  readAiProviderFailureDetails,
  type AiProvider,
} from "../interfaces/ai-provider.js";
import type { DraftRepository } from "../interfaces/draft-repository.js";
import type { EmailProvider } from "../interfaces/email-provider.js";
import type {
  EmailRepository,
  StoredEmail,
} from "../interfaces/email-repository.js";
import type { RecipientResolver } from "./recipient-resolver.js";
import { determineEmailRoutingAction } from "./email-routing-policy.js";
import type { SchedulingWorkflow } from "./scheduling-workflow.js";

const DEFAULT_BATCH_SIZE = 10;
const MAX_STORED_ERROR_LENGTH = 500;

export interface EmailProcessorOptions {
  batchSize?: number;
  recipientResolver?: RecipientResolver;
  classifier?: EmailClassifier;
  careerContextProvider?: CareerContextProvider;
  schedulingWorkflow?: SchedulingWorkflow;
  conversationRepository?: ConversationRepository;
}

export type RetryGenerationOutcome = "generated" | "failed" | "unavailable";

export class EmailProcessor {
  readonly #emailProvider: EmailProvider;
  readonly #emailRepository: EmailRepository;
  readonly #draftRepository: DraftRepository;
  readonly #aiProvider: AiProvider;
  readonly #logger: Logger;
  readonly #batchSize: number;
  readonly #recipientResolver: RecipientResolver | undefined;
  readonly #classifier: EmailClassifier | undefined;
  readonly #careerContextProvider: CareerContextProvider | undefined;
  readonly #schedulingWorkflow: SchedulingWorkflow | undefined;
  readonly #conversationRepository: ConversationRepository | undefined;

  constructor(
    emailProvider: EmailProvider,
    emailRepository: EmailRepository,
    draftRepository: DraftRepository,
    aiProvider: AiProvider,
    logger: Logger,
    options: EmailProcessorOptions = {},
  ) {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error("Email processor batch size must be a positive integer");
    }

    this.#emailProvider = emailProvider;
    this.#emailRepository = emailRepository;
    this.#draftRepository = draftRepository;
    this.#aiProvider = aiProvider;
    this.#logger = logger.child({ component: "email-processor" });
    this.#batchSize = batchSize;
    this.#recipientResolver = options.recipientResolver;
    this.#classifier = options.classifier;
    this.#careerContextProvider = options.careerContextProvider;
    this.#schedulingWorkflow = options.schedulingWorkflow;
    this.#conversationRepository = options.conversationRepository;
  }

  async processPending(signal?: AbortSignal): Promise<void> {
    const pendingEmails = await this.#emailRepository.listByStatus(
      "discovered",
      this.#batchSize,
    );

    if (pendingEmails.length === 0) {
      return;
    }

    this.#logger.info(
      { pendingCount: pendingEmails.length },
      "Processing discovered emails",
    );

    for (const email of pendingEmails) {
      if (signal?.aborted) {
        break;
      }

      await this.#processEmail(email, signal);
    }
  }

  async retryFailedGeneration(
    providerMessageId: string,
    signal?: AbortSignal,
  ): Promise<RetryGenerationOutcome> {
    const email = await this.#emailRepository.findByProviderMessageId(
      providerMessageId,
    );
    if (!email) return "unavailable";

    const claimed = await this.#emailRepository.claimFailedGenerationRetry(
      providerMessageId,
    );
    if (!claimed) return "unavailable";

    this.#logger.info(
      {
        providerMessageId,
        manualRetry: email.manualRetryCount + 1,
      },
      "Retrying failed email draft generation",
    );

    return this.#generateClaimedEmail(email, signal);
  }

  async #processEmail(email: StoredEmail, signal?: AbortSignal): Promise<void> {
    const claimed = await this.#emailRepository.claimForDrafting(
      email.providerMessageId,
    );

    if (!claimed) {
      return;
    }

    await this.#generateClaimedEmail(email, signal);
  }

  async #generateClaimedEmail(
    email: StoredEmail,
    signal?: AbortSignal,
  ): Promise<"generated" | "failed"> {
    try {
      const message = await this.#emailProvider.getMessage(
        email.providerMessageId,
      );

      if (message.automationReason) {
        const ignored = await this.#emailRepository.markIgnored(
          email.providerMessageId,
          "drafting",
          message.automationReason,
        );

        if (!ignored) {
          throw new Error("Email could not be marked ignored from drafting");
        }

        this.#logger.info(
          {
            providerMessageId: email.providerMessageId,
            reason: message.automationReason,
          },
          "Ignored an automated email",
        );
        return "generated";
      }

      if (
        this.#schedulingWorkflow &&
        await this.#schedulingWorkflow.handleIncomingReply(email, message, signal)
      ) {
        return "generated";
      }

      const resolvedContext = this.#recipientResolver?.resolve(message);
      const classification = await this.#classifyEmail(
        email,
        {
          from: resolvedContext
            ? resolvedContext.from.map(formatAddress).join(", ") || message.from
            : message.from,
          subject: resolvedContext?.subject ?? message.subject,
          body: resolvedContext?.body ?? message.textBody,
        },
        signal,
      );
      const routingAction = determineEmailRoutingAction(classification);

      if (routingAction === "silent_ignore" && classification) {
        await this.#ignoreClassifiedEmail(email, classification.category);
        return "generated";
      }

      const conversation = classification && this.#conversationRepository
        ? await this.#conversationRepository.ensureForEmail({
            gmailThreadId: email.threadId,
            providerMessageId: email.providerMessageId,
            subject: resolvedContext?.subject ?? message.subject,
            summary: classification.summary,
            status: routingAction === "interview_notification"
              ? "scheduling_needed"
              : "processing",
          })
        : null;

      if (routingAction === "interview_notification" && classification) {
        if (this.#schedulingWorkflow) {
          await this.#schedulingWorkflow.start(
            email.providerMessageId,
            {
              from: resolvedContext
                ? resolvedContext.from.map(formatAddress).join(", ") || message.from
                : message.from,
              subject: resolvedContext?.subject ?? message.subject,
              body: resolvedContext?.body ?? message.textBody,
              anchor: message.receivedAt,
            },
            signal,
          );
          if (conversation) {
            await this.#conversationRepository?.setStatus(
              conversation.gmailThreadId,
              "scheduling_needed",
            );
          }
          return "generated";
        }
        await this.#ignoreClassifiedEmail(email, classification.category);
        return "generated";
      }

      const trustedCareerContext =
        routingAction === "career_context"
          ? await this.#loadCareerContext()
          : undefined;
      const generatedReply = await this.#aiProvider.generateReply(
        {
          from: resolvedContext
            ? resolvedContext.from.map(formatAddress).join(", ") || message.from
            : message.from,
          subject: resolvedContext?.subject ?? message.subject,
          body: resolvedContext?.body ?? message.textBody,
          ...(trustedCareerContext ? { trustedCareerContext } : {}),
        },
        signal,
      );

      const draft = await this.#draftRepository.saveAndAwaitApproval(
        email.providerMessageId,
        generatedReply,
      );

      if (!draft) {
        throw new Error("Email left drafting before its draft could be saved");
      }

      if (conversation) {
        await this.#conversationRepository?.setStatus(
          conversation.gmailThreadId,
          "draft_awaiting_approval",
        );
      }

      this.#logger.info(
        {
          providerMessageId: email.providerMessageId,
          draftId: draft.id,
          revision: draft.revision,
          model: draft.resolvedModel,
          promptTokens: draft.promptTokens,
          completionTokens: draft.completionTokens,
        },
        "Generated and stored an email reply draft",
      );
      return "generated";
    } catch (error: unknown) {
      if (signal?.aborted) {
        await this.#emailRepository.transitionStatus(
          email.providerMessageId,
          "drafting",
          "discovered",
        );

        this.#logger.info(
          { providerMessageId: email.providerMessageId },
          "Released email after draft generation was cancelled",
        );
        return "failed";
      }

      const errorSummary = summarizeError(error);
      const aiFailure = readAiProviderFailureDetails(error);
      const markedFailed = await this.#emailRepository.markFailed(
        email.providerMessageId,
        "drafting",
        {
          stage: "draft_generation",
          code: aiFailure?.code ?? "draft_generation_failed",
          technicalMessage: errorSummary,
          userMessage:
            aiFailure?.userMessage ??
            "OpenRouter could not generate a complete draft.",
        },
      );
      await this.#conversationRepository?.setStatusByProviderMessageId(
        email.providerMessageId,
        "failed",
      );

      this.#logger.error(
        {
          err: error,
          ...(aiFailure ?? {}),
          providerMessageId: email.providerMessageId,
          markedFailed,
        },
        "Email draft generation failed",
      );
      return "failed";
    }
  }

  async #classifyEmail(
    email: StoredEmail,
    input: { from: string; subject: string; body: string },
    signal?: AbortSignal,
  ): Promise<EmailClassification | null> {
    if (!this.#classifier) return null;
    if (email.classification) return email.classification;

    const previous = await this.#emailRepository.findLatestClassificationByThreadId(
      email.threadId,
      email.providerMessageId,
    );
    const classification = await this.#classifier.classify(
      {
        ...input,
        previousThreadCategory: previous?.category ?? null,
      },
      signal,
    );
    const saved = await this.#emailRepository.saveClassification(
      email.providerMessageId,
      classification,
    );
    if (!saved) {
      throw new Error("Email classification could not be persisted");
    }

    this.#logger.info(
      {
        providerMessageId: email.providerMessageId,
        threadId: email.threadId,
        category: classification.category,
        confidence: classification.confidence,
        previousThreadCategory: previous?.category ?? null,
        model: classification.resolvedModel,
      },
      "Classified an incoming email",
    );
    return classification;
  }

  async #ignoreClassifiedEmail(
    email: StoredEmail,
    category: EmailCategory,
  ): Promise<void> {
    const ignored = await this.#emailRepository.markIgnored(
      email.providerMessageId,
      "drafting",
      `classification:${category}`,
    );
    if (!ignored) {
      throw new Error("Classified email could not be marked ignored");
    }

    this.#logger.info(
      { providerMessageId: email.providerMessageId, category },
      category === "interview_scheduling"
        ? "Held interview scheduling email for future calendar confirmation"
        : "Silently ignored classified email",
    );
  }

  async #loadCareerContext(): Promise<Readonly<Record<string, unknown>>> {
    if (!this.#careerContextProvider) {
      throw new Error("Recruiter email requires a configured career profile");
    }
    return this.#careerContextProvider.load();
  }
}

function formatAddress(address: { name: string | null; address: string }): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.replaceAll(/\s+/g, " ").trim().slice(0, MAX_STORED_ERROR_LENGTH);
}
