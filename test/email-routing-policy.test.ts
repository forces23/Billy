import assert from "node:assert/strict";
import test from "node:test";

import {
  determineEmailRoutingAction,
  emailRoutingThresholds,
} from "../src/core/email-routing-policy.js";
import type {
  EmailCategory,
  EmailClassification,
} from "../src/interfaces/email-classifier.js";

function classification(
  category: EmailCategory,
  confidence: number,
): EmailClassification {
  return {
    category,
    confidence,
    reason: "Test classification",
    requestedModel: "test/classifier",
    resolvedModel: "test/classifier",
    providerResponseId: "classification-1",
  };
}

test("email routing uses separate confidence thresholds for each action", () => {
  assert.deepEqual(emailRoutingThresholds, {
    careerContext: 0.8,
    interviewNotification: 0.85,
    silentIgnore: 0.95,
  });

  assert.equal(
    determineEmailRoutingAction(classification("recruiter_opportunity", 0.799)),
    "normal_draft",
  );
  assert.equal(
    determineEmailRoutingAction(classification("recruiter_opportunity", 0.8)),
    "career_context",
  );
  assert.equal(
    determineEmailRoutingAction(classification("interview_scheduling", 0.849)),
    "normal_draft",
  );
  assert.equal(
    determineEmailRoutingAction(classification("interview_scheduling", 0.85)),
    "interview_notification",
  );
  assert.equal(
    determineEmailRoutingAction(classification("scam", 0.949)),
    "normal_draft",
  );
  assert.equal(
    determineEmailRoutingAction(classification("scam", 0.95)),
    "silent_ignore",
  );
});
