import assert from "node:assert/strict";
import test from "node:test";

import { buildGoogleCalendarEventBody } from "../src/integrations/google/calendar-provider.js";

test("Google Calendar events use three popup reminders and no email reminders", () => {
  const event = buildGoogleCalendarEventBody({
    requestId: "interview-reminders",
    title: "Recruiter interview",
    description: "Confirmed interview.",
    start: "2026-10-21T18:00:00.000Z",
    end: "2026-10-21T18:30:00.000Z",
    timeZone: "America/Chicago",
  });

  assert.deepEqual(event.reminders, {
    useDefault: false,
    overrides: [
      { method: "popup", minutes: 1_440 },
      { method: "popup", minutes: 60 },
      { method: "popup", minutes: 30 },
    ],
  });
  assert.equal(
    event.reminders?.overrides?.some((reminder) => reminder.method === "email"),
    false,
  );
});
