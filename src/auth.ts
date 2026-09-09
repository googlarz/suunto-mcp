import { createServer } from "node:http";
import { exec } from "node:child_process";
import { URL } from "node:url";
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import type { Config } from "./config.js";
import { loadTokens, saveTokens, type TokenBundle } from "./storage.js";
import { SuuntoNotAuthenticatedError, SuuntoTokenError } from "./errors.js";

const AUTH_BASE = "https://cloudapi-oauth.suunto.com/oauth";

export function buildAuthorizeUrl(c: Config, state: string): string {
  const u = new URL(`${AUTH_BASE}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", c.clientId);
  u.searchParams.set("redirect_uri", c.redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenRequest(c: Config, body: Record<string, string>): Promise<TokenBundle> {
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new SuuntoTokenError(
      `Token request failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user?: string;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    user: data.user,
  };
}

export async function exchangeCode(c: Config, code: string): Promise<TokenBundle> {
  return tokenRequest(c, {
    grant_type: "authorization_code",
    code,
    redirect_uri: c.redirectUri,
  });
}

export async function refresh(c: Config, refreshToken: string): Promise<TokenBundle> {
  return tokenRequest(c, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

// Concurrent-refresh deduplication: if multiple callers find the token
// expired at the same time, they all await one shared refresh promise so
// Suunto only sees a single refresh_token grant. Suunto invalidates older
// refresh tokens on use, so a parallel double-refresh would log the user out.
let inFlightRefresh: Promise<TokenBundle> | null = null;

// In-memory token cache: avoids a disk read on every API request.
// Invalidated when a refresh occurs or the token expires.
let cachedTokens: TokenBundle | null = null;

const LOCK_STALE_MS = 15_000; // far longer than any real refresh round-trip
const LOCK_MAX_WAIT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Cross-process mutex via mkdir's atomicity (fails with EEXIST if the
// directory already exists — a portable, dependency-free test-and-set).
// Reloading tokens from disk before refreshing only helps once another
// process's rotation has already completed — two processes reading the
// SAME near-expiry token at the same instant would both submit the same
// refresh_token grant, and Suunto invalidates it after the first use,
// failing the second. This serializes the whole reload-then-refresh
// sequence across processes, not just within this one.
export async function withTokenLock<T>(tokenPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${tokenPath}.lock`;
  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockPath); // previous holder likely crashed — reclaim
          continue;
        }
      } catch {
        continue; // lock vanished between our check and stat — retry now
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        throw new Error(`Timed out waiting for the token refresh lock at ${lockPath}`);
      }
      await sleep(50 + Math.random() * 100);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      /* already gone — nothing to clean up */
    }
  }
}

export async function getValidAccessToken(c: Config): Promise<string> {
  if (!cachedTokens) {
    cachedTokens = await loadTokens(c.tokenPath);
  }
  if (!cachedTokens) throw new SuuntoNotAuthenticatedError();
  if (cachedTokens.expiresAt > Date.now() + 60_000) return cachedTokens.accessToken;

  if (!inFlightRefresh) {
    inFlightRefresh = (async () => {
      try {
        return await withTokenLock(c.tokenPath, async () => {
          // Re-check disk now that we hold the cross-process lock —
          // another process may have already rotated the token (finished
          // its own refresh while we waited for the lock), so adopt that
          // instead of attempting a redundant, conflicting refresh.
          const onDisk = await loadTokens(c.tokenPath);
          if (onDisk && onDisk.expiresAt > Date.now() + 60_000) {
            cachedTokens = onDisk;
            return onDisk;
          }
          if (onDisk) cachedTokens = onDisk;
          const fresh = await refresh(c, cachedTokens!.refreshToken);
          await saveTokens(c.tokenPath, fresh);
          cachedTokens = fresh;
          return fresh;
        });
      } finally {
        inFlightRefresh = null;
      }
    })();
  }
  const fresh = await inFlightRefresh;
  cachedTokens = fresh;
  return fresh.accessToken;
}

// Test-only: clear the shared refresh promise and token cache between tests.
export function __resetRefreshSingleton(): void {
  inFlightRefresh = null;
  cachedTokens = null;
}

// Test-only: seed the in-memory cache directly, to simulate "this process
// already had a token cached before another process rotated the file" —
// not reachable through the public API on a fresh test run, since the
// first call always loads straight from (already-current) disk.
export function __setCachedTokensForTest(bundle: TokenBundle | null): void {
  cachedTokens = bundle;
}

function tryOpenBrowser(url: string): void {
  if (process.env.SUUNTO_NO_BROWSER) return;
  const cmd =
    process.platform === "darwin"
      ? `open ${shellQuote(url)}`
      : process.platform === "win32"
        ? `start "" ${shellQuote(url)}`
        : `xdg-open ${shellQuote(url)}`;
  exec(cmd, () => {
    /* swallow — fall back to manual paste */
  });
}

function shellQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

export async function runAuthFlow(c: Config): Promise<TokenBundle> {
  const state = Math.random().toString(36).slice(2);
  const url = new URL(c.redirectUri);
  const port = Number(url.port || "8421");
  const expectedPath = url.pathname || "/callback";

  const authorizeUrl = buildAuthorizeUrl(c, state);

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (reqUrl.pathname !== expectedPath) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const code = reqUrl.searchParams.get("code");
        const returnedState = reqUrl.searchParams.get("state");
        if (!code) {
          res.writeHead(400);
          res.end("Missing code");
          return;
        }
        if (returnedState !== state) {
          res.writeHead(400);
          res.end("State mismatch");
          return;
        }
        const bundle = await exchangeCode(c, code);
        await saveTokens(c.tokenPath, bundle);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body style="font-family:sans-serif;padding:2rem">
             <h1>Suunto MCP connected</h1>
             <p>Your watch data is now wired up. You can close this tab.</p>
           </body></html>`,
        );
        server.close();
        resolve(bundle);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      console.error(
        `\nOpening Suunto authorization in your browser…\n\n  ${authorizeUrl}\n\n` +
          `If the browser didn't open, copy the URL above into it manually.\n`,
      );
      tryOpenBrowser(authorizeUrl);
    });
  });
}
