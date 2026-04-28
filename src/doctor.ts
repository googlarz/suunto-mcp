#!/usr/bin/env node
import "./env.js";
import { loadConfig } from "./config.js";
import { loadTokens } from "./storage.js";
import { SuuntoClient } from "./api.js";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

async function run(): Promise<Check[]> {
  const checks: Check[] = [];
  const cfg = loadConfig();

  // 1. Node version
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node version",
    status: major >= 20 ? "ok" : "fail",
    detail: `${process.versions.node} (require ≥ 20)`,
  });

  // 2. Env vars
  const missing = (
    [
      ["SUUNTO_CLIENT_ID", cfg.clientId],
      ["SUUNTO_CLIENT_SECRET", cfg.clientSecret],
      ["SUUNTO_SUBSCRIPTION_KEY", cfg.subscriptionKey],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  checks.push({
    name: "Credentials",
    status: missing.length === 0 ? "ok" : "fail",
    detail:
      missing.length === 0
        ? "client_id, client_secret, subscription_key set"
        : `missing: ${missing.join(", ")} — fill in .env`,
  });

  // 3. Network reachability to apizone (no auth required, just DNS + TLS)
  try {
    const res = await fetch("https://cloudapi-oauth.suunto.com/oauth/authorize", {
      method: "HEAD",
      redirect: "manual",
    });
    checks.push({
      name: "Network → cloudapi-oauth.suunto.com",
      status: "ok",
      detail: `reachable (HTTP ${res.status})`,
    });
  } catch (err: any) {
    checks.push({
      name: "Network → cloudapi-oauth.suunto.com",
      status: "fail",
      detail: `unreachable: ${err.message ?? err}`,
    });
  }

  // 4. Tokens
  let tokens = null;
  try {
    tokens = await loadTokens(cfg.tokenPath);
  } catch (err: any) {
    checks.push({
      name: "Token storage",
      status: "fail",
      detail: `error reading: ${err.message}`,
    });
  }
  if (!tokens) {
    checks.push({
      name: "Pairing",
      status: "warn",
      detail: "not paired — run `npm run auth` to authorize your Suunto account",
    });
    return checks;
  }
  const expIn = Math.round((tokens.expiresAt - Date.now()) / 60000);
  checks.push({
    name: "Pairing",
    status: "ok",
    detail: `paired${tokens.user ? ` (user: ${tokens.user})` : ""}, token expires in ${expIn} min`,
  });

  // 5. Live API probe
  if (missing.length > 0) return checks;
  try {
    const client = new SuuntoClient(cfg);
    const list = await client.listWorkouts({ limit: 1 });
    const count = list.payload?.length ?? 0;
    checks.push({
      name: "API probe (list_workouts)",
      status: "ok",
      detail:
        count > 0
          ? `received ${count} workout (latest: ${list.payload[0]?.startTime ?? "?"})`
          : "API responded ok, no workouts in account yet",
    });
  } catch (err: any) {
    checks.push({
      name: "API probe (list_workouts)",
      status: "fail",
      detail: err.message ?? String(err),
    });
  }

  // 6. Optional 24/7 products — don't fail, just inform
  const today = new Date().toISOString().slice(0, 10);
  const client = new SuuntoClient(cfg);
  for (const [label, fn] of [
    ["Daily activity product", () => client.getDailyActivity(today)],
    ["Sleep product", () => client.getSleep(today)],
    ["Recovery product", () => client.getRecovery(today)],
  ] as const) {
    try {
      await fn();
      checks.push({ name: label, status: "ok", detail: "subscribed" });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      checks.push({
        name: label,
        status: "warn",
        detail:
          /403|404|401/.test(msg)
            ? "not subscribed on apizone (or wrong path) — that tool will return errors"
            : msg,
      });
    }
  }

  return checks;
}

function format(c: Check): string {
  const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
  return `  ${icon}  ${c.name.padEnd(32)} ${c.detail}`;
}

async function main() {
  console.error("\nSuunto MCP — health check\n");
  let checks: Check[];
  try {
    checks = await run();
  } catch (err: any) {
    console.error(`✗ Doctor crashed before completing: ${err.message ?? err}`);
    process.exit(2);
  }
  for (const c of checks) console.error(format(c));
  const failed = checks.filter((c) => c.status === "fail");
  console.error(
    `\n${checks.length} checks, ${failed.length} failed, ${checks.filter((c) => c.status === "warn").length} warnings\n`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
