I think that's the right approach. Build locally first, but structure the application so migrating to AWS Lambda later won't require rewriting the core logic.

We'll keep your Phase 1 architecture as agreed.

## Phase 1 — Local Development

| Component        | Technology                          |
| ---------------- | ----------------------------------- |
| Runtime          | Node.js LTS                         |
| Language         | TypeScript (strict)                 |
| LLM              | OpenRouter                          |
| Email            | Gmail API +`googleapis`           |
| Discord          | `discord.js`                      |
| Database         | SQLite +`better-sqlite3`          |
| Queries          | Raw SQL (no ORM)                    |
| Email monitoring | Scheduled polling                   |
| Configuration    | `.env`                            |
| Logging          | Pino +`pino-pretty`               |
| Development      | Local machine                       |
| Deployment       | AWS Lambda (potential future phase) |

## One architectural decision I'd make now

I'd separate your business logic from infrastructure.

That means your Gmail processing, AI drafting, and approval workflow shouldn't depend directly on whether the application is running locally or on Lambda.

### Suggested project structure

```
email-assistant/
├── src/
│   ├── config/
│   │   ├── env.ts
│   │   └── logger.ts
│   │
│   ├── core/
│   │   ├── email-processor.ts
│   │   ├── draft-generator.ts
│   │   └── approval-workflow.ts
│   │
│   ├── integrations/
│   │   ├── gmail/
│   │   ├── openrouter/
│   │   └── discord/
│   │
│   ├── database/
│   │   ├── connection.ts
│   │   ├── migrations/
│   │   └── repositories/
│   │
│   ├── jobs/
│   │   └── gmail-poller.ts
│   │
│   ├── interfaces/
│   │   ├── email-provider.ts
│   │   ├── ai-provider.ts
│   │   └── approval-repository.ts
│   │
│   └── index.ts
│
├── data/
├── .env
├── .env.example
├── package.json
└── tsconfig.json
```

The `interfaces/` directory is especially helpful for future migration.

For example, your application could use this interface:

```
interface ApprovalRepository {
  getPending(id: string): Promise<EmailDraft | null>;
  save(draft: EmailDraft): Promise<void>;
  approve(id: string): Promise<boolean>;
}
```

Initially, SQLite implements it. If you eventually migrate to DynamoDB, we replace the implementation without rewriting the approval workflow.

There are two other pieces worth isolating for Lambda compatibility: the Gmail polling scheduler and Discord interaction handling. Today those run locally; later they could become EventBridge triggers and HTTP-based Discord interactions.

One important caveat: Lambda migration would still involve infrastructure work, particularly replacing SQLite and adapting Discord's Gateway interactions to HTTP. We're designing to minimize that work, not pretending it disappears entirely.

## Development roadmap

Phase 1 — Working local application

Connect Gmail, OpenRouter, and Discord. Generate drafts, receive approvals, and send replies. Persist states in SQLite.

Phase 2 — Reliability and safety

Add duplicate prevention, robust retries, recovery after crashes, approval expiration, AI cost limits, and automated tests.

Phase 3 — Optional AWS Lambda deployment

Move scheduling to EventBridge, approval interactions to HTTPS, and persistent storage to an AWS-compatible database.

I'd lock in this architecture and begin with the local application. There's no need to add AWS infrastructure, Docker, or more frameworks at this stage. The first goal is a complete Gmail → OpenRouter → Discord approval → Gmail reply workflow running successfully on your machine.
