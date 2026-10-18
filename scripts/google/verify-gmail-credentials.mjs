import "dotenv/config";
import { google } from "googleapis";

function required(name) {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Missing ${name} in .env`);
    return value;
}

function commaSeparatedList(name) {
    const values = required(name)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    if (values.length === 0) {
        throw new Error(`${name} must contain at least one value`);
    }
    return values;
}

const auth = new google.auth.OAuth2(
    required("GOOGLE_CLIENT_ID"),
    required("GOOGLE_CLIENT_SECRET"),
);

auth.setCredentials({
    refresh_token: required("GOOGLE_REFRESH_TOKEN"),
});

const gmail = google.gmail({ version: "v1", auth });
const calendar = google.calendar({ version: "v3", auth });
const userId = process.env.GMAIL_USER_ID || "me";

const messages = await gmail.users.messages.list({
    userId,
    maxResults: 1,
    q: "in:inbox",
});

const calendarIds = [
    ...new Set([
        required("GOOGLE_CALENDAR_BILLY_ID"),
        ...commaSeparatedList("GOOGLE_CALENDAR_SHARED_IDS"),
    ]),
];
const calendarChecks = await Promise.all(
    calendarIds.map(async (calendarId) => {
        const response = await calendar.calendars.get({ calendarId });
        return {
            calendarId,
            summary: response.data.summary,
            timeZone: response.data.timeZone,
            readable: true,
        };
    }),
);

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
    calendars: calendarChecks,
});
