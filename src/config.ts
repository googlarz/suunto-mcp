import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
  redirectUri: string;
  tokenPath: string;
}

export function loadConfig(): Config {
  const clientId = process.env.SUUNTO_CLIENT_ID ?? "";
  const clientSecret = process.env.SUUNTO_CLIENT_SECRET ?? "";
  const subscriptionKey = process.env.SUUNTO_SUBSCRIPTION_KEY ?? "";
  const redirectUri =
    process.env.SUUNTO_REDIRECT_URI ?? "http://localhost:8421/callback";
  const tokenPath =
    process.env.SUUNTO_TOKEN_PATH ?? join(homedir(), ".suunto-mcp", "tokens.json");

  return { clientId, clientSecret, subscriptionKey, redirectUri, tokenPath };
}

export function assertCredentials(c: Config): void {
  const missing: string[] = [];
  if (!c.clientId) missing.push("SUUNTO_CLIENT_ID");
  if (!c.clientSecret) missing.push("SUUNTO_CLIENT_SECRET");
  if (!c.subscriptionKey) missing.push("SUUNTO_SUBSCRIPTION_KEY");
  if (missing.length) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}.\n` +
        `\n` +
        `Did you copy .env.example to .env and fill in the values?\n` +
        `  cp .env.example .env\n` +
        `  $EDITOR .env\n` +
        `\n` +
        `Get your credentials at https://apizone.suunto.com → your app:\n` +
        `  - Client ID         → app overview page\n` +
        `  - Client Secret     → "OAuth settings" section (regenerate if hidden)\n` +
        `  - Subscription Key  → user profile → "Subscriptions" → primary key\n`,
    );
  }
}
