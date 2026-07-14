import { authenticate } from "@google-cloud/local-auth";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

async function main() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env");
    process.exit(1);
  }

  // Create a temporary client secrets file for the auth library
  const tempKeysPath = resolve("data/temp-client-secrets.json");
  const dir = dirname(tempKeysPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(
    tempKeysPath,
    JSON.stringify({
      installed: {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: ["http://localhost"],
      },
    }),
    "utf-8"
  );

  console.log("Opening browser for YouTube OAuth authentication...");
  console.log("Please sign in and grant access to your YouTube channel.\n");

  const auth = await authenticate({
    keyfilePath: tempKeysPath,
    scopes: SCOPES,
  });

  const oauthPath = resolve("data/youtube-oauth.json");
  writeFileSync(
    oauthPath,
    JSON.stringify(
      {
        type: "authorized_user",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: auth.credentials.refresh_token,
        access_token: auth.credentials.access_token,
        token_type: auth.credentials.token_type,
        expiry_date: auth.credentials.expiry_date,
      },
      null,
      2
    ),
    "utf-8"
  );

  // Clean up temp file
  try {
    unlinkSync(tempKeysPath);
  } catch {}

  console.log(`\nOAuth tokens saved to ${oauthPath}`);
  console.log("You can now use the upload module.");
}

main().catch((e) => {
  console.error("OAuth setup failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
