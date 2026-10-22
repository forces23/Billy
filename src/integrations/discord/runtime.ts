import type { Logger } from "pino";
import { Client, Events } from "discord.js";
import type { Interaction, Message } from "discord.js";

export interface DiscordFeature {
  name: string;
  initialize?(): Promise<void>;
  run?(signal: AbortSignal): Promise<void>;
  handleMessage?(message: Message, signal?: AbortSignal): Promise<void>;
  handleInteraction?(
    interaction: Interaction,
    signal?: AbortSignal,
  ): Promise<void>;
}

export class DiscordRuntime {
  readonly #client: Client;
  readonly #botToken: string;
  readonly #features: readonly DiscordFeature[];
  readonly #logger: Logger;

  constructor(
    client: Client,
    botToken: string,
    features: readonly DiscordFeature[],
    logger: Logger,
  ) {
    if (!botToken.trim()) throw new Error("A Discord bot token is required");
    if (features.length < 1) throw new Error("At least one Discord feature is required");

    this.#client = client;
    this.#botToken = botToken;
    this.#features = features;
    this.#logger = logger.child({ component: "discord-runtime" });
  }

  async run(signal: AbortSignal): Promise<void> {
    const inFlight = new Set<Promise<void>>();
    const handleInteraction = (interaction: Interaction): void => {
      for (const feature of this.#features) {
        if (!feature.handleInteraction) continue;
        const task = Promise.resolve()
          .then(() => feature.handleInteraction?.(interaction, signal))
          .catch((error: unknown) => {
            this.#logger.error(
              { err: error, feature: feature.name, interactionId: interaction.id },
              "Discord feature interaction handler failed",
            );
          })
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    };
    const handleMessage = (message: Message): void => {
      for (const feature of this.#features) {
        if (!feature.handleMessage) continue;
        const task = Promise.resolve()
          .then(() => feature.handleMessage?.(message, signal))
          .catch((error: unknown) => {
            this.#logger.error(
              { err: error, feature: feature.name, discordMessageId: message.id },
              "Discord feature message handler failed",
            );
          })
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    };
    const handleClientError = (error: Error): void => {
      this.#logger.error({ err: error }, "Discord client error");
    };

    this.#client.on(Events.Error, handleClientError);

    try {
      const ready = new Promise<void>((resolve) => {
        this.#client.once(Events.ClientReady, () => resolve());
      });
      await this.#client.login(this.#botToken);
      await ready;
      await Promise.all(
        this.#features.map((feature) => feature.initialize?.()),
      );
      this.#client.on(Events.InteractionCreate, handleInteraction);
      this.#client.on(Events.MessageCreate, handleMessage);

      this.#logger.info(
        {
          botUserId: this.#client.user?.id,
          features: this.#features.map((feature) => feature.name),
        },
        "Discord runtime started",
      );

      await Promise.all(
        this.#features.map((feature) =>
          feature.run ? feature.run(signal) : waitForAbort(signal),
        ),
      );
    } finally {
      this.#client.off(Events.InteractionCreate, handleInteraction);
      this.#client.off(Events.MessageCreate, handleMessage);
      this.#client.off(Events.Error, handleClientError);
      await Promise.allSettled(inFlight);
      this.#client.destroy();
      this.#logger.info("Discord runtime stopped");
    }
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
