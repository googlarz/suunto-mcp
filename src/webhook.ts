#!/usr/bin/env node
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

const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
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
});

server.listen(port, () => {
  console.error(`Suunto webhook receiver listening on :${port}`);
  console.error(`Logging events to ${logPath}`);
});
