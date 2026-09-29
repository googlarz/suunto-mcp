import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const exitUrl = new URL("./exit.js", import.meta.url).href;

// Runs a child that writes `bytes` to a pipe, then exits via exitAfterFlush.
function run(bytes: number): { out: Buffer; status: number } {
  const code = `
    const { exitAfterFlush } = await import(${JSON.stringify(exitUrl)});
    process.stdout.write("x".repeat(${bytes}));
    await exitAfterFlush(3);
  `;
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, status: 0 };
  } catch (err: any) {
    return { out: err.stdout as Buffer, status: err.status as number };
  }
}

test("exitAfterFlush: a 300 KB piped write survives the exit (was truncated at the 64 KB pipe buffer)", () => {
  const { out, status } = run(300_000);
  assert.equal(out.length, 300_000);
  assert.equal(status, 3, "exits with the requested code");
});

test("exitAfterFlush: execution never continues past the awaited call", () => {
  const code = `
    const { exitAfterFlush } = await import(${JSON.stringify(exitUrl)});
    await exitAfterFlush(0);
    process.stdout.write("FELL_THROUGH");
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(out.toString(), "", "code after the await must not run (in index.ts that would start the MCP server)");
});
