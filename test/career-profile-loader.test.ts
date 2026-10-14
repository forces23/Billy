import assert from "node:assert/strict";
import test from "node:test";

import { CareerProfileLoader } from "../src/core/career-profile-loader.js";

test("career profile loader projects professional facts without contact PII", async () => {
  const loader = new CareerProfileLoader("./profile/career.example.json");
  const context = await loader.load();
  const serialized = JSON.stringify(context);

  assert.match(serialized, /professionalTitle/);
  assert.match(serialized, /workExperience/);
  assert.doesNotMatch(serialized, /contact/);
  assert.doesNotMatch(serialized, /your-email-address/);
  assert.doesNotMatch(serialized, /your-phone-number/);
  assert.doesNotMatch(serialized, /profileId/);
});
