import assert from "node:assert/strict";
import test from "node:test";

import { AvailabilityService } from "../src/core/availability-service.js";
import type {
  CalendarEvent,
  CalendarProvider,
} from "../src/interfaces/calendar-provider.js";

function event(
  id: string,
  start: string,
  end: string,
  options: { allDay?: boolean; title?: string; calendar?: string } = {},
): CalendarEvent {
  return {
    calendarId: options.calendar ?? "personal",
    calendarLabel: options.calendar ?? "Personal",
    providerEventId: id,
    title: options.title ?? "Busy event",
    start: new Date(start),
    end: new Date(end),
    allDay: options.allDay ?? false,
    allDayDate: options.allDay ? start.slice(0, 10) : null,
  };
}

function service(events: readonly CalendarEvent[]): AvailabilityService {
  const provider: CalendarProvider = {
    async listEvents(timeMin, timeMax) {
      return events.filter(
        (item) => item.end > timeMin && item.start < timeMax,
      );
    },
  };
  return new AvailabilityService(provider, {
    timeZone: "America/Chicago",
    workdayStartHour: 9,
    workdayEndHour: 18,
    defaultDurationMinutes: 30,
    bufferAfterMinutes: 15,
    searchBusinessDays: 10,
  });
}

test("availability merges conflicts and enforces the post-meeting buffer", async () => {
  const availability = service([
    event(
      "business-conflict",
      "2026-03-16T15:00:00.000Z",
      "2026-03-16T15:30:00.000Z",
      { calendar: "Billy" },
    ),
  ]);
  const result = await availability.analyze(
    {
      summary: "Recruiter call",
      requestedDates: ["2026-03-16"],
      requestedTime: "09:30",
      timeZone: "America/Chicago",
      durationMinutes: 30,
    },
    new Date("2026-03-10T12:00:00.000Z"),
  );

  assert.equal(result.requestedSlotAvailable, false);
  assert.match(result.options[0]?.label ?? "", /9:00 AM/);
  assert.notEqual(
    result.options[0]?.start,
    "2026-03-16T14:30:00.000Z",
  );
});

test("all-day events are advisory and a date-only query stays on that date", async () => {
  const availability = service([
    event(
      "birthday",
      "2026-03-16T00:00:00.000Z",
      "2026-03-17T00:00:00.000Z",
      { allDay: true, title: "Jill's Birthday" },
    ),
  ]);
  const result = await availability.analyze(
    {
      summary: "Interview",
      requestedDates: ["2026-03-16"],
      requestedTime: null,
      timeZone: null,
      durationMinutes: 30,
    },
    new Date("2026-03-10T12:00:00.000Z"),
  );

  assert.deepEqual(result.advisories, [
    { date: "2026-03-16", titles: ["Jill's Birthday"] },
  ]);
  assert.match(result.options[0]?.label ?? "", /Mon, Mar 16/);
});

test("a proposed time without timezone requires clarification", async () => {
  const result = await service([]).analyze(
    {
      summary: "Screening call",
      requestedDates: ["2026-03-16"],
      requestedTime: "14:00",
      timeZone: null,
      durationMinutes: 30,
    },
    new Date("2026-03-10T12:00:00.000Z"),
  );

  assert.equal(result.timezoneRequired, true);
  assert.equal(result.requestedSlot, null);
  assert.equal(result.requestedSlotAvailable, false);
});

test("an unrecognized timezone is never treated as calendar-backed", async () => {
  const result = await service([]).analyze(
    {
      summary: "Screening call",
      requestedDates: ["2026-03-16"],
      requestedTime: "14:00",
      timeZone: "Recruiter/Local",
      durationMinutes: 30,
    },
    new Date("2026-03-10T12:00:00.000Z"),
  );

  assert.equal(result.timezoneRequired, true);
  assert.equal(result.requestedSlot, null);
});

test("availability handles the Central daylight-saving transition", async () => {
  const result = await service([]).analyze(
    {
      summary: "Post-DST interview",
      requestedDates: ["2026-03-09"],
      requestedTime: "09:00",
      timeZone: "America/Chicago",
      durationMinutes: 30,
    },
    new Date("2026-03-01T12:00:00.000Z"),
  );

  assert.equal(result.requestedSlot?.start, "2026-03-09T14:00:00.000Z");
  assert.equal(result.requestedSlotAvailable, true);
});

test("multiple availability options are spread across different days", async () => {
  const result = await service([]).analyze(
    {
      summary: "Interview availability",
      requestedDates: [],
      requestedTime: null,
      timeZone: null,
      durationMinutes: 45,
      availabilityOptionCount: 3,
    },
    new Date("2026-03-10T12:00:00.000Z"),
  );

  assert.equal(result.options.length, 3);
  assert.deepEqual(
    result.options.map((slot) => slot.start.slice(0, 10)),
    ["2026-03-10", "2026-03-11", "2026-03-12"],
  );
  assert.equal(
    new Date(result.options[0]!.end).getTime() -
      new Date(result.options[0]!.start).getTime(),
    45 * 60 * 1_000,
  );
});
