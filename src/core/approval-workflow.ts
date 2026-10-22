import type { Logger } from "pino";

import type {
  RecipientSet,
  ResolvedEmailContext,
} from "./recipient-resolver.js";
import type { RecipientResolver } from "./recipient-resolver.js";
import type { AiProvider } from "../interfaces/ai-provider.js";
import type { CareerContextProvider } from "../interfaces/career-context-provider.js";
import type {
  ApprovalRepository,
  ReplyMode,
  StoredReviewDecision,
} from "../interfaces/approval-repository.js";
import type { DraftRepository, StoredDraft } from "../interfaces/draft-repository.js";
import type { EmailProvider } from "../interfaces/email-provider.js";
import type { EmailRepository } from "../interfaces/email-repository.js";
import { determineEmailRoutingAction } from "./email-routing-policy.js";
import type { SchedulingGuard } from "../interfaces/scheduling-repository.js";

const MAX_STORED_ERROR_LENGTH = 500;

export interface ApprovalWorkflowOptions {
  emailRepository?: EmailRepository;
  careerContextProvider?: CareerContextProvider;
  schedulingGuard?: SchedulingGuard;
}

export type ApprovalResult =
  | {
      outcome: "approved";
      decision: StoredReviewDecision;
    }
  | {
      outcome: "manual_recipients_required";
      context: ResolvedEmailContext;
    }
  | {
      outcome: "already_resolved";
    }
  | {
      outcome: "schedule_conflict";
      providerMessageId: string;
    };

export interface RevisionResult {
  draft: StoredDraft;
  requestId: number;
}

export class ApprovalWorkflow {
  readonly #emailProvider: EmailProvider;
  readonly #draftRepository: DraftRepository;
  readonly #approvalRepository: ApprovalRepository;
  readonly #aiProvider: AiProvider;
  readonly #recipientResolver: RecipientResolver;
  readonly #logger: Logger;
  readonly #emailRepository: EmailRepository | undefined;
  readonly #careerContextProvider: CareerContextProvider | undefined;
  readonly #schedulingGuard: SchedulingGuard | undefined;

  constructor(
    emailProvider: EmailProvider,
    draftRepository: DraftRepository,
    approvalRepository: ApprovalRepository,
    aiProvider: AiProvider,
    recipientResolver: RecipientResolver,
    logger: Logger,
    options: ApprovalWorkflowOptions = {},
  ) {
    this.#emailProvider = emailProvider;
    this.#draftRepository = draftRepository;
    this.#approvalRepository = approvalRepository;
    this.#aiProvider = aiProvider;
    this.#recipientResolver = recipientResolver;
    this.#logger = logger.child({ component: "approval-workflow" });
    this.#emailRepository = options.emailRepository;
    this.#careerContextProvider = options.careerContextProvider;
    this.#schedulingGuard = options.schedulingGuard;
  }

  async approve(
    draftId: number,
    mode: ReplyMode,
    reviewerUserId: string,
    manualRecipients?: RecipientSet,
  ): Promise<ApprovalResult> {
    const draft = await this.#draftRepository.findById(draftId);
    if (!draft) return { outcome: "already_resolved" };

    if (
      this.#schedulingGuard &&
      !(await this.#schedulingGuard.validateDraft(draftId))
    ) {
      return {
        outcome: "schedule_conflict",
        providerMessageId: draft.providerMessageId,
      };
    }

    const message = await this.#emailProvider.getEmailMessage(
      draft.providerMessageId,
    );
    const context = this.#recipientResolver.resolve(message);

    if (context.requiresManualRecipients && !manualRecipients) {
      return { outcome: "manual_recipients_required", context };
    }

    const recipients =
      manualRecipients ?? (mode === "reply" ? context.reply : context.replyAll);
    const decision = await this.#approvalRepository.approve(
      draftId,
      mode,
      recipients,
      reviewerUserId,
    );

    if (!decision) return { outcome: "already_resolved" };

    this.#logger.info(
      {
        providerMessageId: draft.providerMessageId,
        draftId,
        revision: draft.revision,
        mode,
        reviewerUserId,
        toCount: recipients.to.length,
        ccCount: recipients.cc.length,
      },
      "Approved an email draft",
    );

    return { outcome: "approved", decision };
  }

  async doNotReply(
    draftId: number,
    reviewerUserId: string,
  ): Promise<StoredReviewDecision | null> {
    const decision = await this.#approvalRepository.doNotReply(
      draftId,
      reviewerUserId,
    );

    if (decision) {
      this.#logger.info(
        {
          providerMessageId: decision.providerMessageId,
          draftId,
          reviewerUserId,
        },
        "Marked an email as do not reply",
      );
    }

    return decision;
  }

  async requestRevision(
    interactionId: string,
    sourceDraftId: number,
    reviewerUserId: string,
    instructions: string,
    signal?: AbortSignal,
  ): Promise<RevisionResult | null> {
    const request = await this.#approvalRepository.createRevisionRequest(
      interactionId,
      sourceDraftId,
      reviewerUserId,
      instructions,
    );
    if (!request) return null;

    try {
      const sourceDraft = await this.#draftRepository.findById(sourceDraftId);
      if (!sourceDraft) {
        throw new Error("The source draft no longer exists");
      }

      const message = await this.#emailProvider.getEmailMessage(
        sourceDraft.providerMessageId,
      );
      const context = this.#recipientResolver.resolve(message);
      const trustedCareerContext = await this.#careerContextForRevision(
        sourceDraft.providerMessageId,
      );
      const trustedSchedulingContext =
        await this.#schedulingGuard?.getDraftContext(sourceDraftId);
      const generatedReply = await this.#aiProvider.generateReply(
        {
          from:
            context.from.map(formatAddress).join(", ") || message.from,
          subject: context.subject,
          body: context.body,
          ...(trustedCareerContext ? { trustedCareerContext } : {}),
          ...(trustedSchedulingContext ? { trustedSchedulingContext } : {}),
          revision: {
            previousDraft: sourceDraft.body,
            instructions: request.instructions,
          },
        },
        signal,
      );
      const draft = await this.#draftRepository.saveRevisionWhileAwaitingApproval(
        sourceDraft.providerMessageId,
        generatedReply,
      );

      if (!draft) {
        throw new Error("The email was resolved before the revision completed");
      }

      if (
        this.#schedulingGuard &&
        !(await this.#schedulingGuard.linkRevision(sourceDraftId, draft.id))
      ) {
        throw new Error("The scheduling revision could not be linked to its calendar check");
      }

      const completed = await this.#approvalRepository.completeRevisionRequest(
        request.id,
        draft.id,
      );
      if (!completed) {
        throw new Error("The revision request could not be marked completed");
      }

      this.#logger.info(
        {
          providerMessageId: draft.providerMessageId,
          sourceDraftId,
          draftId: draft.id,
          revision: draft.revision,
          reviewerUserId,
        },
        "Generated a requested email draft revision",
      );

      return { draft, requestId: request.id };
    } catch (error: unknown) {
      await this.#approvalRepository.failRevisionRequest(
        request.id,
        summarizeError(error),
      );
      throw error;
    }
  }

  async #careerContextForRevision(
    providerMessageId: string,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    if (!this.#emailRepository || !this.#careerContextProvider) return undefined;
    const email = await this.#emailRepository.findByProviderMessageId(
      providerMessageId,
    );
    const classification = email?.classification;
    if (determineEmailRoutingAction(classification ?? null) !== "career_context") {
      return undefined;
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
