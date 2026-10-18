# Google Calendar API setup guide

This guide gives Billy read-only access to configured shared calendars and authorizes event management on the Billy calendar when it is owned by the OAuth account. Billy can then evaluate scheduling requests, explain conflicts, and suggest alternative interview times without receiving write access to separately owned calendars.

Billy never creates a calendar event merely because a time was selected. Selecting a time creates an email draft, and Gmail sends it only after Discord approval. When the recruiter later confirms the selected time in the same Gmail thread, Billy posts a separate calendar-event proposal in Discord. Creating, updating, or deleting that event always requires an explicit Discord action.

Last checked against Google's documentation and Google Cloud Console: October 15, 2026.

## Before you start

This guide assumes Billy's Gmail OAuth client is already configured. You should already have these values in your uncommitted `.env` file:

```dotenv
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REFRESH_TOKEN=your-current-refresh-token
```

You also need:

- Access to the Google Cloud project used by Billy
- Access to the Billy calendar and every calendar you want to share, or help from their owners
- Billy's Desktop app OAuth credential JSON at `SECRETS/credentials-google-Billy-local.json`
- A browser on the same computer where you run Billy

Keep the OAuth client secret, credential JSON, refresh token, and `.env` private. Do not commit or paste them into chat.

## 1. Enable the Google Calendar API

1. Open the [Google Calendar API page in Google Cloud Console](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
2. Use the project selector at the top of the page to select the same Google Cloud project Billy uses for Gmail.
3. Click **Enable**.
4. Wait for the Calendar API overview page to open.

If the button says **Manage**, the API is already enabled.

You can also reach it through **APIs & Services** > **Library**, search for `Google Calendar API`, select the result published by Google, and click **Enable**. Google documents both the console and `gcloud` methods in its [Workspace API enablement guide](https://developers.google.com/workspace/guides/enable-apis).

## 2. Add the read and owned-event OAuth scopes

Billy needs event titles as well as busy times so it can say things such as “Jill's Birthday is on that date.” Free/busy-only access is therefore not sufficient.

1. In Google Cloud Console, open [Google Auth Platform > Data Access](https://console.cloud.google.com/auth/scopes).
2. Confirm the same Billy project is selected.
3. Click **Add or remove scopes**.
4. Search for and select these exact scopes:

   ```text
   https://www.googleapis.com/auth/calendar.readonly
   https://www.googleapis.com/auth/calendar.events.owned
   ```

5. Clear these scopes if they are currently selected:

   ```text
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/calendar.calendars.readonly
   ```

   `calendar.events` is too broad because it permits editing events on every calendar available to the OAuth account. `calendar.calendars.readonly` is redundant when `calendar.readonly` is already selected.

6. Click **Update**.
7. Click **Save** if the Data Access page shows a separate save button.
8. Confirm both required scopes appear in the configured-scopes list.

The scopes have separate jobs:

- `calendar.readonly` lets Billy read the Billy calendar and all configured shared calendars, including event titles.
- `calendar.events.owned` permits creating, changing, and deleting events only on calendars owned by the OAuth account.

Do not select the broader `https://www.googleapis.com/auth/calendar` scope. It permits editing, sharing, and permanently deleting all calendars the account can access. Google lists the exact boundaries of these scopes in its [Calendar authorization guide](https://developers.google.com/workspace/calendar/api/auth).

OAuth scopes are based on calendar ownership, not the Calendar IDs in `.env`. This permission boundary is safe only when the OAuth account owns the Billy calendar and does not own the calendars listed in `GOOGLE_CALENDAR_SHARED_IDS`.

## 3. Decide which Google account authorizes Billy

Billy uses one Google OAuth identity for Gmail and all calendars. That identity is the account you choose when the refresh-token script opens Google's consent page.

The required least-privilege arrangement is:

- The OAuth account owns the Billy calendar.
- Every read-only calendar is owned by a different Google account and shared with the OAuth account.
- The Billy calendar ID and all shared Calendar IDs are configured explicitly in `.env`.

For example, if Billy's Gmail/OAuth account is `blawsonhq@gmail.com`, use that account during authorization and share your personal calendar with `blawsonhq@gmail.com`.

You do not need a second OAuth client or a second refresh token.

If the OAuth account owns any calendar listed in `GOOGLE_CALENDAR_SHARED_IDS`, `calendar.events.owned` authorizes event changes on that calendar too. Google cannot narrow that scope to one Calendar ID. Keep read-only calendars under separately owned accounts and share them with the OAuth account if you require an OAuth-enforced read-only boundary.

## 4. Share the other calendar with the OAuth account

Repeat these steps for any calendar the OAuth account cannot already open:

1. On a computer, open [Google Calendar](https://calendar.google.com/).
2. In the left sidebar, find the calendar under **My calendars**.
3. Point to the calendar, click the three-dot menu, and choose **Settings and sharing**.
4. In the left navigation, select **Shared with** or find **Share with specific people or groups**.
5. Click **Add people and groups**.
6. Enter the email address of the Google account that authorizes Billy.
7. Choose **See all event details** or **See event details**.
8. Click **Send**.
9. Sign in as the OAuth account and accept the calendar invitation if Google sends one.

Do not make a private calendar public. Sharing it directly with Billy's OAuth account is enough.

Sharing a calendar with Billy's OAuth account does not copy or merge its events into the Billy calendar. Google Calendar may display multiple calendars together in the web interface, but the API still stores and queries them separately. Billy therefore needs each Calendar ID so it can call every configured calendar and combine their events when checking availability.

If you grant only **See only free/busy**, Billy can detect a conflict but cannot display the event title. Google's [calendar sharing guide](https://support.google.com/calendar/answer/37082) explains the difference between free/busy and event-detail permissions.

Google Workspace administrators can restrict cross-account sharing. If the required permission is unavailable, an administrator must allow it or the OAuth account must be moved into an account/domain that can access the required calendars.

## 5. Copy the Billy and shared Calendar IDs

Calendar IDs are not always the same as the calendar's visible name.

For the Billy calendar and each calendar you shared with Billy:

1. Open Google Calendar on a computer.
2. Find the calendar in the left sidebar.
3. Open its three-dot menu and select **Settings and sharing**.
4. Scroll to **Integrate calendar**.
5. Copy the value next to **Calendar ID**.

A primary calendar commonly uses the owner's email address as its ID. A secondary calendar may have a longer ID ending in `@group.calendar.google.com`.

Google's API also accepts `primary` for the authorizing account's primary calendar. Shared calendars use their explicit Calendar IDs; Billy automatically retrieves their display names from Google for conflict messages.

## 6. Configure Billy's environment

Open the uncommitted `.env` file. Set the Billy calendar separately, then place every read-only shared calendar in one comma-separated value:

```dotenv
GOOGLE_CALENDAR_SHARED_IDS=your-personal-calendar-id,another-shared-calendar-id
GOOGLE_CALENDAR_BILLY_ID=your-billy-calendar-id
```

Use the Calendar IDs copied from Google. Do not include angle brackets, quotation marks, calendar URLs, or calendar display names. To add another shared calendar later, share it with Billy's OAuth account and append its ID to `GOOGLE_CALENDAR_SHARED_IDS`; no TypeScript change is needed.

Billy's scheduling defaults can remain as follows:

```dotenv
SCHEDULING_TIME_ZONE=America/Chicago
SCHEDULING_WORKDAY_START_HOUR=9
SCHEDULING_WORKDAY_END_HOUR=18
SCHEDULING_DEFAULT_DURATION_MINUTES=30
SCHEDULING_BUFFER_AFTER_MINUTES=15
SCHEDULING_SEARCH_BUSINESS_DAYS=10
```

These settings mean:

- Suggestions use Central time and handle daylight-saving changes.
- Meetings must fall Monday through Friday between 9:00 AM and 6:00 PM.
- A meeting without a stated duration is treated as 30 minutes.
- Billy requires another 15 free minutes after the meeting.
- Alternative searches cover up to 10 business days.

The committed [`.env.example`](../../../.env.example) contains the complete configuration template.

## 7. Generate a new refresh token

Your existing refresh token does not automatically receive newly added Calendar permissions. Generate a replacement token after enabling the API and adding both scopes.

Confirm this file exists:

```text
SECRETS/credentials-google-Billy-local.json
```

It must be the Desktop app OAuth client JSON from the same Google Cloud project. Then run this command from the repository root:

```bash
node scripts/google/generate-gmail-refresh-token.mjs
```

The script requests Billy's existing Gmail permissions plus:

```text
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events.owned
```

When the browser opens:

1. Choose the Google account identified in step 3.
2. Confirm the consent page shows Billy's application name.
3. Review the Gmail and Calendar permissions.
4. Approve the request.
5. Return to the terminal.

Copy the printed refresh token into `.env`, replacing the old value:

```dotenv
GOOGLE_REFRESH_TOKEN=the-new-refresh-token
```

Do not paste the token into `.env.example` or this guide.

If the OAuth app is External and still in Testing, Google may expire the authorization after seven days. Regenerate the token when that happens.

## 8. Verify all calendars

Run Billy's credential verifier from the repository root:

```bash
node scripts/google/verify-gmail-credentials.mjs
```

The verifier does not send email or modify calendar events. It confirms Gmail access and calls the Calendar API for the Billy calendar and every ID in `GOOGLE_CALENDAR_SHARED_IDS`.

A successful result resembles:

```text
{
  emailAddress: 'blawsonhq@gmail.com',
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

The exact names, IDs, timezone, number of calendars, and `sampleMessageFound` value can differ. The important result is that every calendar entry has `readable: true` and the command exits successfully.

## 9. Start Billy and test the workflow

Start Billy:

```bash
npm run dev
```

For a safe manual test:

1. Add a temporary event to one configured calendar during working hours.
2. Send the monitored Gmail account a professional scheduling email proposing that exact time and include a timezone.
3. Wait for Billy's normal Gmail polling cycle.
4. Confirm Discord shows a scheduling card that identifies the conflict and offers alternatives.
5. Open the scheduling thread and ask, `what does next week look like?`
6. Confirm Billy posts a new availability card in the thread using all configured calendars. The earlier card should remain unchanged.
7. Select a suggested time and confirm Billy creates an email draft rather than sending immediately.
8. Review and approve that draft through the normal approval controls.
9. Reply as the recruiter in the same Gmail thread and clearly confirm the selected time.
10. Confirm Billy recognizes the reply as a confirmation instead of starting a new scheduling search.
11. Review the calendar-event proposal in Discord. Confirm its title, date/time, timezone, duration, and description can be edited.
12. Click **Create event** and confirm the event appears only on the calendar configured by `GOOGLE_CALENDAR_BILLY_ID`.
13. Confirm the recruiter was not added as an attendee and Google did not send a Calendar invitation.
14. Use the explicit Discord edit or delete control if you need to change or remove the test event.

## Troubleshooting

### `Missing GOOGLE_CALENDAR_SHARED_IDS` or `Missing GOOGLE_CALENDAR_BILLY_ID`

The names in `.env` must match exactly:

```dotenv
GOOGLE_CALENDAR_SHARED_IDS=personal-id,another-shared-id
GOOGLE_CALENDAR_BILLY_ID=...
```

Restart Billy after changing `.env`.

### `Google Calendar API has not been used` or `accessNotConfigured`

The Calendar API is disabled in the selected Cloud project, or it was enabled in a different project. Return to step 1 and confirm the project selector matches the project that owns `GOOGLE_CLIENT_ID`.

After enabling the API, wait a minute and rerun the verifier.

### `Request had insufficient authentication scopes`

The current refresh token was issued before `calendar.readonly` and `calendar.events.owned` were requested. Complete steps 2 and 7, then replace `GOOGLE_REFRESH_TOKEN` in `.env`.

### `Not Found`, `404`, or `Calendar not found`

Check that:

- The value is the Calendar ID from **Integrate calendar**, not its display name or URL.
- The OAuth account can see the calendar in Google Calendar.
- A shared-calendar invitation was accepted.
- The calendar was shared with the same account used to generate the refresh token.

### `Forbidden`, `403`, or event titles show only `Busy`

The OAuth account likely has free/busy access but not event-detail access. Share the calendar with **See all event details**, then rerun the verifier.

Events explicitly marked private may still appear without a title depending on the calendar's sharing policy. Billy safely displays those as `Busy`.

### No refresh token was returned

Google may reuse an earlier grant without returning a new refresh token. Remove Billy's existing access from the authorizing account's Google Account connections, then rerun the token generator and approve all requested permissions again.

Also confirm you are running the command locally with browser access and using the Desktop app credential JSON expected by the script.

### Billy suggests the wrong timezone

Confirm:

```dotenv
SCHEDULING_TIME_ZONE=America/Chicago
```

The calendar's own display timezone does not replace Billy's scheduling timezone. Restart Billy after changing the setting.

### Billy does not create an event after a time is approved

Approving the scheduling email does not create an event by itself. Billy first waits for the recruiter to confirm the chosen time in the same Gmail thread. After that reply is processed, open the Discord email thread and approve the separate calendar-event card.

If the confirmation creates another availability search, verify that the recruiter replied in the same Gmail thread and that Billy had already sent the selected-time draft. Ambiguous replies are held for review instead of being treated as confirmation. If no calendar-event card appears, check the application log for the scheduling-reply classifier result and confirm the Discord thread is still accessible to the bot.

## Security checklist

- Google Calendar API is enabled only in Billy's intended Cloud project.
- Billy requests `calendar.readonly` plus `calendar.events.owned`, not the broader `calendar.events` or `calendar` scopes.
- The OAuth account owns the Billy calendar but does not own calendars listed in `GOOGLE_CALENDAR_SHARED_IDS`.
- Billy writes only to `GOOGLE_CALENDAR_BILLY_ID`; shared IDs are availability inputs only.
- Calendar creation, updates, and deletion require separate Discord approval actions.
- Calendar writes use `sendUpdates: none` and do not add the recruiter as an attendee.
- Calendars are shared directly with the OAuth account, not made public.
- `.env`, the refresh token, and the OAuth client JSON remain uncommitted.
- Every configured Calendar ID passes the verification script.
- Billy still requires Discord approval before sending a scheduling reply.

For the complete Gmail OAuth setup, see [Gmail and Calendar API integration](gmail-api-integration.md). Google's official reference is the [Calendar Node.js quickstart](https://developers.google.com/workspace/calendar/api/quickstart/nodejs).
