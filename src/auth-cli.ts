#!/usr/bin/env node
import "./env.js";
import { loadConfig, assertCredentials } from "./config.js";
import { runAuthFlow } from "./auth.js";

async function main() {
  const cfg = loadConfig();
  assertCredentials(cfg);
  const tokens = await runAuthFlow(cfg);
  console.error(`\nPaired successfully. Tokens saved to ${cfg.tokenPath}`);
  if (tokens.user) console.error(`Suunto user: ${tokens.user}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
