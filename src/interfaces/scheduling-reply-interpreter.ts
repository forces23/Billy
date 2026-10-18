import type { SchedulingSlot } from "./scheduling-repository.js";

export const schedulingReplyIntents = [
  "confirmation",
  "counterproposal",
  "question",
  "cancellation",
  "unrelated",
  "ambiguous",
] as const;

export type SchedulingReplyIntent = (typeof schedulingReplyIntents)[number];

export interface SchedulingReplyInterpretation {
  intent: SchedulingReplyIntent;
  confidence: number;
  reason: string;
  referencesSelectedSlot: boolean;
  explicitDate: string | null;
  explicitTime: string | null;
  timeZone: string | null;
  selectedOptionIndex?: number | null;
}

export interface SchedulingReplyInterpreter {
  interpret(input: {
    subject: string;
    body: string;
    anchor: Date;
    selectedSlot: SchedulingSlot | null;
    offeredSlots: readonly SchedulingSlot[];
    defaultTimeZone: string;
  }, signal?: AbortSignal): Promise<SchedulingReplyInterpretation>;
}
