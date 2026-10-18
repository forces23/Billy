import { DateTime, Interval } from "luxon";

import type { CalendarEvent, CalendarProvider } from "../interfaces/calendar-provider.js";
import type {
  SchedulingAdvisory,
  SchedulingAnalysis,
  SchedulingSlot,
} from "../interfaces/scheduling-repository.js";
import type { SchedulingRequest } from "../interfaces/scheduling-interpreter.js";

export interface AvailabilityOptions {
  timeZone: string;
  workdayStartHour: number;
  workdayEndHour: number;
  defaultDurationMinutes: number;
  bufferAfterMinutes: number;
  searchBusinessDays: number;
  maximumOptions?: number;
}

export class AvailabilityService {
  readonly #calendarProvider: CalendarProvider;
  readonly #options: Required<AvailabilityOptions>;

  constructor(calendarProvider: CalendarProvider, options: AvailabilityOptions) {
    if (!DateTime.now().setZone(options.timeZone).isValid) {
      throw new Error(`Invalid scheduling timezone: ${options.timeZone}`);
    }
    if (
      options.workdayStartHour < 0 ||
      options.workdayEndHour > 24 ||
      options.workdayStartHour >= options.workdayEndHour
    ) {
      throw new Error("Scheduling working hours are invalid");
    }
    this.#calendarProvider = calendarProvider;
    this.#options = { ...options, maximumOptions: options.maximumOptions ?? 5 };
  }

  async analyze(
    request: SchedulingRequest,
    anchor: Date,
    signal?: AbortSignal,
  ): Promise<SchedulingAnalysis> {
    const duration = request.durationMinutes || this.#options.defaultDurationMinutes;
    const anchorLocal = DateTime.fromJSDate(anchor).setZone(this.#options.timeZone);
    const requestedFirstDate = request.requestedDates[0]
      ? DateTime.fromISO(request.requestedDates[0], { zone: this.#options.timeZone })
      : anchorLocal.startOf("day");
    if (!requestedFirstDate.isValid) {
      throw new Error("Scheduling request contains an invalid date");
    }
    const firstDate = requestedFirstDate < anchorLocal.startOf("day")
      ? anchorLocal.startOf("day")
      : requestedFirstDate;

    const requestedHasTime = request.requestedTime !== null;
    const requestedZoneValid = request.timeZone !== null &&
      DateTime.now().setZone(request.timeZone).isValid;
    const timezoneRequired = requestedHasTime && !requestedZoneValid;
    const explicitDates = request.requestedDates.length > 0
      ? request.requestedDates
          .map((value) => DateTime.fromISO(value, { zone: this.#options.timeZone }))
          .filter(
            (value) =>
              value.isValid &&
              value.weekday <= 5 &&
              value >= anchorLocal.startOf("day"),
          )
          .sort((left, right) => left.toMillis() - right.toMillis())
          .slice(0, this.#options.searchBusinessDays)
      : [];
    const businessDates = explicitDates.length > 0
      ? explicitDates
      : collectBusinessDates(firstDate, this.#options.searchBusinessDays);
    const rangeStartDate = businessDates[0] ?? firstDate;
    const lastDate = businessDates.at(-1) ?? firstDate;
    const rangeStart = rangeStartDate.startOf("day");
    const rangeEnd = lastDate.plus({ days: 1 }).startOf("day");
    const events = await this.#calendarProvider.listEvents(
      rangeStart.toUTC().toJSDate(),
      rangeEnd.toUTC().toJSDate(),
      signal,
    );
    const advisories = buildAdvisories(events, this.#options.timeZone);
    const busy = events
      .filter((event) => !event.allDay)
      .map((event) => Interval.fromDateTimes(
        DateTime.fromJSDate(event.start),
        DateTime.fromJSDate(event.end),
      ));

    const requestedSlot = timezoneRequired
      ? null
      : buildRequestedSlot(request, duration, this.#options.timeZone);
    const requestedSlotAvailable = requestedSlot
      ? DateTime.fromISO(requestedSlot.start, { setZone: true }) >
          anchorLocal.toUTC() &&
        isSlotAvailable(requestedSlot, busy, this.#options)
      : false;
    const candidates = businessDates.flatMap((date) =>
      buildDaySlots(date, duration, busy, this.#options),
    ).filter(
      (slot) =>
        DateTime.fromISO(slot.start, { setZone: true }) > anchorLocal.toUTC(),
    );
    const requestedOptionCount = Math.min(
      this.#options.maximumOptions,
      Math.max(1, request.availabilityOptionCount ?? 1),
    );
    const spreadAcrossDates = requestedOptionCount > 1 && businessDates.length > 1;
    const optionCount = spreadAcrossDates
      ? requestedOptionCount
      : Math.min(3, this.#options.maximumOptions);
    const options = rankOptions(
      candidates,
      requestedSlot,
      advisories,
      optionCount,
      this.#options.timeZone,
      spreadAcrossDates,
    );

    return {
      requestedSlot,
      requestedSlotAvailable,
      timezoneRequired,
      options,
      advisories,
      checkedAt: new Date().toISOString(),
    };
  }

  async isStillAvailable(
    slot: SchedulingSlot,
    signal?: AbortSignal,
    ignoredProviderEventId?: string,
  ): Promise<boolean> {
    const start = DateTime.fromISO(slot.start, { setZone: true });
    const end = DateTime.fromISO(slot.end, { setZone: true });
    if (!start.isValid || !end.isValid || end <= start) return false;
    const events = await this.#calendarProvider.listEvents(
      start.toUTC().toJSDate(),
      end.plus({ minutes: this.#options.bufferAfterMinutes }).toUTC().toJSDate(),
      signal,
    );
    const busy = events
      .filter(
        (event) =>
          !event.allDay && event.providerEventId !== ignoredProviderEventId,
      )
      .map((event) => Interval.fromDateTimes(
        DateTime.fromJSDate(event.start),
        DateTime.fromJSDate(event.end),
      ));
    return isSlotAvailable(slot, busy, this.#options);
  }
}

function collectBusinessDates(first: DateTime, count: number): DateTime[] {
  const dates: DateTime[] = [];
  let cursor = first.startOf("day");
  while (dates.length < count) {
    if (cursor.weekday <= 5) dates.push(cursor);
    cursor = cursor.plus({ days: 1 });
  }
  return dates;
}

function buildRequestedSlot(
  request: SchedulingRequest,
  durationMinutes: number,
  displayZone: string,
): SchedulingSlot | null {
  const date = request.requestedDates[0];
  if (!date || !request.requestedTime || !request.timeZone) return null;
  const start = DateTime.fromISO(`${date}T${request.requestedTime}`, {
    zone: request.timeZone,
  });
  if (!start.isValid) return null;
  return makeSlot(start, start.plus({ minutes: durationMinutes }), displayZone);
}

function buildDaySlots(
  date: DateTime,
  durationMinutes: number,
  busy: readonly Interval[],
  options: Required<AvailabilityOptions>,
): SchedulingSlot[] {
  const slots: SchedulingSlot[] = [];
  const dayEnd = date.set({ hour: options.workdayEndHour, minute: 0 });
  let cursor = date.set({ hour: options.workdayStartHour, minute: 0 });
  while (cursor.plus({ minutes: durationMinutes }) <= dayEnd) {
    const slot = makeSlot(cursor, cursor.plus({ minutes: durationMinutes }), options.timeZone);
    if (isSlotAvailable(slot, busy, options)) slots.push(slot);
    cursor = cursor.plus({ minutes: 30 });
  }
  return slots;
}

function isSlotAvailable(
  slot: SchedulingSlot,
  busy: readonly Interval[],
  options: Required<AvailabilityOptions>,
): boolean {
  const start = DateTime.fromISO(slot.start, { setZone: true });
  const end = DateTime.fromISO(slot.end, { setZone: true });
  const localStart = start.setZone(options.timeZone);
  const localEnd = end.setZone(options.timeZone);
  if (
    localStart.weekday > 5 ||
    localStart.hour < options.workdayStartHour ||
    localEnd.hour > options.workdayEndHour ||
    (localEnd.hour === options.workdayEndHour && localEnd.minute > 0)
  ) return false;
  const occupied = Interval.fromDateTimes(
    start,
    end.plus({ minutes: options.bufferAfterMinutes }),
  );
  return busy.every((interval) => !interval.overlaps(occupied));
}

function makeSlot(start: DateTime, end: DateTime, displayZone: string): SchedulingSlot {
  const localStart = start.setZone(displayZone);
  const localEnd = end.setZone(displayZone);
  return {
    start: start.toUTC().toISO()!,
    end: end.toUTC().toISO()!,
    label: `${localStart.toFormat("ccc, LLL d 'at' h:mm a")}–${localEnd.toFormat("h:mm a ZZZZ")}`,
  };
}

function buildAdvisories(
  events: readonly CalendarEvent[],
  timeZone: string,
): SchedulingAdvisory[] {
  const byDate = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.allDay) continue;
    const date = DateTime.fromJSDate(event.start).setZone(timeZone).toISODate();
    const advisoryDate = event.allDayDate ?? date;
    if (!advisoryDate) continue;
    const titles = byDate.get(advisoryDate) ?? new Set<string>();
    titles.add(event.title || "Busy");
    byDate.set(advisoryDate, titles);
  }
  return [...byDate.entries()].map(([date, titles]) => ({
    date,
    titles: [...titles],
  }));
}

function rankOptions(
  candidates: readonly SchedulingSlot[],
  requested: SchedulingSlot | null,
  advisories: readonly SchedulingAdvisory[],
  maximum: number,
  timeZone: string,
  spreadAcrossDates: boolean,
): readonly SchedulingSlot[] {
  const advisoryDates = new Set(advisories.map((item) => item.date));
  const requestedStart = requested
    ? DateTime.fromISO(requested.start, { setZone: true }).setZone(timeZone)
    : null;
  const ranked = [...candidates]
    .filter((candidate) => candidate.start !== requested?.start)
    .sort((left, right) => {
      const l = DateTime.fromISO(left.start, { setZone: true }).setZone(timeZone);
      const r = DateTime.fromISO(right.start, { setZone: true }).setZone(timeZone);
      const lDate = l.toISODate()!;
      const rDate = r.toISODate()!;
      const lAdvisory = advisoryDates.has(lDate) ? 1 : 0;
      const rAdvisory = advisoryDates.has(rDate) ? 1 : 0;
      if (requestedStart) {
        const requestedDate = requestedStart.toISODate();
        const lSameDay = lDate === requestedDate ? 0 : 1;
        const rSameDay = rDate === requestedDate ? 0 : 1;
        if (lSameDay !== rSameDay) return lSameDay - rSameDay;
        if (lSameDay === 0) {
          return Math.abs(l.toMillis() - requestedStart.toMillis()) -
            Math.abs(r.toMillis() - requestedStart.toMillis());
        }
        const lSameTime = l.hour === requestedStart.hour && l.minute === requestedStart.minute ? 0 : 1;
        const rSameTime = r.hour === requestedStart.hour && r.minute === requestedStart.minute ? 0 : 1;
        if (lSameTime !== rSameTime) return lSameTime - rSameTime;
      }
      if (lAdvisory !== rAdvisory) return lAdvisory - rAdvisory;
      return l.toMillis() - r.toMillis();
    });
  if (!spreadAcrossDates) return ranked.slice(0, maximum);

  const selected: SchedulingSlot[] = [];
  const usedDates = new Set<string>();
  for (const slot of ranked) {
    const date = DateTime.fromISO(slot.start, { setZone: true })
      .setZone(timeZone)
      .toISODate();
    if (!date || usedDates.has(date)) continue;
    usedDates.add(date);
    selected.push(slot);
    if (selected.length === maximum) break;
  }
  return selected;
}
