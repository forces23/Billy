import { google } from "googleapis";

export interface GmailAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function createGmailAuth(config: GmailAuthConfig) {
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);

  auth.setCredentials({
    refresh_token: config.refreshToken,
  });

  return auth;
}
