import type { Logger } from "pino";

import type { EmailProcessor } from "../core/email-processor.js";
import type { EmailProvider } from "../interfaces/email-provider.js";
import type { EmailRepository } from "../interfaces/email-repository.js";
import type { PollCheckpointRepository } from "../interfaces/poll-checkpoint-repository.js";

const CHECKPOINT_NAME = "gmail-inbox";

export interface GmailPollerOptions {
  intervalMilliseconds: number;
  now?: () => Date;
}

export class GmailPoller {
  readonly #emailProvider: EmailProvider;
  readonly #emailRepository: EmailRepository;
  readonly #checkpointRepository: PollCheckpointRepository;
  readonly #emailProcessor: EmailProcessor;
  readonly #logger: Logger;
  readonly #intervalMilliseconds: number;
  readonly #now: () => Date;

  constructor(
    emailProvider: EmailProvider,
    emailRepository: EmailRepository,
    checkpointRepository: PollCheckpointRepository,
    emailProcessor: EmailProcessor,
    logger: Logger,
    options: GmailPollerOptions,
  ) {
    const pollerLogger = logger.child({ component: "gmail-poller" });

    if (
      !Number.isInteger(options.intervalMilliseconds) ||
      options.intervalMilliseconds < 1
    ) {
      throw new Error("Gmail poll interval must be a positive integer");
    }

    this.#emailProvider = emailProvider;
    this.#emailRepository = emailRepository;
    this.#checkpointRepository = checkpointRepository;
    this.#emailProcessor = emailProcessor;
    this.#logger = pollerLogger;
    this.#intervalMilliseconds = options.intervalMilliseconds;
    this.#now = options.now ?? (() => new Date());
  }

  async run(signal: AbortSignal): Promise<void> {
    this.#logger.info(
      { intervalMilliseconds: this.#intervalMilliseconds },
      "Gmail poller started",
    );

    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        this.#logger.error({ err: error }, "Gmail polling cycle failed");
      }

      if (!signal.aborted) {
        try {
          await this.#emailProcessor.processPending(signal);
        } catch (error: unknown) {
          this.#logger.error(
            { err: error },
            "Pending email processing cycle failed",
          );
        }
      }

      await waitForNextPoll(this.#intervalMilliseconds, signal);
    }

    this.#logger.info("Gmail poller stopped");
  }

  async runOnce(): Promise<void> {
    const pollStartedAt = this.#now();
    const previousCheckpoint = await this.#checkpointRepository.get(
      CHECKPOINT_NAME,
    );

    if (!previousCheckpoint) {
      await this.#checkpointRepository.save(CHECKPOINT_NAME, pollStartedAt);
      this.#logger.info(
        { checkpoint: pollStartedAt.toISOString() },
        "Initialized Gmail checkpoint; existing messages will not be processed",
      );
      return;
    }

    const candidateIds = await this.#emailProvider.listCandidateMessageIds({
      receivedAfter: previousCheckpoint,
    });

    let discoveredCount = 0;
    let duplicateCount = 0;

    for (const candidateId of candidateIds) {
      const message = await this.#emailProvider.getMessage(candidateId);
      const registered = await this.#emailRepository.register(message);

      if (registered) {
        discoveredCount += 1;
        this.#logger.info(
          {
            providerMessageId: message.providerMessageId,
            subject: message.subject,
            receivedAt: message.receivedAt.toISOString(),
          },
          "Discovered a new Gmail message",
        );
      } else {
        duplicateCount += 1;
      }
    }

    await this.#checkpointRepository.save(CHECKPOINT_NAME, pollStartedAt);

    this.#logger.info(
      {
        candidateCount: candidateIds.length,
        discoveredCount,
        duplicateCount,
        checkpoint: pollStartedAt.toISOString(),
      },
      "Gmail polling cycle completed",
    );
  }
}

function waitForNextPoll(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

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
