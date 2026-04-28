import { createServer } from "node:http";
import { exec } from "node:child_process";
import { URL } from "node:url";
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

export async function getValidAccessToken(c: Config): Promise<string> {
  const tokens = await loadTokens(c.tokenPath);
  if (!tokens) throw new SuuntoNotAuthenticatedError();
  if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;

  if (!inFlightRefresh) {
    inFlightRefresh = (async () => {
      try {
        const fresh = await refresh(c, tokens.refreshToken);
        await saveTokens(c.tokenPath, fresh);
        return fresh;
      } finally {
        inFlightRefresh = null;
      }
    })();
  }
  const fresh = await inFlightRefresh;
  return fresh.accessToken;
}

// Test-only: clear the shared refresh promise between tests.
export function __resetRefreshSingleton(): void {
  inFlightRefresh = null;
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
