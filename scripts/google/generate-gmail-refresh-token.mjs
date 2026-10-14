import { resolve } from "node:path";
import { authenticate } from "@google-cloud/local-auth";

// Need to add the scopes here when added in the console for the generation token process.
const scopes = [
    "https://www.googleapis.com/auth/gmail.messages.readonly",
    "https://www.googleapis.com/auth/gmail.user.readonly",
    "https://www.googleapis.com/auth/gmail.send",
];

const client = await authenticate({
    keyfilePath: resolve("./SECRETS/credentials-google-Billy-local.json"),
    scopes,
});

const refreshToken = client.credentials.refresh_token;

if (!refreshToken) {
    console.error("No refresh token found in the credentials.");
    process.exit(1);
}

console.log("\nCopy this value into GOOGLE_REFRESH_TOKEN in .env:\n");
console.log(refreshToken);