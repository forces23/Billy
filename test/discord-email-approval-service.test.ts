import assert from "node:assert/strict";
import test from "node:test";

import { paginateFullEmailReview } from "../src/integrations/discord/email-approval-service.js";

test("full email review pagination preserves every character", () => {
  const fullReview = [
    "INCOMING EMAIL",
    "A".repeat(4_500),
    "PROPOSED REPLY",
    "B".repeat(4_500),
  ].join("\n");
  const pages = paginateFullEmailReview(fullReview, 3_800);

  assert.equal(pages.length, 3);
  assert.ok(pages.every((page) => page.length <= 3_800));
  assert.equal(pages.join(""), fullReview);
});
