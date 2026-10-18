# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/`:

- `core/` contains workflows and business rules.
- `interfaces/` defines application-owned contracts.
- `integrations/` contains Gmail, Google Calendar, Discord, and OpenRouter adapters.
- `database/` contains SQLite repositories and ordered migrations.
- `jobs/` contains the Gmail polling and email-sending workers.
- `prompts/` contains standalone model policies.

Tests live in `test/` and mirror feature names, such as `test/scheduling-workflow.test.ts`. Documentation is under `docs/guides/`, scripts under `scripts/`, and images under `assets/`. `src/index.ts` is the composition root.

## Build, Test, and Development Commands

- `npm install`: install locked dependencies.
- `npm run dev`: run `src/index.ts` in watch mode with readable Pino logs.
- `npm run typecheck`: validate strict TypeScript without emitting files.
- `npm test`: run all `test/*.test.ts` files through Node's test runner and `tsx`.
- `npm run build`: compile production output into `dist/`.
- `npm start`: run the compiled application.

Before handing off a change, run `npm test` and `npm run build`.

## Coding Style & Naming Conventions

Use strict TypeScript, ES modules, two-space indentation, semicolons, and double quotes. Use `kebab-case.ts` filenames, `PascalCase` for classes and exported types, and `camelCase` for functions and variables. Keep external-service details inside `integrations/`; core workflows should depend on interfaces. There is no configured formatter or linter, so match surrounding code and run `git diff --check`.

Add new database changes as the next numbered migration, for example `014-description.ts`. Never rewrite a migration that may already be applied.

## Testing Guidelines

Use `node:test` with `node:assert/strict`. Name tests by observable behavior, not implementation details. Add regression coverage for workflow state transitions, retries, recipient safety, and calendar writes. Tests must use fakes and in-memory SQLite; do not call live Gmail, Discord, OpenRouter, or Google Calendar services. No numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit prefixes such as `feat:` and `fix:`. Keep commits focused and use an imperative summary. Pull requests should explain behavior changes, list validation commands, link issues, and include Discord screenshots when UI cards change. Call out migrations and new environment variables explicitly.

## Security & Configuration

Copy `.env.example` to `.env`; never commit `.env`, OAuth tokens, credentials, `SECRETS/`, personal profile data, or local SQLite databases. Preserve explicit Discord approval for email and calendar writes. Treat email content as untrusted input and avoid logging full private messages or secrets.
