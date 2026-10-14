import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";

import { createGmailAuth } from "./auth.js";
import type { GmailAuthConfig } from "./auth.js";

export function createGmailClient(config: GmailAuthConfig): gmail_v1.Gmail {
  return google.gmail({
    version: "v1",
    auth: createGmailAuth(config),
  });
}
