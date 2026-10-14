import type Database from "better-sqlite3";

import { env } from "./config/env.js";
import logger from "./config/logger.js";
import { ApprovalWorkflow } from "./core/approval-workflow.js";
import { CareerProfileLoader } from "./core/career-profile-loader.js";
import { EmailProcessor } from "./core/email-processor.js";
import { RecipientResolver } from "./core/recipient-resolver.js";
import { createDatabase } from "./database/connection.js";
import { SqliteApprovalRepository } from "./database/repositories/approval-repository.js";
import { SqliteDraftRepository } from "./database/repositories/draft-repository.js";
import { SqliteEmailRepository } from "./database/repositories/email-repository.js";
import { SqlitePollCheckpointRepository } from "./database/repositories/poll-checkpoint-repository.js";
import { createDiscordClient } from "./integrations/discord/client.js";
import { DiscordEmailApprovalService } from "./integrations/discord/email-approval-service.js";
import { createGmailClient } from "./integrations/gmail/client.js";
import { GmailEmailProvider } from "./integrations/gmail/gmail-provider.js";
import { OpenRouterAiProvider } from "./integrations/openrouter/openrouter-provider.js";
import { OpenRouterEmailClassifier } from "./integrations/openrouter/email-classifier.js";
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
            },
        );
        const approvalWorkflow = new ApprovalWorkflow(
            emailProvider,
            draftRepository,
            approvalRepository,
            aiProvider,
            recipientResolver,
            logger,
            { emailRepository, careerContextProvider },
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
