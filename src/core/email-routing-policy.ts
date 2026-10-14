import type { EmailClassification } from "../interfaces/email-classifier.js";

export const emailRoutingThresholds = Object.freeze({
  careerContext: 0.8,
  interviewNotification: 0.85,
  silentIgnore: 0.95,
});

export type EmailRoutingAction =
  | "career_context"
  | "interview_notification"
  | "silent_ignore"
  | "normal_draft";

export function determineEmailRoutingAction(
  classification: EmailClassification | null,
): EmailRoutingAction {
  if (!classification) return "normal_draft";

  if (
    (classification.category === "recruiter_opportunity" ||
      classification.category === "qualification_question") &&
    classification.confidence >= emailRoutingThresholds.careerContext
  ) {
    return "career_context";
  }

  if (
    classification.category === "interview_scheduling" &&
    classification.confidence >= emailRoutingThresholds.interviewNotification
  ) {
    return "interview_notification";
  }

  if (
    (classification.category === "job_alert" ||
      classification.category === "advertisement" ||
      classification.category === "scam") &&
    classification.confidence >= emailRoutingThresholds.silentIgnore
  ) {
    return "silent_ignore";
  }

  return "normal_draft";
}
