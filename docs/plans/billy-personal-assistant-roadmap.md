# Billy Personal Assistant Roadmap

## Summary

Expand Billy from an email assistant into an owner-only Discord personal
assistant with:

- Conversational access in a dedicated main channel.
- Weather forecasts for today, the week, and supported future dates.
- One-time and recurring reminders.
- Persistent to-do management.
- A scheduled daily briefing with a suggested priority list.
- Image generation through OpenRouter.

Keep the existing Gmail, scheduling, calendar, and approval behavior intact.
Deliver each phase independently behind configuration so partially completed
features do not disrupt the email workflow.

## Phase 0 — Discord and Assistant Foundation

**Status:** Implemented on 2026-10-21.

- Refactor Discord lifecycle ownership so one runtime logs in, shuts down, and
  dispatches events to both the existing email workflow and the new assistant
  workflow.
- Keep email interactions restricted to their existing threads and route
  assistant messages only from `DISCORD_MAIN_CHANNEL_ID`.
- Add `DISCORD_OWNER_USER_ID`; ignore assistant requests from any other user
  even though the Discord server is private.
- Introduce a general assistant model interface supporting conversational
  responses and structured tool calls.
- Retain complete conversation history across restarts while sending only a
  token-bounded recent window to the model.
- Add local SQLite full-text retrieval, explicit durable-memory commands, and
  provider-reported usage/cost tracking. A reset starts a new recent-context
  window without deleting searchable history or saved memories.
- Deduplicate incoming Discord messages by message ID and prevent Billy from
  responding to bots or its own messages.
- Keep assistant functionality disabled unless its required configuration is
  present, preserving email-only startup compatibility.

### Phase 0 acceptance criteria

- Billy responds only to the configured owner in the configured main channel.
- Email approval cards and scheduling threads continue to work unchanged.
- Restarts preserve the latest conversation context without causing duplicate
  replies.

## Phase 1 — Main Chat and Weather

- Respond to every owner-authored message in the configured main channel
  without requiring a mention or slash command.
- Add an OpenRouter assistant adapter using a separately configurable model,
  system policy, and timeout. Initially leave assistant output uncapped while
  measuring one month of actual provider-reported usage and cost.
- Add a `WeatherProvider` interface and an Open-Meteo implementation with:
  - A configured default home location.
  - Per-request location overrides.
  - Geocoding and short-lived location caching.
  - Daily high/low temperature, conditions, precipitation probability, and
    wind.
- Resolve relative dates using Billy’s configured timezone.
- Request only dates supported by the provider. Open-Meteo currently documents
  forecasts of up to 16 days. For a date outside the returned horizon, reply
  clearly: “I’m not able to access forecast data that far ahead.” Billy must
  never invent an extended forecast.
- Use Discord typing indicators and split long text safely across Discord
  messages.
- Provide clear fallback responses for ambiguous locations, unavailable
  forecasts, model failures, and timeouts.

Reference: [Open-Meteo forecast documentation](https://open-meteo.com/en/docs)

### Phase 1 acceptance criteria

- Billy can answer general chat messages in the main channel.
- Billy can summarize today, a requested day, a week, or a supported future
  weather range for the default or an explicitly requested location.
- Out-of-range requests return the documented limitation instead of a guessed
  forecast.

## Phase 2 — To-Dos and Reminders

### To-dos

- Add natural-language tools for creating, listing, viewing, editing,
  completing, reopening, and deleting to-dos.
- Store each task with:
  - Title and optional description.
  - Creation and update timestamps.
  - Optional due date/time and timezone.
  - Status: `todo`, `in_progress`, `completed`, or `cancelled`.
  - Optional manual priority: `low`, `normal`, `high`, or `urgent`.
  - Completion timestamp populated only while completed.
- Allow undated backlog tasks; never silently default an omitted due date to
  today.
- Ask a follow-up instead of writing an incomplete or ambiguous task. Otherwise,
  authorized changes happen immediately and Billy confirms the stored result.

### Reminders

- Add natural-language reminder creation, listing, editing, cancellation, and
  completion.
- Support one-time, daily, weekly, and monthly reminders.
- Calculate recurrence in the reminder’s local timezone so daylight-saving
  changes preserve the requested wall-clock time.
- Require every reminder to resolve to a definite first delivery time. Ask a
  follow-up when the schedule is ambiguous.
- Deliver reminders only to the separately configured reminders channel.
- Use durable occurrence records and atomic claims so restarts or overlapping
  polling cycles cannot deliver the same occurrence twice.
- For a monthly date that does not exist in a given month, deliver on that
  month’s final day and return to the requested day in later months.

### Phase 2 acceptance criteria

- Natural-language requests can manage the full task and reminder lifecycle.
- Task and reminder writes do not require approval buttons.
- Restarting Billy does not lose records or duplicate reminder deliveries.
- Reminder messages appear only in the dedicated reminders channel.

## Phase 3 — Daily Briefing

- Add a restart-safe daily briefing job, defaulting to `06:00` in Billy’s
  configured timezone.
- Publish the briefing to a dedicated daily-brief channel, separate from the
  main and reminder channels.
- Build the brief from:
  - Overdue and due-today tasks.
  - High/urgent undated tasks.
  - Today’s configured Google Calendar events.
  - Reminders scheduled for that day.
- Generate a suggested ordered priority list using urgency, due dates, manual
  priority, calendar constraints, and overdue status.
- Do not overwrite stored task priorities when producing daily suggestions.
- Include a deterministic summary fallback when OpenRouter is unavailable.
- Record one briefing per local calendar date. If Billy missed 6:00 AM, send
  one catch-up after restart only when it is still before the default noon
  cutoff.
- Clearly distinguish calendar commitments, tasks, and reminders in the
  Discord message.

### Phase 3 acceptance criteria

- Exactly one briefing is posted per eligible local day.
- The briefing appears only in the daily-brief channel.
- Billy catches up after a morning restart but does not send a stale brief
  after the cutoff.
- An OpenRouter outage still produces a useful deterministic briefing.

## Phase 4 — Image Generation

- Recognize explicit requests such as “generate,” “create,” or “draw an image”
  in the main chat. Ordinary conversation must not accidentally incur image
  generation costs.
- Add an `ImageProvider` interface and OpenRouter image adapter using a separate
  `OPENROUTER_IMAGE_MODEL`.
- Use OpenRouter’s dedicated image-generation endpoint, return one image per
  request initially, and upload the decoded image directly to Discord without
  permanent local storage.
- Apply a single-generation concurrency limit and configurable owner cooldown.
- Show a short prompt summary with the result while excluding raw base64 data,
  credentials, and private conversation content from logs.
- Return actionable errors for moderation rejection, unsupported model
  parameters, provider failure, timeout, or Discord attachment rejection.

Reference: [OpenRouter image-generation documentation](https://openrouter.ai/blog/tutorials/image-generation/)

### Phase 4 acceptance criteria

- Explicit image requests produce one Discord attachment in the main channel.
- Non-image conversation never calls the image endpoint.
- Generated files are not retained after delivery, and logs never contain image
  data.

## Phase 5 — Hardening and Documentation

- Add structured logs for feature, operation, duration, provider/model, and
  outcome without logging complete chat messages, reminder text, task
  descriptions, or image data.
- Add retry policies only for safe provider reads and idempotent scheduled
  deliveries.
- Document Discord channel creation and permissions for:
  - Main chat.
  - Reminders.
  - Daily brief.
- Update `.env.example`, README architecture, setup instructions, and this
  roadmap’s completion checklist.
- Run the full existing email/scheduling suite after each phase to catch
  Discord runtime regressions.

## Interfaces, Persistence, and Configuration

Add application-owned interfaces for:

- Assistant conversation and model execution.
- Weather lookup and geocoding.
- Chat-history, task, reminder, reminder-occurrence, and daily-brief
  repositories.
- Image generation.
- Clock and scheduler behavior so time-based workflows remain deterministic in
  tests.

Add ordered migrations beginning with `015`; never modify migrations `001`
through `014`. New tables should cover assistant messages, tasks, reminders,
reminder occurrences, and daily briefing deliveries. Use unique Discord message
IDs and unique `(reminder_id, scheduled_for)` and briefing-date constraints for
idempotency.

New configuration should include:

- `BILLY_ASSISTANT_ENABLED`
- `DISCORD_OWNER_USER_ID`
- `DISCORD_MAIN_CHANNEL_ID`
- `DISCORD_REMINDERS_CHANNEL_ID`
- `DISCORD_DAILY_BRIEF_CHANNEL_ID`
- `ASSISTANT_TIME_ZONE`, defaulting to the existing scheduling timezone
- `OPENROUTER_ASSISTANT_MODEL`
- `WEATHER_DEFAULT_LOCATION`
- `DAILY_BRIEF_TIME`, defaulting to `06:00`
- `DAILY_BRIEF_CATCH_UP_CUTOFF`, defaulting to `12:00`
- `OPENROUTER_IMAGE_MODEL`
- Image timeout and cooldown settings

## Test and Validation Plan

- Verify channel and owner filtering, duplicate Discord-event handling, bounded
  history, reset behavior, response pagination, and clean shutdown.
- Verify weather date interpretation, default/override locations, daily and
  weekly summaries, exact forecast-horizon handling, malformed responses, and
  provider outages.
- Verify all task state transitions, optional due dates, priority handling,
  completed timestamps, ambiguous-request clarification, and immediate mutation
  confirmations.
- Verify one-time and recurring reminders across restarts, daylight-saving
  transitions, month-end dates, cancellations, retries, and duplicate-delivery
  races.
- Verify the daily brief runs once at 6:00 AM, catches up before noon, skips
  after noon, reads all configured sources, ranks tasks without mutating them,
  and falls back when AI generation fails.
- Verify image request routing, base64 decoding, Discord upload behavior,
  cooldown/concurrency enforcement, and sanitized provider failures.
- Use fakes, an in-memory SQLite database, and injected clocks. Tests must not
  call live Discord, OpenRouter, Open-Meteo, Gmail, or Google Calendar services.
- Before each phase is handed off, run `npm test`, `npm run build`, and
  `git diff --check`.

## Assumptions and Defaults

- Billy is a single-owner assistant, even if additional people later gain
  access to the Discord server.
- Main chat, reminder output, and daily briefing use three separately configured
  Discord channels.
- Natural language is the primary interface; slash commands are not required
  for the first version.
- Reminder and task writes do not require approval buttons.
- Complete chat history is stored locally in SQLite. Model requests use up to
  20 recent turns plus a small set of relevant FTS excerpts and durable
  memories, all under separate input-context budgets.
- Conversation summaries and embeddings remain deferred until observed usage
  shows that structured memory and SQLite full-text retrieval are insufficient.
- The default forecast provider is Open-Meteo, with the usable horizon
  determined from each provider response rather than assumed by the model.
- Tasks may omit due dates, while reminders must have a definite first delivery
  time.
- Image generation produces one image per request through OpenRouter and does
  not retain image files after Discord delivery.
- Existing uncommitted repository changes must be preserved while implementing
  this roadmap.
