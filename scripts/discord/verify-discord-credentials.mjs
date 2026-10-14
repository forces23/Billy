import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";

function requireEnvironmentVariable(name) {
    const value = process.env[name]?.trim();

    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
}

const token = requireEnvironmentVariable("DISCORD_BOT_TOKEN");
const emailChannelId = requireEnvironmentVariable("DISCORD_EMAIL_CHANNEL_ID");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function main() {
    const readyClient = await new Promise((resolve, reject) => {
        client.once(Events.ClientReady, resolve);
        client.once(Events.Error, reject);
        void client.login(token).catch(reject);
    });

    try {
        const channels = [];

        for (const [name, channelId] of [
            ["email", emailChannelId],
        ]) {
            const channel = await readyClient.channels.fetch(channelId);

            if (!channel?.isTextBased() || !("send" in channel)) {
                throw new Error(
                    `The configured ${name} channel is not a sendable text channel`,
                );
            }

            const testMessage = await channel.send({
                embeds: [
                    {
                        title: `Billy ${name} channel test`,
                        description: "Discord credentials and channel permissions are working.",
                        color: 0x57f287,
                    },
                ],
            });

            channels.push({
                name,
                channelId: channel.id,
                messageCreated: true,
            });

            await new Promise((resolve) => setTimeout(resolve, 10_000));
            await testMessage.delete();
        }

        console.log({ bot: readyClient.user.tag, channels });
    } finally {
        client.destroy();
    }
}

void main().catch((error) => {
    console.error(error);
    client.destroy();
    process.exitCode = 1;
});
