import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";

import type {
  CalendarEvent,
  CalendarEventWrite,
  CalendarProvider,
  CreatedCalendarEvent,
} from "../../interfaces/calendar-provider.js";
import { createGmailAuth } from "../gmail/auth.js";
import type { GmailAuthConfig } from "../gmail/auth.js";

export interface GoogleCalendarDefinition {
  id: string;
  label?: string;
}

interface ResolvedGoogleCalendarDefinition {
  id: string;
  label: string;
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly #calendar: calendar_v3.Calendar;
  readonly #calendars: readonly GoogleCalendarDefinition[];
  readonly #writableCalendarId: string;
  readonly #calendarLabels = new Map<string, Promise<string>>();

  constructor(
    auth: GmailAuthConfig,
    calendars: readonly GoogleCalendarDefinition[],
    writableCalendarId = calendars[0]?.id,
  ) {
    if (calendars.length < 1 || calendars.some((item) => !item.id.trim())) {
      throw new Error("At least one Google calendar ID is required");
    }
    this.#calendar = google.calendar({
      version: "v3",
      auth: createGmailAuth(auth),
    });
    this.#calendars = calendars;
    if (!writableCalendarId?.trim()) {
      throw new Error("A writable Google calendar ID is required");
    }
    this.#writableCalendarId = writableCalendarId;
  }

  async listEvents(
    timeMin: Date,
    timeMax: Date,
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]> {
    if (signal?.aborted) throw new Error("Calendar query was cancelled");
    const results = await Promise.all(
      this.#calendars.map((calendar) =>
        this.#listCalendar(calendar, timeMin, timeMax, signal),
      ),
    );
    return results.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  async createEvent(
    input: CalendarEventWrite,
    signal?: AbortSignal,
  ): Promise<CreatedCalendarEvent> {
    if (signal?.aborted) throw new Error("Calendar event creation was cancelled");
    const response = await this.#calendar.events.insert({
      calendarId: this.#writableCalendarId,
      sendUpdates: "none",
      requestBody: buildGoogleCalendarEventBody(
        input,
        deterministicGoogleEventId(input.requestId),
      ),
    });
    if (!response.data.id) throw new Error("Google Calendar returned no event ID");
    return {
      providerEventId: response.data.id,
      htmlLink: response.data.htmlLink ?? null,
    };
  }

  async updateEvent(
    providerEventId: string,
    input: CalendarEventWrite,
    signal?: AbortSignal,
  ): Promise<CreatedCalendarEvent> {
    if (signal?.aborted) throw new Error("Calendar event update was cancelled");
    const response = await this.#calendar.events.patch({
      calendarId: this.#writableCalendarId,
      eventId: providerEventId,
      sendUpdates: "none",
      requestBody: buildGoogleCalendarEventBody(input),
    });
    return {
      providerEventId: response.data.id ?? providerEventId,
      htmlLink: response.data.htmlLink ?? null,
    };
  }

  async deleteEvent(providerEventId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Calendar event deletion was cancelled");
    await this.#calendar.events.delete({
      calendarId: this.#writableCalendarId,
      eventId: providerEventId,
      sendUpdates: "none",
    });
  }

  async #listCalendar(
    definition: GoogleCalendarDefinition,
    timeMin: Date,
    timeMax: Date,
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]> {
    const resolvedDefinition = await this.#resolveDefinition(definition);
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      if (signal?.aborted) throw new Error("Calendar query was cancelled");
      const response = await this.#calendar.events.list({
        calendarId: definition.id,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
        maxResults: 2500,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of response.data.items ?? []) {
        const mapped = mapEvent(item, resolvedDefinition);
        if (mapped) events.push(mapped);
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return events;
  }

  async #resolveDefinition(
    definition: GoogleCalendarDefinition,
  ): Promise<ResolvedGoogleCalendarDefinition> {
    if (definition.label?.trim()) {
      return { id: definition.id, label: definition.label.trim() };
    }

    let label = this.#calendarLabels.get(definition.id);
    if (!label) {
      label = this.#calendar.calendars
        .get({ calendarId: definition.id })
        .then((response) => response.data.summary?.trim() || definition.id);
      this.#calendarLabels.set(definition.id, label);
    }

    return { id: definition.id, label: await label };
  }
}

export function buildGoogleCalendarEventBody(
  input: CalendarEventWrite,
  id?: string,
): calendar_v3.Schema$Event {
  return {
    ...(id ? { id } : {}),
    summary: input.title,
    description: input.description,
    start: { dateTime: input.start, timeZone: input.timeZone },
    end: { dateTime: input.end, timeZone: input.timeZone },
    attendees: [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 24 * 60 },
        { method: "popup", minutes: 60 },
        { method: "popup", minutes: 30 },
      ],
    },
  };
}

function deterministicGoogleEventId(requestId: string): string {
  const normalized = requestId.toLowerCase().replaceAll(/[^a-v0-9]/g, "");
  return (`billi${normalized}`.slice(0, 1024) || "billievent").padEnd(8, "0");
}

function mapEvent(
  item: calendar_v3.Schema$Event,
  calendar: ResolvedGoogleCalendarDefinition,
): CalendarEvent | null {
  if (
    item.status === "cancelled" ||
    item.transparency === "transparent" ||
    item.attendees?.some(
      (attendee) =>
        attendee.self === true && attendee.responseStatus === "declined",
    )
  ) {
    return null;
  }

  const allDay = Boolean(item.start?.date);
  const startValue = item.start?.dateTime ?? item.start?.date;
  const endValue = item.end?.dateTime ?? item.end?.date;
  if (!startValue || !endValue) return null;
  const start = new Date(allDay ? `${startValue}T00:00:00.000Z` : startValue);
  const end = new Date(allDay ? `${endValue}T00:00:00.000Z` : endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  return {
    calendarId: calendar.id,
    calendarLabel: calendar.label,
    providerEventId: item.id ?? `${calendar.id}:${startValue}`,
    title: item.summary?.trim() || "Busy",
    start,
    end,
    allDay,
    allDayDate: allDay ? item.start?.date ?? null : null,
  };
}
