export interface SchedulingRequest {
  summary: string;
  requestedDates: readonly string[];
  requestedTime: string | null;
  timeZone: string | null;
  durationMinutes: number;
  availabilityOptionCount?: number;
  reviewerWantsSelection?: boolean;
}

export interface SchedulingInterpretInput {
  from: string;
  subject: string;
  body: string;
  anchor: Date;
  defaultTimeZone: string;
  previousRequest?: SchedulingRequest;
}

export interface SchedulingInterpreter {
  interpret(
    input: SchedulingInterpretInput,
    signal?: AbortSignal,
  ): Promise<SchedulingRequest>;
}
