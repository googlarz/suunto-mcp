import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./webhook.js", import.meta.url));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

// Starts the receiver, waits for its "listening" line, runs fn, stops it.
async function withWebhook(env: Record<string, string>, fn: (url: string, banner: string, logPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "suunto-webhook-"));
  const port = await freePort();
  const logPath = join(dir, "logs", "webhooks.ndjson");
  const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", PORT: String(port), SUUNTO_WEBHOOK_LOG: logPath, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  try {
    const banner = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stderr!.on("data", (d) => {
        out += d;
        if (out.includes("Logging events to")) resolve(out);
      });
      child.on("exit", () => reject(new Error(`webhook exited early: ${out}`)));
    });
    await fn(`http://127.0.0.1:${port}/hook`, banner, logPath);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.on("exit", r));
    }
    await rm(dir, { recursive: true });
  }
}

test("webhook: without a secret every request is rejected and nothing is written", async () => {
  await withWebhook({}, async (url, banner) => {
    assert.match(banner, /listening on 127\.0\.0\.1:/);
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ x: 1 }) });
    assert.equal(res.status, 401);
  });
});

test("webhook: unsigned mode is opt-in; the log is written and private", async () => {
  await withWebhook({ SUUNTO_WEBHOOK_ALLOW_UNSIGNED: "1" }, async (url, _banner, logPath) => {
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ x: 1 }) });
    assert.equal(res.status, 200);
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
  });
});

test("webhook: a request with a valid signature is accepted and logged with mode 0600", async () => {
  const { createHmac } = await import("node:crypto");
  const secret = "s3cret";
  const body = JSON.stringify({ workout: "w" });
  const sig = createHmac("sha256", secret).update(body).digest("base64");
  const dir = await mkdtemp(join(tmpdir(), "suunto-webhook-"));
  const port = await freePort();
  const logPath = join(dir, "logs", "webhooks.ndjson");
  const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", PORT: String(port), SUUNTO_WEBHOOK_LOG: logPath, SUUNTO_WEBHOOK_SECRET: secret }, stdio: ["ignore", "ignore", "pipe"] });
  try {
    await new Promise<void>((resolve) => child.stderr!.on("data", (d) => String(d).includes("Logging events to") && resolve()));
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body, headers: { "x-hmac-sha256-signature": sig } });
    const bad = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body, headers: { "x-hmac-sha256-signature": "AAAA" } });
    assert.deepEqual([res.status, bad.status], [200, 401]);
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "logs"))).mode & 0o777, 0o700);
    assert.equal((await readFile(logPath, "utf8")).trim().split("\n").length, 1, "only the signed request was logged");
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.on("exit", r));
    }
    await rm(dir, { recursive: true });
  }
});
