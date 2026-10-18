export const emailCategories = [
  "recruiter_opportunity",
  "qualification_question",
  "interview_scheduling",
  "rejection",
  "job_alert",
  "advertisement",
  "scam",
  "other",
] as const;

export type EmailCategory = (typeof emailCategories)[number];

export interface EmailClassification {
  category: EmailCategory;
  confidence: number;
  reason: string;
  summary: string;
  requestedModel: string;
  resolvedModel: string;
  providerResponseId: string;
}

export interface ClassifyEmailInput {
  from: string;
  subject: string;
  body: string;
  previousThreadCategory: EmailCategory | null;
}

export interface EmailClassifier {
  classify(
    input: ClassifyEmailInput,
    signal?: AbortSignal,
  ): Promise<EmailClassification>;
}

export function isEmailCategory(value: unknown): value is EmailCategory {
  return (
    typeof value === "string" &&
    (emailCategories as readonly string[]).includes(value)
  );
}
