# Billy

Billy is a local-first personal and email assistant operated through Discord. It
can hold owner-only conversations with persistent searchable memory, draft Gmail
replies for human review, coordinate interview scheduling, and propose Google
Calendar changes. Email and calendar writes still require explicit approval.

The initial goal is a dependable workflow running on a local machine. The application is structured so its core behavior can later move to AWS Lambda without being rewritten around AWS-specific services.

> **Project status:** The local Discord assistant, Gmail approval workflow,
> scheduling workflow, Google Calendar proposals, SQLite persistence, and Gmail
> sending worker are implemented. Weather, reminders, daily briefs, tasks, and
> image generation remain on the personal-assistant roadmap.

## Implemented workflows

### Main assistant chat

```text
Owner message in #billy
    |
    +---- local command ------> remember / forget / reset / usage report
    |
    v
Load bounded recent context
    |
    +---- durable memories
    +---- relevant older messages from SQLite FTS5
    |
    v
Gemini Flash Latest through OpenRouter
    |
    v
Reply in #billy and store the complete exchange in SQLite
```

### Email and scheduling approval

```text
Gmail polling
    |
    v
Discover new message
    |
    v
Classify with a low-cost OpenRouter model
    |
    +---- job alert / advertisement / scam ----> ignore
    |
    +---- professional scheduling -------------> check configured calendars
                                                   |
                                                   v
                                               discuss/select in Discord thread
                                                   |
                                                   v
                                               generate approval draft
    |
    v
Generate a reply with the appropriate context
    |
    v
Store draft in SQLite
    |
    v
Request approval in Discord
    |
    +---- reject / expire ----> stop
    |
    +---- approve -----------> send Gmail reply
                                  |
                                  v
                              mark as sent
```

Billy never sends an AI-generated email or writes a calendar change without an
explicit authorized approval. Main-chat replies do not require approval because
they do not perform those external writes.

## Technology

| Area | Technology |
| --- | --- |
| Runtime | Node.js LTS |
| Language | TypeScript with strict type checking |
| Email | Gmail API via `googleapis` |
| Calendar | Google Calendar API via `googleapis` |
| Chat and model generation | OpenRouter |
| Chat and human approval | `discord.js` |
| Persistence | SQLite via `better-sqlite3` |
| Database access | Raw SQL and migrations |
| Logging | Pino with `pino-pretty` for local development |
| Configuration | Environment variables |
| Local scheduling | Polling worker |

## Architecture

Business rules are kept separate from external services. Gmail, OpenRouter, Discord, and SQLite implement application-owned interfaces, allowing their implementations to change without rewriting the core workflow.

The project structure is:

```text
Billy/
├── src/
│   ├── config/
│   │   ├── env.ts
│   │   └── logger.ts
│   ├── core/
│   │   ├── assistant-conversation-workflow.ts
│   │   ├── career-profile-loader.ts
│   │   ├── email-processor.ts
│   │   ├── approval-workflow.ts
│   │   └── scheduling-workflow.ts
│   ├── integrations/
│   │   ├── discord/      # Shared runtime, assistant, and approval features
│   │   ├── gmail/
│   │   ├── google/
│   │   └── openrouter/
│   ├── database/
│   │   ├── connection.ts
│   │   ├── migrations/
│   │   └── repositories/
│   ├── jobs/
│   │   ├── gmail-poller.ts
│   │   └── email-sender.ts
│   ├── interfaces/       # Application-owned provider and repository contracts
│   ├── prompts/          # Standalone model policies
│   └── index.ts
├── profile/
│   ├── career.json
│   └── career.example.json
├── scripts/
│   ├── discord/
│   └── google/
├── data/
├── docs/
├── .env.example
├── package.json
└── tsconfig.json
```

`src/index.ts` acts as the composition root: it loads configuration, constructs the concrete integrations and repositories, and injects them into the core services.

## Draft lifecycle

Each email is persisted under an explicit state:

```text
discovered -> drafting -> awaiting_approval -> approved -> sending -> sent
                    |              |               |
                    v              v               v
                  failed        rejected         failed
                                   |
                                   v
                                 expired
```

State transitions must be conditional and atomic. Provider message IDs are unique, approvals can only be accepted once, and sending must be idempotent so retries or process crashes cannot produce duplicate replies.

## Safety requirements

These are part of the minimum viable application rather than optional hardening:

- Only explicitly configured Discord user IDs may approve drafts.
- Incoming email and quoted message content are treated as untrusted input.
- Email content cannot override system instructions or authorize actions.
- Every Gmail message is processed at most once.
- Overlapping polling runs are prevented.
- Replies preserve Gmail thread information and standard reply headers.
- Assistant input context is bounded; email, classification, and scheduling
  completions retain output limits and all OpenRouter calls retain timeouts.
- Main-chat output is intentionally uncapped during the initial one-month usage
  study. Provider-reported tokens and cost are stored for measurement.
- Career profile contact details are excluded from model prompts by default.
- Career context is only loaded for high-confidence recruiter opportunities and qualification questions.
- Low-confidence classifications cannot silently suppress email or unlock profile context.

Routing uses action-specific confidence thresholds:

- Career context requires `0.80` confidence.
- Interview scheduling notices require `0.85` confidence.
- Silent ignoring of job alerts, advertisements, and scams requires `0.95` confidence.

Classifications below the threshold for their action continue through normal drafting without career context.

- Sending failures use bounded retries and remain visible for manual recovery.
- Attachments are ignored unless support is deliberately added later.
- Logs avoid credentials and unnecessary email content.

## Getting started

### Prerequisites

- A supported Node.js LTS release
- A Google Cloud OAuth client with access to the Gmail API — see the [Gmail API integration guide](docs/guides/google/gmail-api-integration.md)
- Read access to the configured Google calendars — see the [Google Calendar API setup guide](docs/guides/google/google-calendar-api-integration.md)
- An OpenRouter API key
- A Discord application and bot — see the [Discord bot and approval channel guide](docs/guides/discord/discord-bot-setup.md)

### Install

```bash
npm install
```

### Configure

Copy `.env.example` to an uncommitted `.env` file and replace the angle-bracketed examples with real values.

```dotenv
GOOGLE_CLIENT_ID=<your-google-client-id>
GOOGLE_CLIENT_SECRET=<your-google-client-secret>
GOOGLE_REFRESH_TOKEN=<your-google-refresh-token>
GMAIL_USER_ID=<me>
GMAIL_OWN_ADDRESSES=<blawsonhq@gmail.com>
GMAIL_TRUSTED_FORWARDER_ADDRESSES=<your-personal-email@example.com>

GOOGLE_CALENDAR_SHARED_IDS=<personal-calendar-id>,<another-shared-calendar-id>
GOOGLE_CALENDAR_BILLY_ID=<billy-calendar-id>
SCHEDULING_TIME_ZONE=<America/Chicago>
SCHEDULING_WORKDAY_START_HOUR=<9>
SCHEDULING_WORKDAY_END_HOUR=<18>
SCHEDULING_DEFAULT_DURATION_MINUTES=<30>
SCHEDULING_BUFFER_AFTER_MINUTES=<15>
SCHEDULING_SEARCH_BUSINESS_DAYS=<10>

OPENROUTER_API_KEY=<your-openrouter-api-key>
OPENROUTER_MODEL=<provider/model-name>
OPENROUTER_CLASSIFIER_MODEL=<provider/cheap-model-name>
OPENROUTER_ASSISTANT_MODEL=<google/gemini-flash-latest>
OPENROUTER_TIMEOUT_MS=<30000>
OPENROUTER_DRAFT_REASONING_EFFORT=<medium>
OPENROUTER_CLASSIFIER_REASONING_EFFORT=<low>
OPENROUTER_ASSISTANT_REASONING_EFFORT=<low>
OPENROUTER_MAX_OUTPUT_TOKENS=<3000>
OPENROUTER_CLASSIFIER_MAX_OUTPUT_TOKENS=<500>
OPENROUTER_SCHEDULING_MAX_OUTPUT_TOKENS=<1000>

DISCORD_BOT_TOKEN=<your-discord-bot-token>
BILLY_ASSISTANT_ENABLED=<true>
DISCORD_MAIN_CHANNEL_ID=<your-discord-channel-id>
DISCORD_OWNER_USER_ID=<your-discord-user-id>
DISCORD_EMAIL_CHANNEL_ID=<your-discord-channel-id>
DISCORD_APPROVER_USER_IDS=<user-id-1,user-id-2>

DATABASE_PATH=<./data/billy.sqlite>
PROFILE_CAREER_PATH=<./profile/career.json>
GMAIL_POLL_INTERVAL_SECONDS=<60>
GMAIL_SEND_INTERVAL_SECONDS=<2>
LOG_LEVEL=<info>
```

The angle-bracketed values are examples. Remove the brackets when creating `.env`.

The main assistant defaults to `google/gemini-flash-latest` and does not set an
output-token cap. OpenRouter-reported input, output, reasoning, and cost data is
stored locally; send `assistant usage` in the main Discord channel to see the
last 30 days and lifetime totals.

### Use the main assistant

When `DISCORD_MAIN_CHANNEL_ID` and `DISCORD_OWNER_USER_ID` are configured,
Billy responds to that owner in the main channel without requiring a mention.
The assistant stores complete exchanges locally but sends only a bounded context
to OpenRouter: up to 20 recent turns, a small durable-memory section, and up to
five relevant older excerpts found with SQLite FTS5.

These commands are handled locally without an OpenRouter request:

- `remember that my server runs Debian`
- `what do you remember?`
- `what do you remember about my server?`
- `forget memory 3`
- `forget that my server runs Debian`
- `reset our conversation`
- `assistant usage`

Reset starts a fresh recent-context window without deleting saved memories or
searchable history. Billy retains messages it receives after this feature is
installed; it does not backfill older Discord channel history.

`.env` is ignored by Git, as is everything in `SECRETS/`. Only `.env.example` is committed.

### Generate a Gmail refresh token

Billy polls Gmail with no user present, so it needs an offline-access refresh token. Download the OAuth client JSON from Google Cloud to `SECRETS/credentials-google-Billy-local.json`, then run:

```bash
node scripts/google/generate-gmail-refresh-token.mjs
```

The browser consent flow opens, and the script prints the token to copy into `GOOGLE_REFRESH_TOKEN`. While the OAuth app is in Testing, Google expires the authorization after seven days; rerun the script to get a new token. The client ID and secret stay the same.

### Create the career profile

`PROFILE_CAREER_PATH` points at a file that is not in the repository — `profile/` is gitignored apart from the example. Copy it and fill in real details:

```bash
cp profile/career.example.json profile/career.json
```

The loader requires `schemaVersion: 1` and rejects a malformed profile at startup. Contact details are excluded from model prompts by default, and the profile is only loaded for high-confidence recruiter opportunities and qualification questions.

### Verify credentials

Both scripts read the values from `.env` and fail loudly if something is missing or unauthorized:

```bash
node scripts/google/verify-gmail-credentials.mjs
node scripts/discord/verify-discord-credentials.mjs
```

### Development commands

```bash
# Run in watch mode
npm run dev

# Check TypeScript types
npm run typecheck

# Run automated tests
npm test

# Compile to dist/
npm run build

# Run compiled output
npm start
```

Tests use Node's built-in test runner through `tsx` and do not call live Gmail, OpenRouter, or Discord services.

When OpenRouter exhausts its automatic retries, Billy publishes a Discord failure card with a safe reason and an authorized **Retry Generation** button. Approved draft cards are updated from queued to sending and finally to sent or failed using SQLite as the persistent source of truth.

Billy stores each classification on the email record alongside Gmail's `threadId`. The latest classification from the same Gmail thread is supplied as context when classifying a follow-up; the current message is still classified independently because a recruiting conversation can move from an opportunity to scheduling or rejection.

Actionable email is represented by one compact parent card per Gmail thread. The card shows the subject, a factual one-sentence summary, and current status; its **Open thread** button leads to the full incoming messages, generated drafts, scheduling cards, and approval controls. Write revision instructions directly in that thread to generate a new immutable draft revision.

Professional scheduling emails query the Billy calendar and every calendar listed in `GOOGLE_CALENDAR_SHARED_IDS`. Date-only questions create a new availability card restricted to that date, while exact free times go directly to an approval draft and busy times show nearby same-day choices. Earlier availability cards retain their original choices while the reviewer explores alternatives, and every selection is rechecked before a draft is generated or sent. Reviewers can write clarifications in the thread or select **Do not reply** to close a scheduling request.

After an approved scheduling reply is sent, Billy waits for the recruiter in the same Gmail thread. A confirmation produces a separate Google Calendar event proposal; a counterproposal returns to availability selection instead of restarting the email as an unrelated request. Write requested calendar changes in the Discord thread; Billy rechecks availability and publishes a new proposal. Creating, updating, deleting, or rejecting a proposed change requires an explicit Discord action. Events are written only to `GOOGLE_CALENDAR_BILLY_ID`, contain no recruiter attendee, and use Google Calendar's `sendUpdates: none` behavior.

## Roadmap

### Implemented foundation

- Connect Gmail, OpenRouter, Discord, and SQLite.
- Review and send Gmail drafts through Discord.
- Coordinate scheduling and approve Google Calendar changes.
- Run an owner-only Discord assistant with persistent searchable memory.
- Track assistant token usage and provider-reported cost.

### Next personal-assistant phases

- Add bounded-horizon weather lookup.
- Add daily priority briefs, reminders, and persistent tasks.
- Add image generation in the main chat.
- Add summaries or embeddings only if structured memory and FTS5 retrieval prove
  insufficient.

See the [personal-assistant roadmap](docs/plans/billy-personal-assistant-roadmap.md)
for phase boundaries and acceptance criteria.

### Operational hardening

- Improve observability and recovery tools.
- Add retention and content-redaction controls.
- Expand automated integration and failure-path testing.
- Refine approval editing and policy controls.

### Optional AWS deployment

- Replace local polling with EventBridge scheduling.
- Replace Discord Gateway handling with HTTPS interactions.
- Replace SQLite with an AWS-compatible persistent store.
- Package entrypoints as Lambda handlers while retaining the application core.

AWS infrastructure, containers, and additional frameworks are intentionally deferred until the local end-to-end workflow is reliable.

## Design notes

The original architecture discussion is in [`docs/design.md`](docs/design.md).

Setup guides:

- [Gmail API integration](docs/guides/google/gmail-api-integration.md)
- [Discord bot and approval channel](docs/guides/discord/discord-bot-setup.md)
- [DBeaver database viewer](docs/guides/dbeaver/dbeaver-setup.md)

