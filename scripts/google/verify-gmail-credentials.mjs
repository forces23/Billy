import "dotenv/config";
import { google } from "googleapis";

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name} in .env`);
    return value;
}

const auth = new google.auth.OAuth2(
    required("GOOGLE_CLIENT_ID"),
    required("GOOGLE_CLIENT_SECRET"),
);  

auth.setCredentials({
    refresh_token: required("GOOGLE_REFRESH_TOKEN"),
});

const gmail = google.gmail({ version: "v1", auth });
const userId = process.env.GMAIL_USER_ID || "me";

const messages = await gmail.users.messages.list({
    userId,
    maxResults: 1,
    q: "in:inbox",
});

// getProfile is not covered by gmail.messages.readonly. It is reported
// separately so a scope error here does not fail the connection test.
let emailAddress = "unavailable (requires gmail.user.readonly)";
try {
    const profile = await gmail.users.getProfile({ userId });
    emailAddress = profile.data.emailAddress;
} catch {
  // Intentionally ignored; listing messages already proves the connection.
}

console.log({
    emailAddress,
    inboxConnectionSuccessful: true,
    sampleMessageFound: Boolean(messages.data.messages?.length),
});