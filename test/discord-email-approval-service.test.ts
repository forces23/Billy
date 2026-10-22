import assert from "node:assert/strict";
import test from "node:test";

import { paginateDiscordText } from "../src/integrations/discord/email-approval-service.js";
import {
  isAuthorizedAssistantMessage,
  paginateAssistantResponse,
} from "../src/integrations/discord/assistant-service.js";

test("Discord email pagination preserves every character", () => {
  const fullReview = [
    "INCOMING EMAIL",
    "A".repeat(4_500),
    "PROPOSED REPLY",
    "B".repeat(4_500),
  ].join("\n");
  const pages = paginateDiscordText(fullReview, 3_800);

  assert.equal(pages.length, 3);
  assert.ok(pages.every((page) => page.length <= 3_800));
  assert.equal(pages.join(""), fullReview);
});

test("Discord assistant pagination respects message limits and preserves words", () => {
  const content = `${"word ".repeat(500)}${"x".repeat(2_100)}`;
  const pages = paginateAssistantResponse(content, 1_900);

  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.length <= 1_900));
  assert.equal(pages.join(""), content);
});

test("Discord assistant accepts only owner messages from the main channel", () => {
  const message = (channelId: string, userId: string, bot = false) => ({
    channelId,
    author: { id: userId, bot },
  });

  assert.equal(
    isAuthorizedAssistantMessage(
      message("main", "owner") as never,
      "main",
      "owner",
    ),
    true,
  );
  assert.equal(
    isAuthorizedAssistantMessage(
      message("other", "owner") as never,
      "main",
      "owner",
    ),
    false,
  );
  assert.equal(
    isAuthorizedAssistantMessage(
      message("main", "other") as never,
      "main",
      "owner",
    ),
    false,
  );
  assert.equal(
    isAuthorizedAssistantMessage(
      message("main", "owner", true) as never,
      "main",
      "owner",
    ),
    false,
  );
});
