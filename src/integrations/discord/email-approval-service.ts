import type { Logger } from "pino";
import { DateTime } from "luxon";
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
  Message,
  ModalSubmitInteraction,
  ThreadChannel,
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
import type {
  ConversationRepository,
  EmailConversation,
} from "../../interfaces/conversation-repository.js";
import type {
  SchedulingRepository,
  SchedulingAvailabilityCard,
} from "../../interfaces/scheduling-repository.js";
import type { SchedulingWorkflow } from "../../core/scheduling-workflow.js";
import type { CalendarEventWorkflow } from "../../core/calendar-event-workflow.js";
import type {
  CalendarEventRecord,
  CalendarEventRepository,
} from "../../interfaces/calendar-event-repository.js";

const PUBLICATION_INTERVAL_MILLISECONDS = 5_000;
const PUBLICATION_BATCH_SIZE = 25;
const FULL_EMAIL_PAGE_CHARACTERS = 3_800;
type ReviewChannel = ThreadChannel;

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
  readonly #schedulingRepository: SchedulingRepository;
  readonly #schedulingWorkflow: SchedulingWorkflow;
  readonly #conversationRepository: ConversationRepository;
  readonly #calendarEventRepository: CalendarEventRepository;
  readonly #calendarEventWorkflow: CalendarEventWorkflow;
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
    schedulingRepository: SchedulingRepository,
    schedulingWorkflow: SchedulingWorkflow,
    conversationRepository: ConversationRepository,
    calendarEventRepository: CalendarEventRepository,
    calendarEventWorkflow: CalendarEventWorkflow,
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
    this.#schedulingRepository = schedulingRepository;
    this.#schedulingWorkflow = schedulingWorkflow;
    this.#conversationRepository = conversationRepository;
    this.#calendarEventRepository = calendarEventRepository;
    this.#calendarEventWorkflow = calendarEventWorkflow;
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
    const handleMessage = (message: Message): void => {
      void this.#handleSchedulingMessage(message).catch((error: unknown) => {
        this.#logger.error(
          { err: error, discordMessageId: message.id },
          "Discord scheduling conversation failed",
        );
        void message.reply({
          content:
            "I could not interpret that scheduling request or check the calendars. Nothing was selected or sent; please try again.",
          allowedMentions: { repliedUser: false },
        }).catch(() => undefined);
      });
    };

    this.#client.on(Events.InteractionCreate, handleInteraction);
    this.#client.on(Events.MessageCreate, handleMessage);
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
          await this.#publishConversations();
        } catch (error: unknown) {
          this.#logger.error(
            { err: error },
            "Discord conversation publication failed and will be retried",
          );
        }
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
          await this.#publishSchedulingSessions();
        } catch (error: unknown) {
          this.#logger.error(
            { err: error },
            "Discord scheduling publication failed and will be retried",
          );
        }
        try {
          await this.#schedulingWorkflow.reconcileAcceptedRecruiterProposals();
          await this.#publishCalendarEventProposals();
        } catch (error: unknown) {
          this.#logger.error(
            { err: error },
            "Discord calendar event publication failed and will be retried",
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
      this.#client.off(Events.MessageCreate, handleMessage);
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

  async #publishConversations(): Promise<void> {
    const channel = this.#channel ?? (await this.#fetchEmailChannel());
    const pending = await this.#conversationRepository.listUnpublished(
      PUBLICATION_BATCH_SIZE,
    );
    for (const conversation of pending) {
      const parent = await channel.send({
        embeds: [buildConversationEmbed(conversation)],
        allowedMentions: { parse: [] },
      });
      try {
        const thread = await parent.startThread({
          name: truncate(conversation.subject || "Email", 90),
          autoArchiveDuration: 1440,
          reason: "Billy email conversation",
        });
        const saved = await this.#conversationRepository.savePublication(
          conversation.gmailThreadId,
          channel.id,
          parent.id,
          thread.id,
        );
        if (!saved) {
          await thread.delete().catch(() => undefined);
          await parent.delete().catch(() => undefined);
        }
      } catch (error: unknown) {
        await parent.delete().catch(() => undefined);
        throw error;
      }
    }

    const refresh = await this.#conversationRepository.listNeedingRender(
      PUBLICATION_BATCH_SIZE,
    );
    for (const conversation of refresh) {
      if (!conversation.parentMessageId || !conversation.discordThreadId) continue;
      const parent = await channel.messages.fetch(conversation.parentMessageId);
      await parent.edit({
        embeds: [buildConversationEmbed(conversation)],
        components: buildOpenThreadButton(
          `https://discord.com/channels/${parent.guildId}/${conversation.discordThreadId}`,
        ),
        allowedMentions: { parse: [] },
      });
      await this.#publishInboundMessages(conversation);
      await this.#conversationRepository.markRendered(
        conversation.gmailThreadId,
        conversation.status,
      );
    }
  }

  async #publishInboundMessages(conversation: EmailConversation): Promise<void> {
    if (!conversation.discordThreadId) return;
    const target = await this.#fetchThread(conversation.discordThreadId);
    const providerMessageIds =
      await this.#conversationRepository.listInboundNeedingPublication(
        conversation.gmailThreadId,
      );
    for (const providerMessageId of providerMessageIds) {
      const email = await this.#emailProvider.getMessage(providerMessageId);
      const pages = paginateDiscordText(buildIncomingEmailText(email));
      for (const [page, content] of pages.entries()) {
        const sent = await target.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle(
                truncate(
                  `${pages.length > 1 ? `Incoming email ${page + 1}/${pages.length}: ` : "Incoming email: "}${email.subject || "(no subject)"}`,
                  180,
                ),
              )
              .setDescription(content)
              .setFooter({ text: `billy:incoming:${providerMessageId}:${page}` }),
          ],
          allowedMentions: { parse: [] },
        });
        const saved = await this.#conversationRepository.saveInboundPublication(
          providerMessageId,
          page,
          target.id,
          sent.id,
        );
        if (!saved) await sent.delete().catch(() => undefined);
      }
    }
  }

  async #fetchThread(threadId: string): Promise<ThreadChannel> {
    const channel = await this.#client.channels.fetch(threadId);
    if (!channel?.isThread()) {
      throw new Error(`Discord thread ${threadId} is unavailable`);
    }
    return channel;
  }

  async #fetchReviewChannel(channelId: string): Promise<ReviewChannel> {
    return this.#fetchThread(channelId);
  }

  async #publishPendingDrafts(): Promise<void> {
    if (this.#publishing) return;
    this.#publishing = true;

    try {
      const pendingDraftIds =
        await this.#approvalRepository.listUnpublishedAwaitingDraftIds(
          PUBLICATION_BATCH_SIZE,
        );
      if (pendingDraftIds.length === 0) return;

      for (const draftId of pendingDraftIds) {
        const draft = await this.#draftRepository.findById(draftId);
        if (!draft) continue;
        const conversation = await this.#conversationRepository.findByProviderMessageId(
          draft.providerMessageId,
        );
        if (!conversation?.discordThreadId) continue;
        const target = await this.#fetchThread(conversation.discordThreadId);
        const recentMessages = await target.messages.fetch({ limit: 100 });
        const footer = publicationFooter(draftId);
        const existingMessage = recentMessages.find(
          (message) =>
            message.author.id === this.#client.user?.id &&
            message.embeds.some((embed) => embed.footer?.text === footer),
        );

        if (existingMessage) {
          await this.#approvalRepository.savePublication(
            draftId,
            target.id,
            existingMessage.id,
          );
          continue;
        }

        try {
          await this.#publishDraft(draftId, target);
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
        const publicationChannel = await this.#fetchReviewChannel(
          publication.channelId,
        );
        const discordMessage = await publicationChannel.messages.fetch(
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

  async #publishDraft(draftId: number, channel: ReviewChannel): Promise<void> {
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
    const failures =
      await this.#approvalRepository.listGenerationFailuresNeedingPublication(
        PUBLICATION_BATCH_SIZE,
      );

    for (const failure of failures) {
      try {
        const conversation = await this.#conversationRepository.findByProviderMessageId(
          failure.providerMessageId,
        );
        if (!failure.publication && !conversation?.discordThreadId) continue;
        const target = failure.publication
          ? await this.#fetchReviewChannel(failure.publication.channelId)
          : await this.#fetchThread(conversation!.discordThreadId!);
        let messageId = failure.publication?.messageId;
        let discordMessage = messageId
          ? await target.messages.fetch(messageId).catch(() => undefined)
          : undefined;

        if (!discordMessage) {
          discordMessage = await target.send({
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
          target.id,
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
        const publicationChannel = await this.#fetchReviewChannel(
          item.publication.channelId,
        );
        const message = await publicationChannel.messages.fetch(
          item.publication.messageId,
        );
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
    const updates = await this.#approvalRepository.listDeliveryStatusUpdates(
      PUBLICATION_BATCH_SIZE,
    );

    for (const update of updates) {
      try {
        const publicationChannel = await this.#fetchReviewChannel(update.channelId);
        const message = await publicationChannel.messages.fetch(update.messageId);
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

  async #publishSchedulingSessions(): Promise<void> {
    const cards = await this.#schedulingRepository.listUnpublishedCards(
      PUBLICATION_BATCH_SIZE,
    );
    for (const card of cards) {
      const session = await this.#schedulingRepository.findById(card.sessionId);
      if (!session) continue;
      const conversation = await this.#conversationRepository.findByProviderMessageId(
        session.providerMessageId,
      );
      if (!conversation?.discordThreadId) continue;
      const target = await this.#fetchThread(conversation.discordThreadId);
      const sent = await target.send({
        embeds: [buildSchedulingCardEmbed(card)],
        components: buildSchedulingCardButtons(card, false),
        allowedMentions: { parse: [] },
      });
      if (!(await this.#schedulingRepository.saveCardPublication(card.id, sent.id))) {
        await sent.delete().catch(() => undefined);
      }
    }
  }

  async #publishCalendarEventProposals(): Promise<void> {
    const proposals = await this.#calendarEventRepository.listUnpublished(
      PUBLICATION_BATCH_SIZE,
    );
    for (const proposal of proposals) {
      const session = await this.#schedulingRepository.findById(proposal.sessionId);
      if (!session) continue;
      const conversation = await this.#conversationRepository.findByProviderMessageId(
        session.providerMessageId,
      );
      if (!conversation?.discordThreadId) continue;
      const target = await this.#fetchThread(conversation.discordThreadId);
      const sent = await target.send({
        embeds: [buildCalendarEventEmbed(proposal)],
        components: buildCalendarEventButtons(proposal, false),
        allowedMentions: { parse: [] },
      });
      if (!(await this.#calendarEventRepository.savePublication(proposal.sessionId, sent.id))) {
        await sent.delete().catch(() => undefined);
      }
    }
  }

  async #handleSchedulingMessage(message: Message): Promise<void> {
    if (message.author.bot || !message.channel.isThread()) return;
    const conversation = await this.#conversationRepository.findByDiscordThreadId(
      message.channelId,
    );
    if (!conversation) return;
    const session = await this.#schedulingRepository.findByGmailThreadId(
      conversation.gmailThreadId,
    );
    if (!session || session.status !== "awaiting_selection") return;
    if (!this.#approverUserIds.has(message.author.id)) {
      await message.reply({
        content: "You are not authorized to change this scheduling request.",
        allowedMentions: { repliedUser: false },
      });
      return;
    }
    const recorded = await this.#schedulingRepository.appendTurn(
      session.id,
      message.id,
      message.author.id,
      "user",
      message.content,
    );
    if (!recorded) return;
    await message.channel.sendTyping();
    const updated = await this.#schedulingWorkflow.updateFromConversation(
      session.id,
      message.content,
      message.createdAt,
    );
    if (!updated) {
      await message.reply({ content: "This scheduling request is no longer active." });
      return;
    }
    if (
      updated.request.reviewerWantsSelection === true &&
      updated.analysis.requestedSlotAvailable
    ) {
      const selected = await this.#schedulingWorkflow.selectCard(
        (await this.#schedulingRepository.findLatestCard(updated.id))?.id ?? -1,
        "requested",
        `message:${message.id}`,
      );
      if (selected.outcome === "drafted") {
        await this.#publishPendingDrafts();
        return;
      }
      if (selected.outcome === "conflict") {
        await this.#publishSchedulingSessions();
        return;
      }
    }
    await this.#publishSchedulingSessions();
  }

  async #handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;

    const allowedConversation = interaction.channelId
      ? await this.#conversationRepository.findByDiscordThreadId(
          interaction.channelId,
        )
      : null;
    if (!allowedConversation) {
      await interaction.reply({
        content: "This email action is only available inside one of Billy's email threads.",
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
    const calendarAction = parseCalendarEventButton(interaction.customId);
    if (calendarAction) {
      if (calendarAction.action === "edit") {
        const record = await this.#calendarEventRepository.findBySessionId(
          calendarAction.sessionId,
        );
        if (!record) {
          await interaction.reply({ content: "This calendar proposal is no longer available.", flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.showModal(buildCalendarEventEditModal(record));
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (calendarAction.action === "delete") {
        const deleted = await this.#calendarEventWorkflow.delete(
          calendarAction.sessionId,
          interaction.id,
        );
        const record = await this.#calendarEventRepository.findBySessionId(calendarAction.sessionId);
        if (record) {
          await interaction.message.edit({
            embeds: [buildCalendarEventEmbed(record)],
            components: [],
          });
        }
        await interaction.editReply(deleted ? "The Google Calendar event was deleted." : "This event could not be deleted or was already changed.");
        return;
      }
      if (calendarAction.action === "update") {
        const updated = await this.#calendarEventWorkflow.update(
          calendarAction.sessionId,
          interaction.id,
        );
        const record = await this.#calendarEventRepository.findBySessionId(calendarAction.sessionId);
        if (record) {
          await interaction.message.edit({
            embeds: [buildCalendarEventEmbed(record)],
            components: buildCalendarEventButtons(record, false),
          });
        }
        await interaction.editReply(updated ? "The Google Calendar event was updated." : "The update was blocked because the time is busy or the proposal changed.");
        return;
      }
      const outcome = await this.#calendarEventWorkflow.create(
        calendarAction.sessionId,
        interaction.id,
        calendarAction.action === "override",
      );
      if (outcome === "conflict") {
        const record = await this.#calendarEventRepository.findBySessionId(calendarAction.sessionId);
        if (record) {
          await interaction.message.edit({
            embeds: [buildCalendarEventEmbed(record)],
            components: buildCalendarEventButtons(record, false),
          });
        }
        await interaction.editReply("That time is now busy. Review the conflict, edit the event, or explicitly choose Create anyway.");
        return;
      }
      if (outcome === "unavailable") {
        await interaction.editReply("This calendar action was already handled.");
        return;
      }
      const created = await this.#calendarEventRepository.findBySessionId(calendarAction.sessionId);
      if (created) {
        await interaction.message.edit({
          embeds: [buildCalendarEventEmbed(created)],
          components: buildCalendarEventButtons(created, false),
        });
      }
      await interaction.editReply("The event was created on Billy's Google Calendar. No invitation was sent to the recruiter.");
      return;
    }

    const scheduling = parseSchedulingButton(interaction.customId);
    if (scheduling) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await this.#schedulingWorkflow.selectCard(
        scheduling.cardId,
        scheduling.selection,
        interaction.id,
      );
      if (result.outcome === "unavailable") {
        await interaction.editReply("This scheduling request was already resolved.");
        return;
      }
      if (result.outcome === "conflict") {
        await this.#publishSchedulingSessions();
        await interaction.editReply(
          "That slot is no longer free. I refreshed the choices using all configured calendars.",
        );
        return;
      }
      await this.#publishPendingDrafts();
      await interaction.editReply(
        "I generated a calendar-backed reply. Review and approve the new email draft before it is sent.",
      );
      return;
    }

    const parsed = parseButtonId(interaction.customId);
    if (!parsed) return;

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
      await this.#conversationRepository.setStatusByProviderMessageId(
        decision.providerMessageId,
        "rejected",
      );
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

    if (result.outcome === "schedule_conflict") {
      await this.#disablePublications(result.providerMessageId);
      await this.#publishSchedulingSessions();
      await interaction.editReply(
        "That calendar slot is no longer available, so Billy did not approve or send the draft. Return to its scheduling thread to choose another time.",
      );
      return;
    }

    await this.#disablePublications(result.decision.providerMessageId);
    await this.#conversationRepository.setStatusByProviderMessageId(
      result.decision.providerMessageId,
      "queued",
    );
    await interaction.editReply(
      `Revision ${await this.#revisionNumber(parsed.draftId)} was approved with ${replyModeLabel(parsed.mode)} and queued for Gmail.`,
    );
  }

  async #handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const calendarEdit = /^calendar:event:edit:(\d+)$/.exec(interaction.customId);
    if (calendarEdit?.[1]) {
      const sessionId = Number(calendarEdit[1]);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const saved = await this.#calendarEventWorkflow.edit(sessionId, {
        title: interaction.fields.getTextInputValue("title"),
        localStart: interaction.fields.getTextInputValue("start"),
        timeZone: interaction.fields.getTextInputValue("timezone"),
        durationMinutes: Number(interaction.fields.getTextInputValue("duration")),
        description: interaction.fields.getTextInputValue("description"),
      });
      if (!saved) {
        await interaction.editReply("This calendar proposal is no longer editable.");
        return;
      }
      await this.#publishCalendarEventProposals();
      await interaction.message?.edit({ components: [] }).catch(() => undefined);
      await interaction.editReply("The event proposal was updated and its time was checked against all configured calendars.");
      return;
    }

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

    if (result.outcome === "schedule_conflict") {
      await this.#disablePublications(result.providerMessageId);
      await this.#publishSchedulingSessions();
      await interaction.editReply(
        "That calendar slot is no longer available, so Billy did not approve the draft.",
      );
      return;
    }

    if (result.outcome !== "approved") {
      await interaction.editReply("This email was already resolved.");
      return;
    }

    await this.#disablePublications(result.decision.providerMessageId);
    await this.#conversationRepository.setStatusByProviderMessageId(
      result.decision.providerMessageId,
      "queued",
    );
    await interaction.editReply(
      `Revision ${await this.#revisionNumber(draftId)} was approved with confirmed recipients and queued for Gmail.`,
    );
  }

  async #disablePublications(providerMessageId: string): Promise<void> {
    const publications =
      await this.#approvalRepository.listPublicationsByProviderMessageId(
        providerMessageId,
      );

    await Promise.allSettled(
      publications.map(async (publication) => {
        const publicationChannel = await this.#fetchReviewChannel(
          publication.channelId,
        );
        const message = await publicationChannel.messages.fetch(publication.messageId);
        await message.edit({
          components: buildApprovalButtons(publication.draftId, false, true),
        });
      }),
    );
  }

  async #revisionNumber(draftId: number): Promise<number> {
    return (await this.#draftRepository.findById(draftId))?.revision ?? 0;
  }
}

function parseSchedulingButton(customId: string): {
  cardId: number;
  selection: "requested" | "multiple" | "clarify_timezone" | number;
} | null {
  const card = /^schedule-card:(requested|multiple|clarify|option):(\d+)(?::(\d+))?$/.exec(
    customId,
  );
  if (card?.[1] && card[2]) {
    const cardId = Number(card[2]);
    if (card[1] === "requested") {
      return { cardId, selection: "requested" };
    }
    if (card[1] === "clarify") {
      return { cardId, selection: "clarify_timezone" };
    }
    if (card[1] === "multiple") {
      return { cardId, selection: "multiple" };
    }
    if (card[3]) {
      return { cardId, selection: Number(card[3]) };
    }
  }
  return null;
}

function buildSchedulingCardButtons(
  card: SchedulingAvailabilityCard,
  disabled: boolean,
): readonly ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];
  if (card.analysis.timezoneRequired) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`schedule-card:clarify:${card.id}`)
      .setLabel("Ask for timezone")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled));
  } else if (card.analysis.requestedSlotAvailable) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`schedule-card:requested:${card.id}`)
      .setLabel("Requested time works")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled));
  }
  const requestedOptionCount = card.request.availabilityOptionCount ?? 1;
  if (requestedOptionCount > 1 && card.analysis.options.length > 1) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`schedule-card:multiple:${card.id}`)
      .setLabel(`Offer these ${Math.min(requestedOptionCount, card.analysis.options.length)} times`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled));
  }
  card.analysis.options.slice(0, 5).forEach((slot, index) => {
    buttons.push(new ButtonBuilder()
      .setCustomId(`schedule-card:option:${card.id}:${index}`)
      .setLabel(truncate(slot.label, 80))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled));
  });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...buttons.slice(index, index + 5),
      ),
    );
  }
  return rows;
}

function buildSchedulingCardEmbed(card: SchedulingAvailabilityCard): EmbedBuilder {
  return buildSchedulingEmbed(card).setFooter({
    text: `billy:scheduling-card:${card.id} · version ${card.version} · checked ${card.analysis.checkedAt}`,
  });
}

function buildConversationEmbed(conversation: EmailConversation): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(conversationStatusColor(conversation.status))
    .setTitle(truncate(conversation.subject || "(no subject)", 180))
    .setDescription(truncate(conversation.summary, 1_000))
    .addFields({
      name: "Status",
      value: conversationStatusLabel(conversation.status),
      inline: true,
    });
}

function parseCalendarEventButton(customId: string): {
  action: "create" | "override" | "edit" | "update" | "delete";
  sessionId: number;
} | null {
  const match = /^calendar:event:(create|override|edit|update|delete):(\d+)$/.exec(customId);
  return match?.[1] && match[2]
    ? { action: match[1] as "create" | "override" | "edit" | "update" | "delete", sessionId: Number(match[2]) }
    : null;
}

function buildCalendarEventEmbed(record: CalendarEventRecord): EmbedBuilder {
  const start = DateTime.fromISO(record.event.start, { setZone: true })
    .setZone(record.event.timeZone);
  const end = DateTime.fromISO(record.event.end, { setZone: true })
    .setZone(record.event.timeZone);
  const status = record.status === "conflicted"
    ? "This time conflicts with a configured calendar. Normal creation is blocked."
    : record.status === "created"
      ? "Created on Billy's calendar. No recruiter invitation was sent."
      : record.status === "update_proposed"
        ? "Review and approve these changes before Billy updates Google Calendar."
      : record.status === "cancel_proposed"
        ? "The recruiter cancelled. Approve deletion of the existing Google Calendar event."
      : record.status === "cancelled"
        ? "Deleted from Billy's Google Calendar."
      : "The recruiter confirmed the time. Approve creation on Billy's calendar.";
  return new EmbedBuilder()
    .setColor(record.status === "conflicted" ? 0xed4245 : record.status === "created" ? 0x57f287 : 0x5865f2)
    .setTitle(truncate(`Calendar event: ${record.event.title}`, 180))
    .setDescription(status)
    .addFields(
      { name: "When", value: `${start.toFormat("ccc, LLL d 'at' h:mm a")}–${end.toFormat("h:mm a ZZZZ")}` },
      { name: "Description", value: truncate(record.event.description || "None", 500) },
      { name: "Calendar", value: "Billy (no attendees / no Google invitation)" },
    )
    .setFooter({ text: `billy:calendar-event:${record.sessionId}` });
}

function buildCalendarEventButtons(
  record: CalendarEventRecord,
  disabled: boolean,
): readonly ActionRowBuilder<ButtonBuilder>[] {
  if (record.status === "cancelled") return [];
  if (record.status === "cancel_proposed") {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`calendar:event:delete:${record.sessionId}`)
        .setLabel("Delete event")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    )];
  }
  if (record.status === "created") {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`calendar:event:edit:${record.sessionId}`)
        .setLabel("Edit event")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`calendar:event:delete:${record.sessionId}`)
        .setLabel("Delete event")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    )];
  }
  if (record.status === "update_proposed") {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`calendar:event:update:${record.sessionId}`)
        .setLabel("Apply update")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`calendar:event:edit:${record.sessionId}`)
        .setLabel("Edit details")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    )];
  }
  const create = new ButtonBuilder()
    .setCustomId(`calendar:event:create:${record.sessionId}`)
    .setLabel("Create event")
    .setStyle(ButtonStyle.Success)
    .setDisabled(disabled || record.status === "conflicted");
  const edit = new ButtonBuilder()
    .setCustomId(`calendar:event:edit:${record.sessionId}`)
    .setLabel("Edit details")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);
  const buttons = [create, edit];
  if (record.status === "conflicted") {
    buttons.push(new ButtonBuilder()
      .setCustomId(`calendar:event:override:${record.sessionId}`)
      .setLabel("Create anyway")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled));
  }
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

function buildCalendarEventEditModal(record: CalendarEventRecord): ModalBuilder {
  const start = DateTime.fromISO(record.event.start, { setZone: true })
    .setZone(record.event.timeZone);
  const end = DateTime.fromISO(record.event.end, { setZone: true })
    .setZone(record.event.timeZone);
  const duration = Math.round(end.diff(start, "minutes").minutes);
  return new ModalBuilder()
    .setCustomId(`calendar:event:edit:${record.sessionId}`)
    .setTitle("Edit calendar event")
    .addComponents(
      modalText("title", "Title", record.event.title, TextInputStyle.Short, 200),
      modalText("start", "Start (YYYY-MM-DDTHH:mm)", start.toFormat("yyyy-MM-dd'T'HH:mm"), TextInputStyle.Short, 40),
      modalText("timezone", "IANA timezone", record.event.timeZone, TextInputStyle.Short, 100),
      modalText("duration", "Duration in minutes", String(duration), TextInputStyle.Short, 3),
      modalText("description", "Description", record.event.description, TextInputStyle.Paragraph, 1_000),
    );
}

function modalText(
  id: string,
  label: string,
  value: string,
  style: TextInputStyle,
  maxLength: number,
): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(style)
      .setValue(value.slice(0, maxLength))
      .setRequired(id !== "description")
      .setMaxLength(maxLength),
  );
}

function buildOpenThreadButton(
  url: string,
): readonly ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("Open thread")
        .setStyle(ButtonStyle.Link)
        .setURL(url),
    ),
  ];
}

function conversationStatusLabel(status: EmailConversation["status"]): string {
  const labels: Record<EmailConversation["status"], string> = {
    processing: "Processing",
    needs_review: "Needs review",
    scheduling_needed: "Choose a time",
    draft_awaiting_approval: "Draft awaiting approval",
    queued: "Queued for Gmail",
    sending: "Sending",
    sent: "Sent",
    awaiting_recruiter_confirmation: "Awaiting recruiter confirmation",
    recruiter_confirmed: "Recruiter confirmed",
    calendar_event_awaiting_approval: "Calendar event awaiting approval",
    scheduled: "Scheduled",
    rejected: "No reply",
    cancelled: "Cancelled",
    failed: "Action failed",
  };
  return labels[status];
}

function conversationStatusColor(status: EmailConversation["status"]): number {
  if (status === "scheduled" || status === "sent" || status === "recruiter_confirmed") {
    return 0x57f287;
  }
  if (status === "failed" || status === "cancelled" || status === "rejected") {
    return 0xed4245;
  }
  if (status === "processing" || status === "sending") return 0x5865f2;
  return 0xfee75c;
}

function buildIncomingEmailText(message: {
  from: string;
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  receivedAt: Date;
  textBody: string;
  attachments?: readonly { filename: string; mimeType: string; size: number }[];
}): string {
  return [
    `From: ${message.from || "Unknown"}`,
    `To: ${message.to.join(", ") || "Unknown"}`,
    ...(message.cc.length > 0 ? [`Cc: ${message.cc.join(", ")}`] : []),
    `Subject: ${message.subject || "(no subject)"}`,
    `Received: ${message.receivedAt.toISOString()}`,
    ...(message.attachments?.length
      ? [
          `Attachments: ${message.attachments.map((item) => `${item.filename} (${item.mimeType}, ${item.size} bytes)`).join(", ")}`,
        ]
      : []),
    "",
    message.textBody || "(empty message)",
  ].join("\n");
}

function buildSchedulingEmbed(
  session: Pick<SchedulingAvailabilityCard, "request" | "analysis">,
): EmbedBuilder {
  const analysis = session.analysis;
  const requested = analysis.timezoneRequired
    ? "The sender gave a time without a timezone. Billy will not assume one."
    : analysis.requestedSlot
      ? `${analysis.requestedSlot.label} — ${analysis.requestedSlotAvailable ? "available" : "conflicts with a calendar"}`
      : "No exact time was proposed.";
  const options = analysis.options.length > 0
    ? analysis.options
        .map((slot, index) => `${index + 1}. ${slot.label}`)
        .join("\n")
    : "No open slots found in the next 10 business days.";
  const advisories = analysis.advisories.length > 0
    ? analysis.advisories
        .map((item) => `${item.date}: ${item.titles.join(", ")}`)
        .join("\n")
    : "None";
  return new EmbedBuilder()
    .setColor(analysis.requestedSlotAvailable ? 0x57f287 : 0xfee75c)
    .setTitle(
      truncate(
        `Scheduling: ${session.request.summary || "professional meeting"}`,
        180,
      ),
    )
    .addFields(
      { name: "Requested", value: truncate(requested, 500) },
      { name: "Best available choices", value: truncate(options, 900) },
      { name: "All-day reminders", value: truncate(advisories, 500) },
      {
        name: "Duration",
        value: `${session.request.durationMinutes} minutes + 15-minute buffer`,
      },
    );
}

type ParsedButton =
  | { action: "approve"; mode: ReplyMode; draftId: number }
  | { action: "approve-manual"; mode: ReplyMode; draftId: number }
  | { action: "revise"; draftId: number }
  | { action: "cancel"; draftId: number }
  | { action: "retry-generation"; providerMessageId: string };

function parseButtonId(customId: string): ParsedButton | null {
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
    ),
  ];
}

export function paginateDiscordText(
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
