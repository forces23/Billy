# Gmail and Calendar API integration guide

This guide configures a Google Cloud project and gives Billy permission to read Gmail messages, send approved replies, and read the Billy calendar plus configured shared calendars for scheduling suggestions.

It is written for Billy's first phase: one Gmail account, a local Node.js process, and OAuth 2.0 credentials stored in a local `.env` file. Billy calls the Gmail API directly through `googleapis`; it does not use an MCP server.

Last checked against Google Cloud Console and Google's documentation: October 11, 2026. Where the two disagree, this guide follows the console.

## What you will create

By the end of the guide, you will have:

- A Google Cloud project for Billy
- The Gmail and Google Calendar APIs enabled in that project
- A configured Google OAuth consent screen
- Your Gmail account added as an authorized test user, if necessary
- A Desktop app OAuth client
- A client ID, client secret, and refresh token in `.env`
- A successful read-only connection test
- Read access to every configured calendar

No API key or service account is needed. A normal Gmail mailbox must authorize Billy through OAuth 2.0.

## Before you start

You need:

- The Google account whose Gmail inbox Billy will monitor
- Permission to create a Google Cloud project
- Node.js and npm installed
- This repository installed with `npm install`
- A browser on the same computer where you run the authorization command

Keep the following secrets private:

- OAuth client secret
- OAuth refresh token
- Downloaded OAuth credential JSON file
- `.env`

Do not commit any of them to source control or paste them into issues, chat messages, or screenshots.

## 1. Create a Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Sign in with the Google account you want to use to manage the project.
3. At the top of the page, click the current project name or **Select a project**.
4. In the project picker, click **New Project**.
5. Enter a project name such as `Billy Email Assistant`.
6. If Google asks for an organization or location:
   - For a personal Gmail account, leave the default organization setting.
   - For a managed Google Workspace account, select the organization or folder required by your administrator.
7. Click **Create**.
8. Wait for the project to finish creating.
9. Open the project picker again and select the new project.

You can also begin directly from the [New Project page](https://console.cloud.google.com/projectcreate).

Before continuing, verify that `Billy Email Assistant` is shown in the project selector at the top of the console. Google Cloud settings apply to whichever project is currently selected.

## 2. Enable the Gmail API

1. With the Billy project selected, open the [Gmail API page](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
2. Confirm the correct project name is shown in the page header or project selector.
3. Click **Enable**.
4. Wait for the API overview page to load.

If the button says **Manage** instead of **Enable**, the Gmail API is already enabled for the selected project.

To find this page through the menus instead:

1. Open the navigation menu in the upper-left corner.
2. Go to **APIs & Services** > **Library**.
3. Search for `Gmail API`.
4. Select **Gmail API** published by Google.
5. Click **Enable**.

Google's [Node.js Gmail quickstart](https://developers.google.com/workspace/gmail/api/quickstart/nodejs) also starts by enabling the Gmail API in a Cloud project.

Enable the [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) in the same project. If the OAuth account does not own one of the calendars, share that calendar with the OAuth account with permission to see event details, then copy its Calendar ID from Google Calendar's **Settings and sharing** > **Integrate calendar** section.

## 3. Configure the Google Auth Platform

1. Open [Google Auth Platform Overview](https://console.cloud.google.com/auth/overview).
2. Confirm the Billy project is still selected.
3. If the page says the Google Auth Platform is not configured, click **Get Started**.

Complete the setup screens as follows.

### App information

1. For **App name**, enter `Billy Email Assistant`.
2. For **User support email**, select your email address.
3. Click **Next**.

### Audience

Choose the audience based on the Gmail account type:

- Choose **External** for a regular `gmail.com` account or when the mailbox is outside your Google Workspace organization.
- Choose **Internal** only when the project belongs to a Google Workspace organization and every account that will authorize Billy is inside that organization.

For most personal installations, choose **External**, then click **Next**.

### Contact information

1. Enter an email address Google can use for project notifications.
2. Click **Next**.

### Finish

1. Read the Google API Services User Data Policy acknowledgement.
2. Select the acknowledgement if you agree.
3. Click **Continue**.
4. Click **Create**.

After setup, the left navigation under **Google Auth Platform** should contain **Branding**, **Audience**, **Clients**, and **Data Access**. These names match Google's current [Gmail Node.js authorization instructions](https://developers.google.com/workspace/gmail/api/quickstart/nodejs#authorize_credentials_for_a_desktop_application).

## 4. Add your Gmail account as a test user

Do this section when the audience is **External** and the publishing status is **Testing**.

1. Open [Google Auth Platform &gt; Audience](https://console.cloud.google.com/auth/audience).
2. Find the **Test users** section.
3. Click **Add users**.
4. Enter the exact Gmail address Billy will monitor.
5. Click **Save**.
6. Confirm the address appears in the test-user list.

If the account is not listed, Google can reject the OAuth flow with an access-denied message.

### Important seven-day testing limit

For an External app in Testing, authorizations involving Gmail scopes expire after seven days. The refresh token expires too. Google documents this behavior on its [Manage App Audience](https://support.google.com/cloud/answer/15549945) page.

Testing mode is fine while initially building Billy. Before relying on unattended polling long term, review the **Publishing status** section on the Audience page:

- Leaving the app in Testing means reauthorizing approximately every seven days.
- Moving it to **In production** avoids the testing authorization lifetime, but an unverified app requesting sensitive or restricted Gmail scopes can display an unverified-app warning and remains subject to Google's user limits and verification rules.
- If Billy will be distributed to other people, do not treat the personal-development setup in this guide as a substitute for Google's verification and data-use requirements.

### Requirements before switching to production

Google requires every External production app to complete its public-facing branding information. Before the **Publish app** action will succeed, open [Google Auth Platform &gt; Branding](https://console.cloud.google.com/auth/branding) and provide:

- A valid app name, such as `Bobby Lawson Email Assistant`
- A user support email
- A publicly accessible application homepage URL
- A publicly accessible privacy policy URL
- A developer contact email

The homepage and privacy policy must be hosted on the same verified domain that you own. The homepage must describe what the application does and link to the same privacy policy URL entered in Google Cloud. The privacy policy must explain how the application accesses, uses, stores, and shares Google user data—including sending selected email content to OpenRouter for draft generation.

For example, after purchasing and verifying `bobbylawson.com`, the URLs could be:

```text
Homepage:       https://bobbylawson.com/email-assistant
Privacy policy: https://bobbylawson.com/email-assistant/privacy
Authorized domain: bobbylawson.com
```

Do not use `localhost`, a private page, or an arbitrary page on a domain you do not control. Google requires production homepages to be public and hosted on a verified domain. Domain ownership is verified through [Google Search Console](https://search.google.com/search-console/about), normally by adding a DNS record supplied by Google.

If you do not yet own a domain or want to postpone the public pages and privacy disclosures, leave the app in Testing and generate a new refresh token when the seven-day authorization expires. The OAuth client ID and client secret remain the same.

## 5. Configure Gmail and Calendar scopes

1. Open [Google Auth Platform &gt; Data Access](https://console.cloud.google.com/auth/scopes).
2. Click **Add or remove scopes**.
3. In the scope picker, filter by `Gmail API` or `Google Calendar API`, or paste each scope URL.
4. Select these scopes:

| Scope                                                       | Console description       | Why Billy needs it                                       |
| ----------------------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| `https://www.googleapis.com/auth/gmail.messages.readonly` | Read your emails          | Find and read messages without changing or deleting them |
| `https://www.googleapis.com/auth/gmail.user.readonly`     | View your email address and basic profile | Verify which mailbox authorized Billy                    |
| `https://www.googleapis.com/auth/gmail.send`              | Send email on your behalf | Send a reply only after Discord approval                 |
| `https://www.googleapis.com/auth/calendar.readonly`       | See and download calendars | Read event times and titles without changing calendars   |
| `https://www.googleapis.com/auth/calendar.events.owned`   | Manage events on owned calendars | Prepare event creation and changes only for calendars owned by the OAuth account |

5. Click **Update**.
6. Click **Save** if the Data Access page presents a separate save button.
7. Confirm all scopes appear in the configured-scopes list.

Add the Billy calendar ID and a comma-separated list of shared Calendar IDs to `.env`:

```dotenv
GOOGLE_CALENDAR_SHARED_IDS=your-personal-calendar-id,another-shared-calendar-id
GOOGLE_CALENDAR_BILLY_ID=your-billy-calendar-id
SCHEDULING_TIME_ZONE=America/Chicago
```

Regenerate the refresh token after adding the Calendar scopes. An older token does not automatically gain the new permissions. `node scripts/google/verify-gmail-credentials.mjs` now verifies Gmail plus read access to every configured calendar. The OAuth account must own the Billy calendar but not calendars listed in `GOOGLE_CALENDAR_SHARED_IDS`; share those separately owned calendars with the OAuth account using event-detail read access.

Do not select `calendar.events`: it would permit event changes on every calendar the OAuth account can access. `calendar.calendars.readonly` is unnecessary because `calendar.readonly` already includes calendar metadata. The Calendar scope boundary is based on ownership, so `calendar.events.owned` protects the personal calendar only when that calendar is owned by another account.

### Why these Gmail scopes and not the broader alternatives

The scope picker lists 38 Gmail scopes. Most of them are granular scopes that Google has not yet added to its published [Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes) or its [master OAuth scope list](https://developers.google.com/identity/protocols/oauth2/scopes), both of which still describe an older set of 14. Trust the console picker over the documentation; the picker reflects the live service configuration.

`gmail.messages.readonly` ("Read your emails") is narrower than the documented `gmail.readonly` ("View your email messages **and settings**"). Billy never reads filters, forwarding rules, send-as aliases, or delegates, so the narrower scope is the correct choice.

Scopes deliberately **not** requested:

- `https://mail.google.com/` — permits permanent deletion and is far broader than Billy needs.
- `gmail.send.self` — sends only to the mailbox owner. Billy replies to correspondents, so this grants nothing the workflow uses.
- `gmail.modify` and `gmail.messages.modify` — add one later only if Billy must apply labels or mark messages read. SQLite tracks processing state during Phase 1.
- `gmail.drafts` and `gmail.drafts.create` — only relevant if Billy is changed to create native Gmail drafts instead of SQLite rows.
- `gmail.notifications` ("Update email notification subscriptions") — likely required for `users.watch` in Phase 3 when push notifications replace polling. Verify it then; the `users.watch` reference still lists only the older scopes.

### Classification caveat

Google documents `gmail.send` as sensitive and `gmail.readonly` as restricted. No published classification exists for the granular scopes, so treat `gmail.messages.readonly` as restricted until Google states otherwise. It reads message bodies, so it cannot be less sensitive than `gmail.readonly`. This matters only for the production-publishing path in section 4; it does not affect local development.

## 6. Create a Desktop OAuth client

1. Open [Google Auth Platform &gt; Clients](https://console.cloud.google.com/auth/clients).
2. Click **Create Client**.
3. For **Application type**, choose **Desktop app**.
4. For **Name**, enter `Billy Local Development`.
5. Click **Create**.
6. In the confirmation dialog, click **Download JSON**.

If you close the dialog before downloading:

1. Return to the **Clients** page.
2. Select `Billy Local Development` from the OAuth client list.
3. Use **Download JSON** or the download icon.

Rename the downloaded file to `credentials.json` and temporarily place it in the repository root:

```text
Billy/
├── credentials.json  # temporary secret; never commit
├── package.json
└── ...
```

A Desktop client is important here. Google's loopback OAuth flow remains supported for Desktop app clients and allows the local authorization helper to receive the browser callback on a temporary localhost port.

## 7. Copy the client ID and client secret

Open `credentials.json` locally. Its top-level structure should contain an `installed` object similar to this:

```json
{
  "installed": {
    "client_id": "<client-id>.apps.googleusercontent.com",
    "client_secret": "<client-secret>",
    "redirect_uris": ["http://localhost"]
  }
}
```

The example values above use angle brackets; the real downloaded values do not.

If `.env` does not exist yet, copy the example file:

```bash
cp .env.example .env
```

In `.env`, replace the Google placeholders with the downloaded values and remove the angle brackets:

```dotenv
GOOGLE_CLIENT_ID=<paste-client-id-here>
GOOGLE_CLIENT_SECRET=<paste-client-secret-here>
GOOGLE_REFRESH_TOKEN=<generated-in-the-next-section>
GMAIL_USER_ID=me
```

Do not add `export`. The `dotenv` package reads `NAME=value` entries directly.

## 8. Generate a refresh token

Billy needs a refresh token because it polls Gmail when no user is present. Google calls this **offline access**. Access tokens expire quickly; `googleapis` can use the refresh token to obtain new access tokens automatically.

### Install Google's local authorization helper

From the repository root, run:

```bash
npm install --save-dev @google-cloud/local-auth
```

This is the helper used in Google's Node.js Gmail quickstart.

### Create a temporary token generator

Create `generate-google-refresh-token.mjs` in the repository root with the following contents:

```js
import { resolve } from "node:path";
import { authenticate } from "@google-cloud/local-auth";

const scopes = [
  "https://www.googleapis.com/auth/gmail.messages.readonly",
  "https://www.googleapis.com/auth/gmail.user.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned",
];

const client = await authenticate({
  keyfilePath: resolve("credentials.json"),
  scopes,
});

const refreshToken = client.credentials.refresh_token;

if (!refreshToken) {
  throw new Error(
    "Google did not return a refresh token. See the troubleshooting section in the guide.",
  );
}

console.log("\nCopy this value into GOOGLE_REFRESH_TOKEN in .env:\n");
console.log(refreshToken);
```

Run it:

```bash
node generate-google-refresh-token.mjs
```

The helper should open your default browser. If it does not, confirm that you are running the command on your local desktop rather than through SSH, then rerun it. This helper requires access to a local browser.

In the browser:

1. Select the same Google account you added as a test user.
2. Confirm that the consent page names `Billy Email Assistant`.
3. Review the requested Gmail permissions.
4. If Google shows an unverified-app warning during personal development, use the page's advanced option to continue only after confirming that the project and client are yours.
5. Approve the requested permissions.
6. Wait for the browser to report that authentication succeeded.
7. Return to the terminal.

The terminal prints the refresh token. Copy only that token into `.env`:

```dotenv
GOOGLE_REFRESH_TOKEN=<paste-the-returned-refresh-token-here>
```

Remove the angle brackets from the real value. Do not paste the token into `.env.example`.

After saving the token, remove the temporary generator and move or securely delete the downloaded credential JSON. Billy uses the client ID, client secret, and refresh token from `.env` at runtime; it does not need `credentials.json`.

## 9. Verify the credentials without sending email

Run the verifier included with Billy:

```bash
node scripts/google/verify-gmail-credentials.mjs
```

It reads `GOOGLE_CALENDAR_BILLY_ID` and every comma-separated ID in `GOOGLE_CALENDAR_SHARED_IDS`, then confirms that the OAuth account can access each calendar.

A successful result resembles:

```text
{
  emailAddress: '<your-email-address>',
  inboxConnectionSuccessful: true,
  sampleMessageFound: true,
  calendars: [
    {
      calendarId: 'billy-calendar-id',
      summary: 'Billy',
      timeZone: 'America/Chicago',
      readable: true
    },
    {
      calendarId: 'personal-calendar-id',
      summary: 'Personal',
      timeZone: 'America/Chicago',
      readable: true
    }
  ]
}
```

`sampleMessageFound` can be `false` when the inbox query returns no messages. Calendar names, IDs, timezones, and the number of entries depend on your configuration. The connection is valid when every configured calendar reports `readable: true` and the script exits without throwing.

`emailAddress` can report `unavailable` when the saved refresh token predates the `gmail.user.readonly` permission. Regenerate the token with all scopes listed in section 5. The core workflow still uses `GMAIL_USER_ID=me` rather than depending on the returned address.

This test reads mailbox and calendar information but does not send email; modify, delete, archive, or mark messages as read; or change calendar events.

## 10. Confirm the final `.env` configuration

The Google portion of the real `.env` should now contain the OAuth, Gmail, and Calendar settings without angle brackets:

```dotenv
GOOGLE_CLIENT_ID=your-real-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-real-client-secret
GOOGLE_REFRESH_TOKEN=your-real-refresh-token
GMAIL_USER_ID=me
GMAIL_OWN_ADDRESSES=blawsonhq@gmail.com
GMAIL_TRUSTED_FORWARDER_ADDRESSES=your-personal-email@example.com
GMAIL_SEND_INTERVAL_SECONDS=2
GOOGLE_CALENDAR_BILLY_ID=primary
GOOGLE_CALENDAR_SHARED_IDS=personal-calendar-id,another-shared-calendar-id
SCHEDULING_TIME_ZONE=America/Chicago
```

`GMAIL_OWN_ADDRESSES` is a comma-separated list of the monitored mailbox and any send-as aliases. Billy removes these addresses from Reply All. `GMAIL_TRUSTED_FORWARDER_ADDRESSES` is a comma-separated list of personal accounts whose forwarded messages Billy accepts. Forwarded messages from other addresses are marked ignored and logged without being classified or drafted. Replace the forwarding example with the actual personal address you will forward from. `GOOGLE_CALENDAR_SHARED_IDS` is a comma-separated list of every read-only calendar shared with Billy; append another ID when you add another shared calendar.

Checklist:

- [X] The Gmail and Google Calendar APIs are enabled in the same project that owns the OAuth client.
- [X] The authorization account is the Gmail account Billy should monitor.
- [X] All Gmail and Calendar scopes listed in section 5 were approved.
- [X] The Billy calendar and every ID in `GOOGLE_CALENDAR_SHARED_IDS` pass verification.
- [X] `.env` contains real values without `<` or `>`.
- [X] `.env.example` contains examples only.
- [X] `credentials.json` and `.env` are not committed.
- [X] The read-only verification script completes successfully.

## How Billy should use these credentials

The Gmail integration will create one reusable OAuth client:

```ts
import { google } from "googleapis";

const auth = new google.auth.OAuth2(clientId, clientSecret);
auth.setCredentials({ refresh_token: refreshToken });

const gmail = google.gmail({ version: "v1", auth });
```

The library refreshes short-lived access tokens as needed. Billy should never log the OAuth client secret, refresh token, access token, full authorization headers, or raw credential objects.

For the application workflow:

- Use `users.messages.list` to discover candidate messages.
- Use `users.messages.get` to retrieve an individual message.
- Persist the Gmail message ID before generating a draft to prevent duplicate processing.
- Use `users.messages.send` only after an authorized Discord approval.
- When replying, include the original `threadId`, preserve the subject, and set valid `In-Reply-To` and `References` headers so Gmail keeps the response in the same thread. Google documents all three requirements in [Manage threads](https://developers.google.com/workspace/gmail/api/guides/threads#add_drafts_and_messages_to_threads).
- For a trusted forwarded message, send a new message to the resolved original recipients instead of attaching the reply to the outer forwarding thread.

## Troubleshooting

### `Error 403: access_denied`

- Open [Audience](https://console.cloud.google.com/auth/audience).
- Confirm the app is External/Testing or correctly configured as Internal.
- For External/Testing, confirm the Gmail address is listed under **Test users**.
- Confirm you selected that exact account in the browser.

### `Google hasn't verified this app`

This is expected during development when an unverified project requests sensitive or restricted Gmail scopes. Continue only when you own the Cloud project and recognize the app name and requested scopes. Public or multi-user deployment requires a separate review of Google's verification requirements.

### No refresh token was returned

Google commonly returns a refresh token only on the first consent grant for a particular user and client.

1. Open your Google Account's [third-party connections page](https://myaccount.google.com/connections).
2. Find Billy or the Google Cloud project's connection.
3. Revoke that connection.
4. Run `node generate-google-refresh-token.mjs` again.
5. Approve both Gmail permissions again.

Revoking the connection invalidates the previous token.

### `redirect_uri_mismatch`

- Confirm the OAuth client type is **Desktop app**, not Web application.
- Download a fresh JSON file from the Desktop client.
- Confirm the file contains an `installed` object and a localhost redirect URI.
- Run the token generator locally, not through SSH or a remote shell.

### `invalid_grant`

The refresh token can be expired or revoked. External/Testing tokens expire after seven days. Password changes, prolonged non-use, manual revocation, and too many active tokens can also invalidate refresh tokens. Generate a new token and replace `GOOGLE_REFRESH_TOKEN`.

### `Request had insufficient authentication scopes`

The saved refresh token was authorized with fewer permissions than the code now requests.

1. Confirm the correct scopes are configured under **Data Access**.
2. Revoke Billy from the Google Account connections page.
3. Generate a new refresh token using all scopes listed in this guide.

Changing the scope list does not expand an already-issued refresh token.

If a specific call fails while others succeed, the granular scope set is probably the cause. Google's method reference pages still list the older, broader scopes as the accepted ones, so a method can require a granular scope that the reference does not mention. Find the matching scope in the Data Access picker, add it, and generate a new refresh token. Add scopes one at a time rather than falling back to `gmail.readonly`.

### `Gmail API has not been used ... or it is disabled`

- Return to the [Gmail API page](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
- Confirm the OAuth client's project is selected.
- Click **Enable** if necessary.
- Wait a few minutes and retry.

### Workspace administrator blocked the app

A managed Google Workspace organization can restrict third-party and internal app access. Ask the Workspace administrator to review the OAuth client ID and requested Gmail scopes. A personal code change cannot override an organization policy.

## Security and publishing notes

The setup above is appropriate for local development and personal testing. Before adding other users or deploying Billy as a hosted service:

- Review [Google&#39;s OAuth verification guidance](https://support.google.com/cloud/answer/13463073).
- Review the [Google Workspace API user data and developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy).
- Document that selected email content is sent to OpenRouter for draft generation.
- Define retention and deletion behavior for email content stored in SQLite.
- Request only the Gmail scopes actually used.
- Keep development/testing and production Google Cloud projects separate.

Because `gmail.messages.readonly` reads message bodies and Billy may transmit selected message content to an LLM provider, publishing the application beyond personal use can introduce verification, disclosure, and security-assessment obligations. Resolve those obligations before distributing or hosting Billy for others.

## Official references

- [Gmail API Node.js quickstart](https://developers.google.com/workspace/gmail/api/quickstart/nodejs)
- [Gmail API scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Auth Platform audience documentation](https://support.google.com/cloud/answer/15549945)
- [Google APIs Node.js client authentication](https://github.com/googleapis/google-api-nodejs-client#oauth2-client)
- [Gmail thread requirements](https://developers.google.com/workspace/gmail/api/guides/threads)
