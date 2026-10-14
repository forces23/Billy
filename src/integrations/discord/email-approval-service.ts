import type { Logger } from "pino";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type {
  ButtonInteraction,
  Interaction,
  ModalSubmitInteraction,
} from "discord.js";

import type { ApprovalWorkflow } from "../../core/approval-workflow.js";
import type { EmailProcessor } from "../../core/email-processor.js";
import type {
  RecipientResolver,
  ResolvedEmailContext,
} from "../../core/recipient-resolver.js";
import type {
  ApprovalRepository,
  DeliveryStatusUpdate,
  GenerationFailureNotice,
  ReplyMode,
} from "../../interfaces/approval-repository.js";
import { formatEmailAddress } from "../../interfaces/approval-repository.js";
import type { DraftRepository, StoredDraft } from "../../interfaces/draft-repository.js";
import type { EmailProvider } from "../../interfaces/email-provider.js";
import type { EmailRepository } from "../../interfaces/email-repository.js";

const PUBLICATION_INTERVAL_MILLISECONDS = 5_000;
const PUBLICATION_BATCH_SIZE = 25;
const FULL_EMAIL_PAGE_CHARACTERS = 3_800;

export interface DiscordEmailApprovalServiceOptions {
  botToken: string;
  emailChannelId: string;
  approverUserIds: readonly string[];
}

export class DiscordEmailApprovalService {
  readonly #client: Client;
  readonly #emailProvider: EmailProvider;
  readonly #emailRepository: EmailRepository;
  readonly #draftRepository: DraftRepository;
  readonly #approvalRepository: ApprovalRepository;
  readonly #approvalWorkflow: ApprovalWorkflow;
  readonly #emailProcessor: EmailProcessor;
  readonly #recipientResolver: RecipientResolver;
  readonly #logger: Logger;
  readonly #botToken: string;
  readonly #emailChannelId: string;
  readonly #approverUserIds: ReadonlySet<string>;
  #channel: TextChannel | undefined;
  #publishing = false;

  constructor(
    client: Client,
    emailProvider: EmailProvider,
    emailRepository: EmailRepository,
    draftRepository: DraftRepository,
    approvalRepository: ApprovalRepository,
    approvalWorkflow: ApprovalWorkflow,
    emailProcessor: EmailProcessor,
    recipientResolver: RecipientResolver,
    logger: Logger,
    options: DiscordEmailApprovalServiceOptions,
  ) {
    this.#client = client;
    this.#emailProvider = emailProvider;
    this.#emailRepository = emailRepository;
    this.#draftRepository = draftRepository;
    this.#approvalRepository = approvalRepository;
    this.#approvalWorkflow = approvalWorkflow;
    this.#emailProcessor = emailProcessor;
    this.#recipientResolver = recipientResolver;
    this.#logger = logger.child({ component: "discord-email-approval" });
    this.#botToken = options.botToken;
    this.#emailChannelId = options.emailChannelId;
    this.#approverUserIds = new Set(options.approverUserIds);
  }

  async run(signal: AbortSignal): Promise<void> {
    const handleInteraction = (interaction: Interaction): void => {
      void this.#handleInteraction(interaction).catch((error: unknown) => {
        this.#logger.error(
          { err: error, interactionId: interaction.id },
          "Discord interaction handling failed",
        );
        void respondToInteractionError(interaction);
      });
    };
    const handleClientError = (error: Error): void => {
      this.#logger.error({ err: error }, "Discord client error");
    };

    this.#client.on(Events.InteractionCreate, handleInteraction);
    this.#client.on(Events.Error, handleClientError);

    try {
      const ready = new Promise<void>((resolve) => {
        this.#client.once(Events.ClientReady, () => resolve());
      });
      await this.#client.login(this.#botToken);
      await ready;
      this.#channel = await this.#fetchEmailChannel();

      try {
        await this.#refreshPublishedAwaitingDrafts();
      } catch (error: unknown) {
        this.#logger.warn(
          { err: error },
          "Existing Discord approval controls could not be refreshed",
        );
      }

      this.#logger.info(
        {
          botUserId: this.#client.user?.id,
          emailChannelId: this.#emailChannelId,
        },
        "Discord email approval service started",
      );

      while (!signal.aborted) {
        try {
          await this.#publishPendingDrafts();
        } catch (error: unknown) {
          this.#logger.error(
            { err: error },
            "Discord draft publication cycle failed and will be retried",
          );
        }
        try {
          await this.#synchronizeGenerationFailures();
        } catch (error: unknown) {
          this.#logger.error(
            { err: error },
            "Discord generation failure sync failed and will be retried",
          );
        }
        try {
          await this.#publishInterviewSchedulingNotices();
        } catch (error: unknown) {
          this.#logger.error(
            { err: error },
            "Discord interview scheduling notice publication failed and will be retried",
          );
        }
        try {
          await this.#synchronizeDeliveryStatuses();
        } catch (error: unknown) {
          this.#logger.error(
            { err: error },
            "Discord delivery status sync failed and will be retried",
          );
        }
        await waitForNextRun(PUBLICATION_INTERVAL_MILLISECONDS, signal);
      }
    } finally {
      this.#client.off(Events.InteractionCreate, handleInteraction);
      this.#client.off(Events.Error, handleClientError);
      this.#client.destroy();
      this.#logger.info("Discord email approval service stopped");
    }
  }

  async #fetchEmailChannel(): Promise<TextChannel> {
    const channel = await this.#client.channels.fetch(this.#emailChannelId);

    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(
        "DISCORD_EMAIL_CHANNEL_ID must identify a server text channel",
      );
    }

    return channel;
  }

  async #publishPendingDrafts(): Promise<void> {
    if (this.#publishing) return;
    this.#publishing = true;

    try {
      const channel = this.#channel ?? (await this.#fetchEmailChannel());
      const pendingDraftIds =
        await this.#approvalRepository.listUnpublishedAwaitingDraftIds(
          PUBLICATION_BATCH_SIZE,
        );
      if (pendingDraftIds.length === 0) return;

      const recentMessages = await channel.messages.fetch({ limit: 100 });

      for (const draftId of pendingDraftIds) {
        const footer = publicationFooter(draftId);
        const existingMessage = recentMessages.find(
          (message) =>
            message.author.id === this.#client.user?.id &&
            message.embeds.some((embed) => embed.footer?.text === footer),
        );

        if (existingMessage) {
          await this.#approvalRepository.savePublication(
            draftId,
            channel.id,
            existingMessage.id,
          );
          continue;
        }

        try {
          await this.#publishDraft(draftId, channel);
        } catch (error: unknown) {
          this.#logger.error(
            { err: error, draftId },
            "Discord draft publication failed and will be retried",
          );
        }
      }
    } finally {
      this.#publishing = false;
    }
  }

  async #refreshPublishedAwaitingDrafts(): Promise<void> {
    const channel = this.#channel ?? (await this.#fetchEmailChannel());
    const publications =
      await this.#approvalRepository.listPublishedAwaitingDrafts(
        PUBLICATION_BATCH_SIZE,
      );
    let refreshedCount = 0;

    for (const publication of publications) {
      try {
        const draft = await this.#draftRepository.findById(publication.draftId);
        if (!draft) continue;
        const sourceMessage = await this.#emailProvider.getMessage(
          draft.providerMessageId,
        );
        const context = this.#recipientResolver.resolve(sourceMessage);
        const discordMessage = await channel.messages.fetch(
          publication.messageId,
        );
        await discordMessage.edit({
          components: buildApprovalButtons(
            draft.id,
            context.requiresManualRecipients,
            false,
          ),
        });
        refreshedCount += 1;
      } catch (error: unknown) {
        this.#logger.warn(
          { err: error, draftId: publication.draftId },
          "An existing Discord approval card could not be refreshed",
        );
      }
    }

    if (refreshedCount > 0) {
      this.#logger.info(
        { refreshedCount },
        "Refreshed existing Discord approval controls",
      );
    }
  }

  async #publishDraft(draftId: number, channel: TextChannel): Promise<void> {
    const draft = await this.#draftRepository.findById(draftId);
    if (!draft) return;

    const storedEmail = await this.#emailRepository.findByProviderMessageId(
      draft.providerMessageId,
    );
    if (storedEmail?.status !== "awaiting_approval") return;

    const message = await this.#emailProvider.getMessage(
      draft.providerMessageId,
    );
    const context = this.#recipientResolver.resolve(message);
    const sentMessage = await channel.send({
      embeds: [buildApprovalEmbed(draft, message.receivedAt, context)],
      components: buildApprovalButtons(
        draft.id,
        context.requiresManualRecipients,
        false,
      ),
      allowedMentions: { parse: [] },
    });

    const saved = await this.#approvalRepository.savePublication(
      draft.id,
      channel.id,
      sentMessage.id,
    );

    if (!saved) {
      await sentMessage.delete();
      return;
    }

    this.#logger.info(
      {
        providerMessageId: draft.providerMessageId,
        draftId: draft.id,
        revision: draft.revision,
        discordMessageId: sentMessage.id,
      },
      "Published an email draft for Discord approval",
    );
  }

  async #synchronizeGenerationFailures(): Promise<void> {
    const channel = this.#channel ?? (await this.#fetchEmailChannel());
    const failures =
      await this.#approvalRepository.listGenerationFailuresNeedingPublication(
        PUBLICATION_BATCH_SIZE,
      );

    for (const failure of failures) {
      try {
        let messageId = failure.publication?.messageId;
        let discordMessage = messageId
          ? await channel.messages.fetch(messageId).catch(() => undefined)
          : undefined;

        if (!discordMessage) {
          discordMessage = await channel.send({
            embeds: [buildGenerationFailureEmbed(failure)],
            components: buildGenerationRetryButton(
              failure.providerMessageId,
              false,
            ),
            allowedMentions: { parse: [] },
          });
          messageId = discordMessage.id;
        } else {
          await discordMessage.edit({
            embeds: [buildGenerationFailureEmbed(failure)],
            components: buildGenerationRetryButton(
              failure.providerMessageId,
              false,
            ),
            allowedMentions: { parse: [] },
          });
        }

        await this.#approvalRepository.saveGenerationFailurePublication(
          failure.providerMessageId,
          channel.id,
          discordMessage.id,
          failure.failedAt,
        );
      } catch (error: unknown) {
        this.#logger.error(
          { err: error, providerMessageId: failure.providerMessageId },
          "Discord generation failure publication failed and will be retried",
        );
      }
    }

    const resolved =
      await this.#approvalRepository.listResolvedGenerationFailurePublications(
        PUBLICATION_BATCH_SIZE,
      );
    for (const item of resolved) {
      try {
        const message = await channel.messages.fetch(item.publication.messageId);
        await message.edit({
          embeds: [buildGenerationResolvedEmbed(item.subject, item.emailStatus)],
          components: [],
          allowedMentions: { parse: [] },
        });
        await this.#approvalRepository.markGenerationFailurePublicationResolved(
          item.publication.providerMessageId,
        );
      } catch (error: unknown) {
        this.#logger.error(
          {
            err: error,
            providerMessageId: item.publication.providerMessageId,
          },
          "Discord generation recovery update failed and will be retried",
        );
      }
    }
  }

  async #synchronizeDeliveryStatuses(): Promise<void> {
    const channel = this.#channel ?? (await this.#fetchEmailChannel());
    const updates = await this.#approvalRepository.listDeliveryStatusUpdates(
      PUBLICATION_BATCH_SIZE,
    );

    for (const update of updates) {
      try {
        const message = await channel.messages.fetch(update.messageId);
        const existing = message.embeds[0];
        const embed = existing
          ? EmbedBuilder.from(existing)
          : new EmbedBuilder().setTitle(
              truncate(`Email draft v${update.revision}: ${update.subject}`, 180),
            );
        const fields = (existing?.fields ?? []).filter(
          (field) => field.name !== "Delivery status",
        );
        embed
          .setColor(deliveryStatusColor(update.displayStatus))
          .setFields(...fields, {
            name: "Delivery status",
            value: deliveryStatusText(update),
          });

        await message.edit({
          embeds: [embed],
          components: buildApprovalButtons(update.draftId, false, true),
          allowedMentions: { parse: [] },
        });
        await this.#approvalRepository.markDeliveryStatusRendered(
          update.draftId,
          update.displayStatus,
        );
      } catch (error: unknown) {
        this.#logger.error(
          {
            err: error,
            providerMessageId: update.providerMessageId,
            draftId: update.draftId,
            deliveryStatus: update.displayStatus,
          },
          "Discord delivery status update failed and will be retried",
        );
      }
    }
  }

  async #publishInterviewSchedulingNotices(): Promise<void> {
    const channel = this.#channel ?? (await this.#fetchEmailChannel());
    const notices =
      await this.#approvalRepository.listUnpublishedInterviewSchedulingNotices(
        PUBLICATION_BATCH_SIZE,
      );

    for (const notice of notices) {
      const sentMessage = await channel.send({
        content: `Billy chose **${escapeDiscordMarkdown(notice.subject || "(no subject)")}** as \`interview_scheduling\`. Calendar availability and date actions are not enabled yet, so no reply was generated.`,
        allowedMentions: { parse: [] },
      });
      const saved = await this.#approvalRepository.saveClassificationPublication(
        notice.providerMessageId,
        channel.id,
        sentMessage.id,
      );
      if (!saved) {
        await sentMessage.delete();
      }
    }
  }

  async #handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;

    if (interaction.channelId !== this.#emailChannelId) {
      await interaction.reply({
        content: "This email action is only available in the configured email channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!this.#approverUserIds.has(interaction.user.id)) {
      await interaction.reply({
        content: "You are not authorized to review Billy's email drafts.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isButton()) {
      await this.#handleButton(interaction);
      return;
    }

    await this.#handleModal(interaction);
  }

  async #handleButton(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseButtonId(interaction.customId);
    if (!parsed) return;

    if (parsed.action === "view-full") {
      await this.#showFullEmailReview(
        interaction,
        parsed.draftId,
        parsed.page,
      );
      return;
    }

    if (parsed.action === "revise") {
      await interaction.showModal(buildRevisionModal(parsed.draftId));
      return;
    }

    if (parsed.action === "approve-manual") {
      await interaction.showModal(
        buildManualRecipientsModal(parsed.draftId, parsed.mode),
      );
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (parsed.action === "retry-generation") {
      await interaction.message.edit({
        embeds: [buildGenerationRetryingEmbed()],
        components: buildGenerationRetryButton(parsed.providerMessageId, true),
        allowedMentions: { parse: [] },
      });
      const outcome = await this.#emailProcessor.retryFailedGeneration(
        parsed.providerMessageId,
      );

      if (outcome === "unavailable") {
        await interaction.editReply(
          "This email is no longer waiting for a generation retry.",
        );
        await this.#synchronizeGenerationFailures();
        return;
      }

      await this.#synchronizeGenerationFailures();
      if (outcome === "generated") {
        await this.#publishPendingDrafts();
        await interaction.editReply(
          "Draft generation succeeded and a new approval card is ready.",
        );
        return;
      }

      await interaction.editReply(
        "Draft generation failed again. The failure card has been updated with the latest reason.",
      );
      return;
    }

    if (parsed.action === "cancel") {
      const decision = await this.#approvalWorkflow.doNotReply(
        parsed.draftId,
        interaction.user.id,
      );

      if (!decision) {
        await interaction.editReply("This email was already resolved.");
        return;
      }

      await this.#disablePublications(decision.providerMessageId);
      await interaction.editReply("Billy will not reply to this email.");
      return;
    }

    const result = await this.#approvalWorkflow.approve(
      parsed.draftId,
      parsed.mode,
      interaction.user.id,
    );

    if (result.outcome === "manual_recipients_required") {
      await interaction.editReply(
        "Recipient confirmation is required. Use the approval button again to enter recipients.",
      );
      return;
    }

    if (result.outcome === "already_resolved") {
      await interaction.editReply("This email was already resolved.");
      return;
    }

    await this.#disablePublications(result.decision.providerMessageId);
    await interaction.editReply(
      `Revision ${await this.#revisionNumber(parsed.draftId)} was approved with ${replyModeLabel(parsed.mode)} and queued for Gmail.`,
    );
  }

  async #handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const revisionMatch = /^email:revision:(\d+)$/.exec(interaction.customId);
    if (revisionMatch) {
      const draftId = Number(revisionMatch[1]);
      const instructions = interaction.fields.getTextInputValue("instructions");
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await this.#approvalWorkflow.requestRevision(
        interaction.id,
        draftId,
        interaction.user.id,
        instructions,
      );

      if (!result) {
        await interaction.editReply(
          "This email was already resolved or this request was already handled.",
        );
        return;
      }

      try {
        await this.#publishPendingDrafts();
      } catch (error: unknown) {
        this.#logger.warn(
          { err: error, draftId: result.draft.id },
          "The new revision is stored and Discord publication will be retried",
        );
      }
      await interaction.editReply(
        `Revision ${result.draft.revision} was generated and queued for approval.`,
      );
      return;
    }

    const manualMatch =
      /^email:approve-manual:(reply|reply_all):(\d+)$/.exec(
        interaction.customId,
      );
    if (!manualMatch) return;

    const mode = manualMatch[1] as ReplyMode;
    const draftId = Number(manualMatch[2]);
    const recipients = this.#recipientResolver.parseManualRecipients(
      interaction.fields.getTextInputValue("to"),
      interaction.fields.getTextInputValue("cc"),
    );
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await this.#approvalWorkflow.approve(
      draftId,
      mode,
      interaction.user.id,
      recipients,
    );

    if (result.outcome !== "approved") {
      await interaction.editReply("This email was already resolved.");
      return;
    }

    await this.#disablePublications(result.decision.providerMessageId);
    await interaction.editReply(
      `Revision ${await this.#revisionNumber(draftId)} was approved with confirmed recipients and queued for Gmail.`,
    );
  }

  async #disablePublications(providerMessageId: string): Promise<void> {
    const channel = this.#channel ?? (await this.#fetchEmailChannel());
    const publications =
      await this.#approvalRepository.listPublicationsByProviderMessageId(
        providerMessageId,
      );

    await Promise.allSettled(
      publications.map(async (publication) => {
        const message = await channel.messages.fetch(publication.messageId);
        await message.edit({
          components: buildApprovalButtons(publication.draftId, false, true),
        });
      }),
    );
  }

  async #showFullEmailReview(
    interaction: ButtonInteraction,
    draftId: number,
    requestedPage: number,
  ): Promise<void> {
    const isInitialView = !interaction.customId.includes(":page:");
    if (isInitialView) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
      await interaction.deferUpdate();
    }

    const draft = await this.#draftRepository.findById(draftId);
    if (!draft) {
      await interaction.editReply({
        content: "This email draft is no longer available.",
        embeds: [],
        components: [],
      });
      return;
    }

    const message = await this.#emailProvider.getMessage(
      draft.providerMessageId,
    );
    const context = this.#recipientResolver.resolve(message);
    const pages = paginateFullEmailReview(
      buildFullEmailReviewText(draft, message, context),
    );
    const page = Math.max(0, Math.min(requestedPage, pages.length - 1));

    await interaction.editReply({
      content: "",
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(
            truncate(
              `Full email review: ${message.subject || "(no subject)"}`,
              180,
            ),
          )
          .setDescription(pages[page] ?? "(empty email)")
          .setFooter({
            text: `Private reviewer view · draft v${draft.revision} · page ${page + 1} of ${pages.length}`,
          }),
      ],
      components: buildFullEmailNavigation(draftId, page, pages.length),
      allowedMentions: { parse: [] },
    });
  }

  async #revisionNumber(draftId: number): Promise<number> {
    return (await this.#draftRepository.findById(draftId))?.revision ?? 0;
  }
}

type ParsedButton =
  | { action: "approve"; mode: ReplyMode; draftId: number }
  | { action: "approve-manual"; mode: ReplyMode; draftId: number }
  | { action: "revise"; draftId: number }
  | { action: "cancel"; draftId: number }
  | { action: "view-full"; draftId: number; page: number }
  | { action: "retry-generation"; providerMessageId: string };

function parseButtonId(customId: string): ParsedButton | null {
  const viewFirstPage = /^email:view-full:(\d+)$/.exec(customId);
  if (viewFirstPage?.[1]) {
    return {
      action: "view-full",
      draftId: Number(viewFirstPage[1]),
      page: 0,
    };
  }

  const viewPage = /^email:view-full:page:(\d+):(\d+)$/.exec(customId);
  if (viewPage?.[1] && viewPage[2]) {
    return {
      action: "view-full",
      draftId: Number(viewPage[1]),
      page: Number(viewPage[2]),
    };
  }

  const retryGeneration =
    /^email:retry-generation:([A-Za-z0-9_-]+)$/.exec(customId);
  if (retryGeneration?.[1]) {
    return {
      action: "retry-generation",
      providerMessageId: retryGeneration[1],
    };
  }

  const approve = /^email:(approve|approve-manual):(reply|reply_all):(\d+)$/.exec(
    customId,
  );
  if (approve) {
    return {
      action: approve[1] as "approve" | "approve-manual",
      mode: approve[2] as ReplyMode,
      draftId: Number(approve[3]),
    };
  }

  const other = /^email:(revise|cancel):(\d+)$/.exec(customId);
  if (!other) return null;
  return {
    action: other[1] as "revise" | "cancel",
    draftId: Number(other[2]),
  };
}

function buildGenerationRetryButton(
  providerMessageId: string,
  disabled: boolean,
): readonly ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`email:retry-generation:${providerMessageId}`)
        .setLabel(disabled ? "Retrying…" : "Retry Generation")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  ];
}

function buildGenerationFailureEmbed(
  failure: GenerationFailureNotice,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(
      truncate(
        `Draft generation failed: ${failure.subject || "(no subject)"}`,
        180,
      ),
    )
    .setDescription(failure.userMessage)
    .addFields(
      { name: "Failure code", value: failure.failureCode },
      {
        name: "Attempts",
        value: `3 automatic attempts in the latest run · ${failure.manualRetryCount} manual retries`,
      },
      { name: "Failed", value: failure.failedAt.toISOString() },
    )
    .setFooter({
      text: `billy:generation-failure:${failure.providerMessageId}`,
    });
}

function buildGenerationRetryingEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("Retrying draft generation")
    .setDescription(
      "Billy is asking OpenRouter to generate this draft again. The retry button is disabled while this runs.",
    );
}

function buildGenerationResolvedEmbed(
  subject: string,
  emailStatus: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(truncate(`Draft generation recovered: ${subject}`, 180))
    .setDescription(
      emailStatus === "awaiting_approval"
        ? "A draft was generated successfully. Use the new approval card to review it."
        : "This generation failure has been resolved.",
    );
}

function deliveryStatusColor(status: DeliveryStatusUpdate["displayStatus"]): number {
  if (status === "sent") return 0x57f287;
  if (status === "failed") return 0xed4245;
  if (status === "sending") return 0x5865f2;
  return 0xfee75c;
}

function deliveryStatusText(update: DeliveryStatusUpdate): string {
  const mode = update.decision === "approved_reply" ? "Reply" : "Reply All";
  if (update.displayStatus === "queued") {
    return `⏳ Queued for Gmail · ${mode}`;
  }
  if (update.displayStatus === "sending") {
    return `📤 Sending through Gmail · ${mode}`;
  }
  if (update.displayStatus === "sent") {
    return `✅ Sent successfully · ${mode} · ${update.sentAt?.toISOString() ?? "time unavailable"}`;
  }
  return `❌ Sending failed · ${update.failureUserMessage ?? "Gmail could not send the approved reply."}`;
}

function buildApprovalButtons(
  draftId: number,
  manualRecipients: boolean,
  disabled: boolean,
): readonly ActionRowBuilder<ButtonBuilder>[] {
  const approvalAction = manualRecipients ? "approve-manual" : "approve";
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`email:${approvalAction}:reply:${draftId}`)
        .setLabel("Approve Reply")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`email:${approvalAction}:reply_all:${draftId}`)
        .setLabel("Approve Reply All")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`email:revise:${draftId}`)
        .setLabel("Reject w/comments")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`email:cancel:${draftId}`)
        .setLabel("Do not reply")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`email:view-full:${draftId}`)
        .setLabel("View Full Email")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildFullEmailNavigation(
  draftId: number,
  page: number,
  pageCount: number,
): readonly ActionRowBuilder<ButtonBuilder>[] {
  if (pageCount <= 1) return [];

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`email:view-full:page:${draftId}:${Math.max(0, page - 1)}`)
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`email:view-full:indicator:${draftId}:${page}`)
        .setLabel(`${page + 1} / ${pageCount}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(
          `email:view-full:page:${draftId}:${Math.min(pageCount - 1, page + 1)}`,
        )
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === pageCount - 1),
    ),
  ];
}

function buildFullEmailReviewText(
  draft: StoredDraft,
  message: {
    from: string;
    to: readonly string[];
    cc: readonly string[];
    subject: string;
    receivedAt: Date;
    textBody: string;
  },
  context: ResolvedEmailContext,
): string {
  const incoming = [
    "INCOMING EMAIL",
    `From: ${message.from || "Unknown"}`,
    `To: ${message.to.join(", ") || "Unknown"}`,
    ...(message.cc.length > 0 ? [`Cc: ${message.cc.join(", ")}`] : []),
    `Subject: ${message.subject || "(no subject)"}`,
    `Received: ${message.receivedAt.toISOString()}`,
    "",
    message.textBody || "(empty message)",
  ].join("\n");
  const outgoing = [
    "PROPOSED REPLY",
    `Draft revision: ${draft.revision}`,
    `Reply recipients: ${formatRecipients(context.reply)}`,
    `Reply All recipients: ${formatRecipients(context.replyAll)}`,
    "",
    draft.body,
    "",
    "PRIVATE REVIEWER NOTE",
    draft.reviewerNote ?? "None",
  ].join("\n");

  return `${incoming}\n\n${"-".repeat(40)}\n\n${outgoing}`;
}

export function paginateFullEmailReview(
  value: string,
  maximumPageCharacters = FULL_EMAIL_PAGE_CHARACTERS,
): readonly string[] {
  if (!Number.isInteger(maximumPageCharacters) || maximumPageCharacters < 1) {
    throw new Error("Full email page size must be a positive integer");
  }
  if (!value) return ["(empty email)"];

  const pages: string[] = [];
  for (let offset = 0; offset < value.length; offset += maximumPageCharacters) {
    pages.push(value.slice(offset, offset + maximumPageCharacters));
  }
  return pages;
}

function buildApprovalEmbed(
  draft: StoredDraft,
  receivedAt: Date,
  context: ResolvedEmailContext,
): EmbedBuilder {
  const reply = formatRecipients(context.reply);
  const replyAll = formatRecipients(context.replyAll);
  const source =
    context.source === "forwarded"
      ? `Forwarded by ${context.forwardedBy ? formatEmailAddress(context.forwardedBy) : "unknown"}`
      : "Direct email";
  const warnings = [
    ...context.warnings,
    ...(context.requiresManualRecipients
      ? ["Recipient confirmation is required before approval"]
      : []),
  ];

  const embed = new EmbedBuilder()
    .setColor(context.requiresManualRecipients ? 0xfee75c : 0x5865f2)
    .setTitle(
      truncate(`Email draft v${draft.revision}: ${context.subject || "(no subject)"}`, 180),
    )
    .setDescription(draft.body)
    .addFields(
      {
        name: "Original sender",
        value: truncate(
          context.from.map(formatEmailAddress).join(", ") || "Unknown",
          200,
        ),
      },
      { name: "Reply", value: truncate(reply, 250) },
      { name: "Reply All", value: truncate(replyAll, 250) },
      {
        name: "Incoming excerpt",
        value: truncate(context.body || "(empty message)", 250),
      },
      {
        name: "Reviewer note",
        value: truncate(draft.reviewerNote ?? "None", 250),
      },
      {
        name: "Source",
        value: truncate(
          `${source} · received ${receivedAt.toISOString()} · ${draft.resolvedModel}`,
          250,
        ),
      },
    )
    .setFooter({ text: publicationFooter(draft.id) });

  if (warnings.length > 0) {
    embed.addFields({
      name: "Recipient warning",
      value: truncate(warnings.join("\n"), 250),
    });
  }

  return embed;
}

function buildRevisionModal(draftId: number): ModalBuilder {
  const instructions = new TextInputBuilder()
    .setCustomId("instructions")
    .setLabel("What should Billy change?")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1_000);

  return new ModalBuilder()
    .setCustomId(`email:revision:${draftId}`)
    .setTitle("Request email edits")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(instructions),
    );
}

function buildManualRecipientsModal(
  draftId: number,
  mode: ReplyMode,
): ModalBuilder {
  const to = new TextInputBuilder()
    .setCustomId("to")
    .setLabel("To (required)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(1_000);
  const cc = new TextInputBuilder()
    .setCustomId("cc")
    .setLabel("Cc (optional, comma-separated)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(1_000);

  return new ModalBuilder()
    .setCustomId(`email:approve-manual:${mode}:${draftId}`)
    .setTitle(`Confirm ${replyModeLabel(mode)} recipients`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(to),
      new ActionRowBuilder<TextInputBuilder>().addComponents(cc),
    );
}

function formatRecipients(recipients: {
  to: readonly { name: string | null; address: string }[];
  cc: readonly { name: string | null; address: string }[];
}): string {
  const to = recipients.to.map(formatEmailAddress).join(", ") || "Manual confirmation required";
  const cc = recipients.cc.map(formatEmailAddress).join(", ");
  return cc ? `To: ${to}\nCc: ${cc}` : `To: ${to}`;
}

function publicationFooter(draftId: number): string {
  return `billy:draft:${draftId}`;
}

function replyModeLabel(mode: ReplyMode): string {
  return mode === "reply" ? "Reply" : "Reply All";
}

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, Math.max(0, maximumLength - 14)).trimEnd()}… [truncated]`;
}

function escapeDiscordMarkdown(value: string): string {
  return value.replaceAll(/([\\`*_{}\[\]()#+\-.!|>~])/g, "\\$1");
}

function waitForNextRun(
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

async function respondToInteractionError(interaction: Interaction): Promise<void> {
  if (!interaction.isRepliable()) return;

  const content =
    "Billy could not complete that email action. The draft remains safe; check the application logs and try again.";

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content);
    } else {
      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch {
    // The interaction token may already have expired. The original error is logged.
  }
}
