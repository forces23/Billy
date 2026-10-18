export interface CalendarEvent {
  calendarId: string;
  calendarLabel: string;
  providerEventId: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  allDayDate: string | null;
}

export interface CalendarProvider {
  listEvents(
    timeMin: Date,
    timeMax: Date,
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]>;
  createEvent(
    input: CalendarEventWrite,
    signal?: AbortSignal,
  ): Promise<CreatedCalendarEvent>;
  updateEvent(
    providerEventId: string,
    input: CalendarEventWrite,
    signal?: AbortSignal,
  ): Promise<CreatedCalendarEvent>;
  deleteEvent(providerEventId: string, signal?: AbortSignal): Promise<void>;
}

export interface CalendarEventWrite {
  requestId: string;
  title: string;
  description: string;
  start: string;
  end: string;
  timeZone: string;
}

export interface CreatedCalendarEvent {
  providerEventId: string;
  htmlLink: string | null;
}
