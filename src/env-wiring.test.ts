import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// env.ts is what every entry point imports first. Run it for real in a child
// process (it reads .env from the cwd), rather than testing dropBlankEnv alone,
// so removing or reordering the call there is caught.
const envModule = fileURLToPath(new URL("./env.js", import.meta.url));

function loadEnv(dotenv: string | null, env: Record<string, string>) {
  return mkdtemp(join(tmpdir(), "suunto-envwire-")).then(async (cwd) => {
    try {
      if (dotenv !== null) await writeFile(join(cwd, ".env"), dotenv);
      const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SUUNTO_") && k !== "PORT"));
      const script = `import ${JSON.stringify(envModule)};
        const keys = ["SUUNTO_CLIENT_ID", "SUUNTO_TOKEN_PATH", "SUUNTO_APP_NAME", "PORT", "UNRELATED_BLANK"];
        console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, env: { ...clean, ...env }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.trim().split("\n").pop()!) as Record<string, string | null>;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("env.ts: blank values copied from .env.example are treated as unset (the first-run crash)", async () => {
  const out = await loadEnv("SUUNTO_CLIENT_ID=real-id\nSUUNTO_TOKEN_PATH=\nSUUNTO_APP_NAME=\nPORT=\n", {});
  assert.equal(out.SUUNTO_CLIENT_ID, "real-id");
  assert.equal(out.SUUNTO_TOKEN_PATH, null, "a blank token path must not reach loadConfig as an empty path");
  assert.equal(out.SUUNTO_APP_NAME, null);
  assert.equal(out.PORT, null);
});

test("env.ts: a blank value from the client's env block does not shadow the real one in .env", async () => {
  const out = await loadEnv("SUUNTO_CLIENT_ID=from-dotenv\n", { SUUNTO_CLIENT_ID: "" });
  assert.equal(out.SUUNTO_CLIENT_ID, "from-dotenv");
});

test("env.ts: a real value from the client always wins over .env, and unrelated blanks are left alone", async () => {
  const out = await loadEnv("SUUNTO_CLIENT_ID=from-dotenv\nUNRELATED_BLANK=\n", { SUUNTO_CLIENT_ID: "from-client" });
  assert.equal(out.SUUNTO_CLIENT_ID, "from-client");
  assert.equal(out.UNRELATED_BLANK, "", "only SUUNTO_* and PORT are dropped");
});

test("env.ts: works with no .env at all", async () => {
  const out = await loadEnv(null, { SUUNTO_TOKEN_PATH: "" });
  assert.equal(out.SUUNTO_TOKEN_PATH, null);
});
