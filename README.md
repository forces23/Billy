# Billy

Billy is a local-first AI email assistant that drafts replies to Gmail messages, sends those drafts to Discord for human review, and only sends an email after an authorized user approves it.

The initial goal is a dependable workflow running on a local machine. The application is structured so its core behavior can later move to AWS Lambda without being rewritten around AWS-specific services.

> **Project status:** The local Gmail → OpenRouter → Discord approval → Gmail reply workflow is implemented. Approved replies are queued in SQLite and sent by a dedicated worker.

## Intended workflow

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
    +---- interview scheduling ----------------> notify in Discord
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

Billy never intends to send an AI-generated reply without explicit approval.

## Technology

| Area | Technology |
| --- | --- |
| Runtime | Node.js LTS |
| Language | TypeScript with strict type checking |
| Email | Gmail API via `googleapis` |
| Draft generation | OpenRouter |
| Human approval | `discord.js` |
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
│   │   ├── career-profile-loader.ts
│   │   ├── email-processor.ts
│   │   └── approval-workflow.ts
│   ├── integrations/
│   │   ├── gmail/
│   │   ├── openrouter/
│   │   └── discord/
│   ├── database/
│   │   ├── connection.ts
│   │   ├── migrations/
│   │   └── repositories/
│   ├── jobs/
│   │   ├── gmail-poller.ts
│   │   └── email-sender.ts
│   ├── interfaces/
│   │   ├── email-provider.ts
│   │   ├── ai-provider.ts
│   │   └── approval-repository.ts
│   └── index.ts
├── profile/
│   ├── career.json
│   └── career.example.json
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
- Model calls have token, cost, and timeout limits.
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
- A Google Cloud OAuth client with access to the Gmail API
- An OpenRouter API key
- A Discord application and bot

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

OPENROUTER_API_KEY=<your-openrouter-api-key>
OPENROUTER_MODEL=<provider/model-name>
OPENROUTER_CLASSIFIER_MODEL=<provider/cheap-model-name>
OPENROUTER_TIMEOUT_MS=<30000>
OPENROUTER_DRAFT_REASONING_EFFORT=<medium>
OPENROUTER_CLASSIFIER_REASONING_EFFORT=<low>
OPENROUTER_MAX_OUTPUT_TOKENS=<3000>
OPENROUTER_CLASSIFIER_MAX_OUTPUT_TOKENS=<500>

DISCORD_BOT_TOKEN=<your-discord-bot-token>
# Optional until general-purpose Billy features are implemented.
DISCORD_MAIN_CHANNEL_ID=<your-discord-channel-id>
DISCORD_EMAIL_CHANNEL_ID=<your-discord-channel-id>
DISCORD_APPROVER_USER_IDS=<user-id-1,user-id-2>

DATABASE_PATH=<./data/billy.sqlite>
PROFILE_CAREER_PATH=<./profile/career.json>
GMAIL_POLL_INTERVAL_SECONDS=<60>
GMAIL_SEND_INTERVAL_SECONDS=<2>
LOG_LEVEL=<info>
```

The angle-bracketed values are examples. Remove the brackets when creating `.env`.

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

Billy stores each classification on the email record alongside Gmail's `threadId`. The latest classification from the same Gmail thread is supplied as context when classifying a follow-up; the current message is still classified independently because a recruiting conversation can move from an opportunity to interview scheduling or rejection.

Interview scheduling currently produces an informational Discord message and no reply draft. Calendar availability checks and Accept, Request another date, and Kindly deny actions are intentionally deferred; those future actions must always require Bobby's explicit confirmation.

## Roadmap

### Phase 1: safe local workflow

- Connect Gmail, OpenRouter, Discord, and SQLite.
- Poll for eligible Gmail messages.
- Generate and persist reply drafts.
- Approve, reject, expire, or regenerate drafts through Discord.
- Send approved direct replies in the original Gmail thread and forwarded replies as new messages to the resolved original recipients.
- Implement idempotency, bounded retries, and crash recovery.
- Add authorization, structured logging, cost limits, and core workflow tests.

### Phase 2: operational hardening

- Improve observability and recovery tools.
- Add retention and content-redaction controls.
- Expand automated integration and failure-path testing.
- Refine approval editing and policy controls.

### Phase 3: optional AWS deployment

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

