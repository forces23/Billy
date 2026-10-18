import type Database from "better-sqlite3";

import { env } from "./config/env.js";
import logger from "./config/logger.js";
import { ApprovalWorkflow } from "./core/approval-workflow.js";
import { CareerProfileLoader } from "./core/career-profile-loader.js";
import { EmailProcessor } from "./core/email-processor.js";
import { AvailabilityService } from "./core/availability-service.js";
import { SchedulingWorkflow } from "./core/scheduling-workflow.js";
import { RecipientResolver } from "./core/recipient-resolver.js";
import { createDatabase } from "./database/connection.js";
import { SqliteApprovalRepository } from "./database/repositories/approval-repository.js";
import { SqliteDraftRepository } from "./database/repositories/draft-repository.js";
import { SqliteConversationRepository } from "./database/repositories/conversation-repository.js";
import { SqliteCalendarEventRepository } from "./database/repositories/calendar-event-repository.js";
import { SqliteEmailRepository } from "./database/repositories/email-repository.js";
import { SqlitePollCheckpointRepository } from "./database/repositories/poll-checkpoint-repository.js";
import { SqliteSchedulingRepository } from "./database/repositories/scheduling-repository.js";
import { createDiscordClient } from "./integrations/discord/client.js";
import { DiscordEmailApprovalService } from "./integrations/discord/email-approval-service.js";
import { createGmailClient } from "./integrations/gmail/client.js";
import { GmailEmailProvider } from "./integrations/gmail/gmail-provider.js";
import { GoogleCalendarProvider } from "./integrations/google/calendar-provider.js";
import { OpenRouterAiProvider } from "./integrations/openrouter/openrouter-provider.js";
import { OpenRouterEmailClassifier } from "./integrations/openrouter/email-classifier.js";
import { OpenRouterSchedulingInterpreter } from "./integrations/openrouter/scheduling-interpreter.js";
import { OpenRouterSchedulingReplyInterpreter } from "./integrations/openrouter/scheduling-reply-interpreter.js";
import { CalendarEventWorkflow } from "./core/calendar-event-workflow.js";
import { GmailPoller } from "./jobs/gmail-poller.js";
import { EmailSender } from "./jobs/email-sender.js";

async function main(): Promise<void> {
    logger.info("Billy is starting");

    const database = createDatabase(env.database.path);
    const abortController = new AbortController();
    const removeShutdownHandlers = installShutdownHandlers(abortController);

    logger.info({ databasePath: database.name }, "SQLite database is ready");

    try {
        const gmailClient = createGmailClient(env.google);
        const emailProvider = new GmailEmailProvider(gmailClient, {
            userId: env.google.userId,
            senderAddress: env.gmail.ownAddresses[0]!,
        });
        const emailRepository = new SqliteEmailRepository(database);
        const recoveredEmailCount =
            await emailRepository.releaseInterruptedDrafting();

        if (recoveredEmailCount > 0) {
            logger.warn(
                { recoveredEmailCount },
                "Released interrupted email drafting work",
            );
        }

        const draftRepository = new SqliteDraftRepository(database);
        const approvalRepository = new SqliteApprovalRepository(database);
        const checkpointRepository = new SqlitePollCheckpointRepository(database);
        const recipientResolver = new RecipientResolver({
            ownAddresses: env.gmail.ownAddresses,
            trustedForwarderAddresses: env.gmail.trustedForwarderAddresses,
        });
        const schedulingRepository = new SqliteSchedulingRepository(database);
        const conversationRepository = new SqliteConversationRepository(database);
        const calendarEventRepository = new SqliteCalendarEventRepository(database);
        const aiProvider = new OpenRouterAiProvider(logger, {
            apiKey: env.openRouter.apiKey,
            model: env.openRouter.model,
            timeoutMilliseconds: env.openRouter.timeoutMilliseconds,
            maxOutputTokens: env.openRouter.maxOutputTokens,
            reasoningEffort: env.openRouter.draftReasoningEffort,
        });
        const emailClassifier = new OpenRouterEmailClassifier(logger, {
            apiKey: env.openRouter.apiKey,
            model: env.openRouter.classifierModel,
            timeoutMilliseconds: env.openRouter.timeoutMilliseconds,
            maxOutputTokens: env.openRouter.classifierMaxOutputTokens,
            reasoningEffort: env.openRouter.classifierReasoningEffort,
        });
        const careerContextProvider = new CareerProfileLoader(
            env.profile.careerPath,
        );
        const calendarProvider = new GoogleCalendarProvider(
            env.google,
            env.calendar.calendars,
            env.calendar.billyCalendarId,
        );
        const availabilityService = new AvailabilityService(
            calendarProvider,
            env.calendar,
        );
        const schedulingInterpreter = new OpenRouterSchedulingInterpreter(
            logger,
            {
                apiKey: env.openRouter.apiKey,
                model: env.openRouter.classifierModel,
                timeoutMilliseconds: env.openRouter.timeoutMilliseconds,
                maxOutputTokens: env.openRouter.schedulingMaxOutputTokens,
                reasoningEffort: env.openRouter.classifierReasoningEffort,
            },
        );
        const schedulingReplyInterpreter = new OpenRouterSchedulingReplyInterpreter(
            logger,
            {
                apiKey: env.openRouter.apiKey,
                model: env.openRouter.classifierModel,
                timeoutMilliseconds: env.openRouter.timeoutMilliseconds,
                maxOutputTokens: env.openRouter.schedulingMaxOutputTokens,
                reasoningEffort: env.openRouter.classifierReasoningEffort,
            },
        );
        const schedulingWorkflow = new SchedulingWorkflow(
            schedulingInterpreter,
            availabilityService,
            schedulingRepository,
            emailProvider,
            draftRepository,
            aiProvider,
            recipientResolver,
            logger,
            env.calendar.timeZone,
            {
                replyInterpreter: schedulingReplyInterpreter,
                conversationRepository,
                calendarEventRepository,
                emailRepository,
            },
        );
        const calendarEventWorkflow = new CalendarEventWorkflow(
            calendarEventRepository,
            calendarProvider,
            availabilityService,
            schedulingRepository,
            conversationRepository,
        );
        const emailProcessor = new EmailProcessor(
            emailProvider,
            emailRepository,
            draftRepository,
            aiProvider,
            logger,
            {
                recipientResolver,
                classifier: emailClassifier,
                careerContextProvider,
                schedulingWorkflow,
                conversationRepository,
            },
        );
        const approvalWorkflow = new ApprovalWorkflow(
            emailProvider,
            draftRepository,
            approvalRepository,
            aiProvider,
            recipientResolver,
            logger,
            {
                emailRepository,
                careerContextProvider,
                schedulingGuard: schedulingWorkflow,
            },
        );
        const discordService = new DiscordEmailApprovalService(
            createDiscordClient(),
            emailProvider,
            emailRepository,
            draftRepository,
            approvalRepository,
            approvalWorkflow,
            emailProcessor,
            recipientResolver,
            schedulingRepository,
            schedulingWorkflow,
            conversationRepository,
            calendarEventRepository,
            calendarEventWorkflow,
            logger,
            {
                botToken: env.discord.botToken,
                emailChannelId: env.discord.emailChannelId,
                approverUserIds: env.discord.approverUserIds,
            },
        );
        const poller = new GmailPoller(
            emailProvider,
            emailRepository,
            checkpointRepository,
            emailProcessor,
            logger,
            {
                intervalMilliseconds:
                    env.gmail.pollIntervalSeconds * 1_000,
            },
        );
        const emailSender = new EmailSender(
            emailProvider,
            emailRepository,
            draftRepository,
            approvalRepository,
            recipientResolver,
            logger,
            {
                intervalMilliseconds:
                    env.gmail.sendIntervalSeconds * 1_000,
                schedulingGuard: schedulingWorkflow,
                conversationRepository,
            },
        );

        const pollerRun = poller.run(abortController.signal);
        const discordRun = discordService.run(abortController.signal);
        const emailSenderRun = emailSender.run(abortController.signal);

        try {
            await Promise.all([pollerRun, discordRun, emailSenderRun]);
        } catch (error: unknown) {
            abortController.abort();
            await Promise.allSettled([
                pollerRun,
                discordRun,
                emailSenderRun,
            ]);
            throw error;
        }
    } finally {
        removeShutdownHandlers();
        closeDatabase(database, "application shutdown");
    }
}

void main().catch((error: unknown) => {
    logger.error({ err: error }, "Billy failed during startup");
    process.exitCode = 1;
});

function installShutdownHandlers(
    abortController: AbortController,
): () => void {
    const handleSignal = (signal: NodeJS.Signals): void => {
        logger.info({ signal }, "Shutdown signal received");
        abortController.abort();
    };

    const handleSigint = (): void => handleSignal("SIGINT");
    const handleSigterm = (): void => handleSignal("SIGTERM");

    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);

    return () => {
        process.off("SIGINT", handleSigint);
        process.off("SIGTERM", handleSigterm);
    };
}

function closeDatabase(database: Database.Database, reason: string): void {
    if (!database.open) {
        return;
    }

    database.close();
    logger.info({ reason }, "SQLite database connection closed");
}
