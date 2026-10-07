#!/usr/bin/env node
import "./env.js";
// Minimal webhook receiver for Suunto push notifications.
// Suunto POSTs JSON for new workouts, daily activity, sleep, and recovery.
// Run this on a public HTTPS host (or via a tunnel like cloudflared) and
// register the URL in your Suunto app's webhook settings.

import { createServer } from "node:http";
import { appendFile, chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { verifySignature } from "./webhook-verify.js";

const port = Number(process.env.PORT ?? 8422);
const logPath = process.env.SUUNTO_WEBHOOK_LOG ?? join(homedir(), ".suunto-mcp", "webhooks.ndjson");
// The "notification secret" you set in apizone's OAuth application settings
// (Webhook notifications docs) — without it, anyone who finds this
// receiver's URL could POST forged workout/sleep/recovery events into it.
const webhookSecret = process.env.SUUNTO_WEBHOOK_SECRET;

// Loopback by default: a tunnel (cloudflared, ngrok) forwards to localhost, so
// nothing needs the receiver to be reachable from the LAN.
const host = process.env.SUUNTO_WEBHOOK_HOST ?? "127.0.0.1";
const allowUnsigned = process.env.SUUNTO_WEBHOOK_ALLOW_UNSIGNED === "1";
const MAX_LOG_BYTES = 100 * 1024 * 1024; // stop appending rather than fill the disk

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — Suunto payloads are small JSON; bound it anyway

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(c as Buffer);
    }
    const rawBody = Buffer.concat(chunks);
    if (webhookSecret) {
      const signatureHeader = req.headers["x-hmac-sha256-signature"];
      const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      if (!verifySignature(rawBody, header, webhookSecret)) {
        console.error("Webhook request rejected: missing or invalid X-HMAC-SHA256-Signature");
        res.writeHead(401);
        res.end();
        return;
      }
    } else if (allowUnsigned) {
      console.error("SUUNTO_WEBHOOK_ALLOW_UNSIGNED=1 — accepting this request WITHOUT verifying its signature.");
    } else {
      console.error(
        "Webhook request rejected: SUUNTO_WEBHOOK_SECRET is not set, so signatures cannot be verified. " +
          "Set the notification secret from apizone's OAuth application settings as SUUNTO_WEBHOOK_SECRET " +
          "(or SUUNTO_WEBHOOK_ALLOW_UNSIGNED=1 for local testing only).",
      );
      res.writeHead(401);
      res.end();
      return;
    }
    const body = rawBody.toString("utf8");
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* keep raw */
    }
    const entry = { receivedAt: new Date().toISOString(), path: req.url, body: parsed };
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    const logSize = await stat(logPath).then((s) => s.size, () => 0);
    if (logSize > MAX_LOG_BYTES) {
      console.error(`Webhook log ${logPath} is over ${MAX_LOG_BYTES} bytes — not appending. Rotate or delete it.`);
      res.writeHead(507);
      res.end();
      return;
    }
    await appendFile(logPath, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(logPath, 0o600);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    // A client disconnecting mid-upload throws inside the request-stream
    // iteration — without this, that rejection is unhandled and crashes
    // the whole receiver (confirmed: exits with code 1 on a dropped POST).
    console.error("Webhook request failed:", err);
    if (!res.headersSent) {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        /* response may already be unusable if the connection is gone */
      }
    }
  }
});

server.listen(port, host, () => {
  console.error(`Suunto webhook receiver listening on ${host}:${port}`);
  if (!webhookSecret && !allowUnsigned) console.error("SUUNTO_WEBHOOK_SECRET is not set: every request will be rejected until it is.");
  console.error(`Logging events to ${logPath}`);
});
