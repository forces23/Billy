# Discord bot setup guide

This guide creates the Discord bot and private email channel Billy uses for generated email drafts and approval decisions.

It is written for Billy's first phase: one local Node.js process, one private Discord server, and a small list of explicitly authorized reviewers. Billy connects directly to Discord through `discord.js`; it does not use an MCP server.

Last checked against Discord's developer portal and documentation: October 12, 2026.

## What you will create

By the end of the guide, you will have:

- A Discord application named `Billy Personal Assistant`
- A bot account attached to the application
- A private server and email channel
- A bot token stored in `.env`
- The email channel ID stored in `.env`
- One or more authorized reviewer user IDs stored in `.env`
- A successful connection and message test

The Discord bot will eventually post each generated draft with buttons tied to that exact draft ID and revision. Approving revision 1 will still select revision 1 even if Billy later generates revision 2.

## Before you start

You need:

- A Discord account
- Permission to create a Discord server, or permission to add applications to an existing server
- Node.js and npm installed
- This repository installed with `npm install`
- Billy's `.env` file created from `.env.example`

Keep the bot token private. It gives software control of the bot account. Do not paste it into chat, include it in a screenshot, or commit it to source control.

Billy must never use your personal Discord account token. Automating a normal user account is a self-bot and violates Discord's rules. The token created below belongs only to the bot account.

## 1. Create a private Discord server

You can use an existing private server if you control its members and permissions. Otherwise, create a dedicated server:

1. Open the Discord desktop application or [Discord in your browser](https://discord.com/app).
2. In the server list on the left, click the **+** button.
3. Click **Create My Own**.
4. Choose **For me and my friends**.
5. Enter a name such as `Billy Personal Assistant`.
6. Click **Create**.

Email subjects, senders, and generated replies may appear in this server. Only invite people who are allowed to see that information.

## 2. Create the email channel

1. Open the Billy server.
2. Next to **Text Channels**, click the **+** button.
3. Select **Text** as the channel type.
4. Enter `billy-emails` as the channel name.
5. Enable **Private Channel**.
6. Add your own Discord account and anyone allowed to review private email content.
7. Click **Create Channel**.

If Discord does not offer the private-channel switch, configure the channel after creating it:

1. Right-click the channel.
2. Select **Edit Channel**.
3. Open **Permissions**.
4. Select the `@everyone` role.
5. Deny **View Channel**.
6. Add each reviewer or reviewer role and allow **View Channel**.
7. Save the changes.

The bot will be added to the channel permissions after it is installed.

`DISCORD_MAIN_CHANNEL_ID` is optional and unused during the email-only phase. You can create a general `#billy` channel later without changing the email workflow.

## 3. Create the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Sign in with the Discord account that owns or manages the Billy server.
3. Click **New Application** in the upper-right corner.
4. Enter `Billy Personal Assistant`.
5. Accept Discord's developer terms if prompted.
6. Click **Create**.

The application page opens after creation.

On **General Information**, you can optionally add:

- An application icon
- A short description such as `Private approval bot for generated email replies`

The **Application ID** shown on this page identifies the application. Billy does not currently need it in `.env`, but it may be useful later when registering slash commands.

## 4. Create and configure the bot account

1. In the application's left navigation, click **Bot**.
2. If the page shows **Add Bot**, click it and confirm. Newer applications may already have a bot.
3. Set the bot username to `Billy` if desired.
4. Before making the bot private, open **Installation** in the left navigation.
5. Under **Install Link**, select **None**, then click **Save Changes**.
6. Return to the **Bot** page.
7. Find **Public Bot** and turn it off.
8. Leave **Requires OAuth2 Code Grant** turned off.
9. Scroll to **Privileged Gateway Intents**.
10. Leave these intents turned off:

- Presence Intent
- Server Members Intent
- Message Content Intent

Billy only needs the standard `Guilds` gateway intent. Button clicks arrive as Discord interactions, so the bot does not need permission to read ordinary chat messages.

Turning off **Public Bot** means only the application owner or a member of its developer team can add the bot to a server. This is appropriate for Billy's private installation.

Discord does not allow a private application to have a default authorization link. If **Install Link** is still set to **Discord Provided Link**, saving the private bot setting produces this validation error:

```text
Private application cannot have a default authorization link.
```

Keep the default Install Link set to **None**. You will create a private installation URL manually in section 6. Discord documents this requirement in its [developer support guidance for private bots](https://support-dev.discord.com/hc/en-us/articles/21204493235991-How-Can-Users-Discover-and-Play-My-Activity#h_01HQ1Y4ZJ8ZGS62ER6S3SJ5YAR).

## 5. Generate and save the bot token

Still on the **Bot** page:

1. Find the **Token** section.
2. Click **Reset Token**.
3. Confirm the action and complete two-factor authentication if Discord asks.
4. Click **Copy** immediately after Discord displays the token.
5. Open Billy's local `.env` file.
6. Replace the example value:

```dotenv
DISCORD_BOT_TOKEN=your-actual-bot-token
```

Do not include angle brackets around the real token. The angle brackets in `.env.example` only mark example values.

Discord may show a token only once. If you lose it, reset it and update `.env`. Resetting the token immediately invalidates the old one.

## 6. Configure private application installation

1. In the developer portal's left navigation, click **Installation**.
2. Under **Installation Contexts**, enable **Guild Install**.
3. Disable **User Install** if Discord allows it; Billy is installed into a server, not into an individual user's account.
4. Confirm **Install Link** is set to **None**.
5. Click **Save Changes**.
6. In the left navigation, open **OAuth2** > **URL Generator**.
7. Under **Scopes**, select:
   - `bot`
   - `applications.commands`
8. Under **Bot Permissions**, select only:
   - **View Channels** under General Permissions
   - **Send Messages** under Text Permissions
   - **Embed Links** under Text Permissions
   - **Read Message History** under Text Permissions
9. Confirm the generated permissions integer is `84992`.
10. Copy the generated authorization URL at the bottom of the page.

Do not give Billy the **Administrator** permission. It is not needed.

Discord calls a server a **guild** in its developer tools and API. **Guild Install** therefore means installing Billy into your Discord server; it is not a separate permission checkbox.

The four selected permissions produce this bitfield:

| Permission           |     Value |
| -------------------- | --------: |
| View Channels        |  `1024` |
| Send Messages        |  `2048` |
| Embed Links          | `16384` |
| Read Message History | `65536` |
| **Total**      | `84992` |

Discord places that total in the generated URL as `permissions=84992`. It is only an installation-time permission request; do not add it to `.env` or Billy's runtime configuration.

These permissions serve specific purposes:

| Permission           | Why Billy needs it                                                 |
| -------------------- | ------------------------------------------------------------------ |
| View Channels        | Access the configured email channel                                |
| Send Messages        | Post draft approval requests and status updates                    |
| Embed Links          | Format email and draft details in readable embeds                  |
| Read Message History | Find, update, or disable earlier approval messages after a restart |

Billy does not initially need Manage Messages, Manage Channels, Manage Roles, Attach Files, or permission to mention everyone.

Discord documents the `bot` authorization scope in its [OAuth2 documentation](https://discord.com/developers/docs/topics/oauth2#bot-authorization-flow).

## 7. Install the bot in the server

1. Open the authorization URL copied from **OAuth2** > **URL Generator** in a browser.
2. Sign in with the Discord account that owns the application if necessary.
3. Under **Add to Server**, select `Billy Personal Assistant` or the private server you chose earlier.
4. Click **Continue**.
5. Review the permissions carefully.
6. Click **Authorize**.
7. Complete the CAPTCHA if prompted.

Return to Discord and open the server's member list. `Billy` should appear as a member. The bot may appear offline until the local Billy process connects; that is expected.

If your server is not available in the **Add to Server** list, the signed-in Discord account does not have the **Manage Server** permission for it.

## 8. Give the bot access to the email channel

For a private channel, installation alone may not grant channel access:

1. Right-click `#billy-emails`.
2. Select **Edit Channel**.
3. Open **Permissions**.
4. Click **Add members or roles**.
5. Select the `Billy` bot or its application role.
6. Explicitly allow:
   - View Channel
   - Send Messages
   - Embed Links
   - Read Message History
7. Save the changes.

Keep **View Channel** denied for `@everyone` because `#billy-emails` may contain private email data.

## 9. Enable Developer Mode and copy IDs

Discord normally hides its numeric IDs. Enable Developer Mode to copy the exact values Billy needs.

### Enable Developer Mode

1. Open Discord.
2. Click the gear icon next to your username to open **User Settings**.
3. Open **Advanced** under **App Settings**.
4. Turn on **Developer Mode**.

### Copy the email channel ID

1. Return to the Billy server.
2. Right-click `#billy-emails`.
3. Click **Copy Channel ID**.
4. Put the copied number in `.env`:

```dotenv
DISCORD_EMAIL_CHANNEL_ID=123456789012345678
```

Use the channel ID itself, not a channel link or the name `#billy-emails`.

### Copy the authorized reviewer IDs

For every person allowed to approve, reject, or regenerate drafts:

1. Right-click the person's name or avatar in Discord.
2. Click **Copy User ID**.
3. Add the numeric ID to `DISCORD_APPROVER_USER_IDS`.

For one reviewer:

```dotenv
DISCORD_APPROVER_USER_IDS=123456789012345678
```

For multiple reviewers, separate the IDs with commas:

```dotenv
DISCORD_APPROVER_USER_IDS=123456789012345678,987654321098765432
```

Use user IDs, not usernames, display names, email addresses, role IDs, or the bot's ID. User IDs remain stable when someone changes their name.

## 10. Confirm the completed environment settings

The Discord section of `.env` should now resemble this:

```dotenv
DISCORD_BOT_TOKEN=your-real-bot-token
DISCORD_EMAIL_CHANNEL_ID=123456789012345678
DISCORD_APPROVER_USER_IDS=123456789012345678,987654321098765432
```

`DISCORD_MAIN_CHANNEL_ID` may be omitted until general-purpose Billy features use it.

The email approval workflow also needs these Gmail recipient-safety settings:

```dotenv
GMAIL_OWN_ADDRESSES=blawsonhq@gmail.com
GMAIL_TRUSTED_FORWARDER_ADDRESSES=your-personal-email@example.com
```

Use a comma-separated list when either setting contains multiple accounts. Billy removes `GMAIL_OWN_ADDRESSES` from Reply All and only inspects forwarded-message headers when the outer sender appears in `GMAIL_TRUSTED_FORWARDER_ADDRESSES`.

Do not add `export` when Billy loads the file through `dotenv`. Do not leave the `<` or `>` example markers in the real `.env` values.

Never put the real values in `.env.example`. That file documents the expected variable names and safe examples only.

## 11. Test the Discord connection

The repository includes a setup script that verifies the bot token, email channel ID, and email channel permissions.

The script is located at `scripts/discord/verify-discord-credentials.mjs` and uses this connection flow:

```js
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
```

Run it from the repository root:

```bash
node scripts/discord/verify-discord-credentials.mjs
```

The test briefly posts an embed in `#billy-emails`, then deletes its own message. Successful output resembles:

```text
{
  bot: 'Billy#0000',
  channels: [
    {
      name: 'email',
      channelId: '123456789012345678',
      messageCreated: true
    }
  ]
}
```

This test uses only the `Guilds` intent—the same gateway access Billy needs for buttons and channel operations. The current `discord.js` client setup is documented in the [`discord.js` v14 reference](https://discord.js.org/docs/packages/discord.js/14).

## 12. Understand the approval flow

The implemented workflow is:

1. Gmail polling discovers a new message.
2. OpenRouter generates a reply draft.
3. SQLite stores that draft as an immutable revision.
4. Billy calculates Reply and Reply All recipients, including one-level trusted-forward handling.
5. Billy posts the context, recipients, complete draft, and controls to `#billy-emails`.
6. **Approve Reply** or **Approve Reply All** selects that exact revision and recipient list.
7. **Reject w/comments** generates another immutable revision while older versions remain approvable.
8. **Do not reply** ends the workflow without sending an email.
9. Billy verifies that every action came from a user in `DISCORD_APPROVER_USER_IDS`.
10. Approved drafts are queued for Gmail, and the selected draft card updates to **Sending**, **Sent successfully**, or **Sending failed**.
11. If all automatic OpenRouter attempts fail, Billy posts a failure card with a **Retry Generation** button for authorized reviewers.

Channel membership is not the final authorization check. Billy must also compare the clicking user's numeric ID against the allowlist. This prevents another server member with accidental channel access from approving an email.

Discord buttons are interactions, not ordinary chat messages. This is why Billy does not need the Message Content privileged intent.

## 13. Understand when the bot is online

With the local `discord.js` setup, Billy keeps a live Gateway connection to Discord. The bot is online only while Billy is running:

```bash
npm run dev
```

Stopping the process with `Ctrl+C` disconnects the bot. Drafts remain safely stored in SQLite, but no button clicks can be handled while the process is stopped.

The future AWS architecture may receive Discord interactions through an HTTPS endpoint instead of keeping a Gateway connection open. That deployment will require a public endpoint and Discord request-signature verification. It is not needed for the local phase.

## 14. Troubleshooting

### Discord reports an invalid token

- Confirm `.env` contains the bot token, not the Application ID or Public Key.
- Remove any `<` and `>` characters copied from `.env.example`.
- Open **Developer Portal** > **Applications** > **Billy Personal Assistant** > **Bot**, reset the token, and update `.env`.
- Restart Billy after changing `.env`.

Every token reset invalidates the previous token immediately.

### The bot is offline

The bot is expected to remain offline until the Node.js process logs in. Run the connection test or `npm run dev`.

### The test reports `Unknown Channel` or `Missing Access`

- Confirm `DISCORD_EMAIL_CHANNEL_ID` is the numeric ID of `#billy-emails`.
- Confirm the bot is installed in the same server as the email channel.
- Check the email channel's permission overrides and allow the bot to view it.
- Confirm you did not copy the server ID, category ID, or a channel link.

### The test reports `Missing Permissions`

Open the channel's permissions and explicitly allow the bot to use **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History**. A channel-specific deny overrides permissions granted elsewhere.

### Discord reports disallowed gateway intents

Billy should create its client with only `GatewayIntentBits.Guilds`. Do not add `MessageContent`, `GuildMembers`, or `GuildPresences` unless the design later introduces a specific need and the matching portal intent is enabled.

### The bot posts drafts, but buttons do nothing

- Confirm Billy is still running and connected.
- Check that the button belongs to the configured bot application.
- Confirm your user ID appears in `DISCORD_APPROVER_USER_IDS`.
- Inspect Billy's structured logs for the Discord component and interaction ID.

Check for an error response in Discord and inspect the `discord-email-approval` application logs.

### The server does not appear during installation

Sign in with an account that has **Manage Server** permission in the target server. Also confirm **Guild Install** is enabled on the application's Installation page.

Because Billy is private, the account must also own the application or belong to its developer team. Other Discord users cannot install the private bot even if they receive its authorization URL.

### Discord says a private application cannot have a default authorization link

1. Open the application's **Installation** page.
2. Change **Install Link** from **Discord Provided Link** to **None**.
3. Save the change.
4. Return to **Bot**, leave **Public Bot** turned off, and save again.

Use **OAuth2** > **URL Generator** to install Billy. A private bot can use a manually generated authorization URL even though its default Install Link is set to **None**.

## Security checklist

Before relying on Discord approvals, confirm all of the following:

- The email channel is private.
- Only intended reviewers can view the channel.
- The bot does not have Administrator permission.
- Privileged Gateway Intents are disabled.
- `.env` is ignored by Git.
- The bot token has never been committed or shared.
- Every approving person is listed by numeric user ID.
- Application code validates the configured email channel and the approving user ID.
- Approval buttons select immutable draft IDs, not merely the newest revision.
- Logs do not include the bot token or full private email bodies.

If the bot token is ever exposed, reset it immediately on the **Bot** page and replace the value in `.env`.

## Current workflow status

The Gmail reply workflow and Discord delivery reporting are implemented. SQLite persists generation failures, manual retry claims, approval decisions, Gmail send results, and the last delivery state rendered in Discord. This lets Billy reconcile missed Discord updates after reconnecting without sending the email again.

Gmail send retry is intentionally not exposed yet. A network interruption can leave it unclear whether Gmail accepted a message, so safe send retry belongs with the duplicate-send and crash-recovery work.
