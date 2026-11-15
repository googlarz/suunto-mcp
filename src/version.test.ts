import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A release bumps the version in six places. If one is forgotten, the registry, the .mcpb bundle or the npm
// package says something different from the others. The server itself reads package.json (see index.ts and cache.ts),
// so no source file holds a version string.
const repo = fileURLToPath(new URL("../", import.meta.url));
const json = async (name: string) => JSON.parse(await readFile(join(repo, name), "utf8"));

test("version: package.json, server.json (twice), manifest.json and package-lock.json (twice) are all the same", async () => {
  const pkg = await json("package.json");
  const server = await json("server.json");
  const manifest = await json("manifest.json");
  const lock = await json("package-lock.json");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const places: Record<string, string> = {
    "package.json version": pkg.version,
    "server.json version": server.version,
    "server.json packages[0].version": server.packages[0].version,
    "manifest.json version": manifest.version,
    "package-lock.json version": lock.version,
    'package-lock.json packages[""].version': lock.packages[""].version,
  };
  assert.deepEqual(
    Object.entries(places).filter(([, v]) => v !== pkg.version),
    [],
    `every version must equal package.json's (${pkg.version}); found ${JSON.stringify(places, null, 2)}`,
  );
});

test("version: the lock file and the registry entry name the same package as package.json", async () => {
  const pkg = await json("package.json");
  const server = await json("server.json");
  const lock = await json("package-lock.json");
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.name, pkg.mcpName);
});

test("version: CHANGELOG.md has a heading for the current version", async () => {
  const { version } = await json("package.json");
  const changelog = await readFile(join(repo, "CHANGELOG.md"), "utf8");
  assert.ok(changelog.split("\n").includes(`## ${version}`), `CHANGELOG.md has no "## ${version}" heading`);
});
