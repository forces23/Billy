import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Events } from "discord.js";
import type { Client, Message } from "discord.js";
import pino from "pino";

import {
  DiscordRuntime,
  type DiscordFeature,
} from "../src/integrations/discord/runtime.js";

class FakeDiscordClient extends EventEmitter {
  loginCount = 0;
  destroyCount = 0;
  user = { id: "billy" };

  async login(): Promise<string> {
    this.loginCount += 1;
    queueMicrotask(() => this.emit(Events.ClientReady, this));
    return "token";
  }

  destroy(): void {
    this.destroyCount += 1;
  }
}

test("Discord runtime owns one connection and dispatches events to features", async () => {
  const client = new FakeDiscordClient();
  const abortController = new AbortController();
  const handled: string[] = [];
  const feature = (name: string): DiscordFeature => ({
    name,
    async initialize() {
      handled.push(`${name}:initialized`);
    },
    async handleMessage() {
      handled.push(`${name}:message`);
    },
    async run() {
      if (name === "assistant") {
        client.emit(Events.MessageCreate, { id: "message-1" } as Message);
        await new Promise((resolve) => setImmediate(resolve));
        abortController.abort();
      }
      await waitForAbort(abortController.signal);
    },
  });
  const runtime = new DiscordRuntime(
    client as unknown as Client,
    "test-token",
    [feature("email"), feature("assistant")],
    pino({ level: "silent" }),
  );

  await runtime.run(abortController.signal);

  assert.equal(client.loginCount, 1);
  assert.equal(client.destroyCount, 1);
  assert.deepEqual(handled, [
    "email:initialized",
    "assistant:initialized",
    "email:message",
    "assistant:message",
  ]);
});

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
