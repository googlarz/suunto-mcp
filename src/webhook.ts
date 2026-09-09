#!/usr/bin/env node
import "./env.js";
// Minimal webhook receiver for Suunto push notifications.
// Suunto POSTs JSON for new workouts, daily activity, sleep, and recovery.
// Run this on a public HTTPS host (or via a tunnel like cloudflared) and
// register the URL in your Suunto app's webhook settings.

import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const port = Number(process.env.PORT ?? 8422);
const logPath = process.env.SUUNTO_WEBHOOK_LOG ?? join(homedir(), ".suunto-mcp", "webhooks.ndjson");

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
    const body = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* keep raw */
    }
    const entry = { receivedAt: new Date().toISOString(), path: req.url, body: parsed };
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
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

server.listen(port, () => {
  console.error(`Suunto webhook receiver listening on :${port}`);
  console.error(`Logging events to ${logPath}`);
});
