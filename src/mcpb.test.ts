import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { buildZip } from "./guide-zip.js";
import { SECRET_NAME, collectBundleFiles, packMcpb, runtimePackageJson } from "./mcpb.js";
import { mapMcpbEnv } from "./mcpb-env.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const CANARY = "SECRET-CANARY-do-not-ship";

// ---------- the settings translation ----------

test("mapMcpbEnv: the demo checkbox becomes SUUNTO_DEMO=1 only when it is on", () => {
  for (const on of ["true", "TRUE", " true ", "1"]) {
    const env: NodeJS.ProcessEnv = { SUUNTO_MCPB_DEMO: on };
    mapMcpbEnv(env);
    assert.deepEqual(env, { SUUNTO_DEMO: "1" }, on);
  }
  for (const off of ["false", "", "0", "yes", "no"]) {
    const env: NodeJS.ProcessEnv = { SUUNTO_MCPB_DEMO: off };
    mapMcpbEnv(env);
    assert.deepEqual(env, {}, `"${off}" does not turn demo mode on`);
  }
  const none: NodeJS.ProcessEnv = {};
  mapMcpbEnv(none);
  assert.deepEqual(none, {});
});

test("mapMcpbEnv: a SUUNTO_* value that is still an unreplaced ${user_config...} placeholder is dropped, real values and other variables stay", () => {
  const env: NodeJS.ProcessEnv = { SUUNTO_CLIENT_ID: "${user_config.client_id}", SUUNTO_CLIENT_SECRET: "abc", SUUNTO_APP_NAME: "my ${user_config.app_name}", SUUNTO_SUBSCRIPTION_KEY: "", PATH: "${user_config.x}" };
  mapMcpbEnv(env);
  assert.deepEqual(env, { SUUNTO_CLIENT_SECRET: "abc", SUUNTO_SUBSCRIPTION_KEY: "", PATH: "${user_config.x}" });
});

// ---------- manifest.json ----------

test("manifest.json: matches package.json, points at a real entry, and every placeholder names a user_config option", async () => {
  const manifest = JSON.parse(await readFile(join(repo, "manifest.json"), "utf8"));
  const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  assert.equal(manifest.manifest_version, "0.3");
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version, "manifest.json and package.json must be the same version");
  assert.equal(manifest.license, pkg.license);
  assert.equal(manifest.server.type, "node");
  assert.equal(manifest.server.entry_point, "dist/mcpb-entry.js");
  assert.ok(existsSync(join(repo, "src", "mcpb-entry.ts")), "the entry point has a source file");
  assert.deepEqual(manifest.server.mcp_config.args, ["${__dirname}/dist/mcpb-entry.js"]);
  assert.equal(manifest.server.mcp_config.command, "node");
  const placeholders = Object.values<string>(manifest.server.mcp_config.env).map((v) => /^\$\{user_config\.(\w+)\}$/.exec(v)?.[1]);
  assert.ok(placeholders.every((k) => k !== undefined && k in manifest.user_config), JSON.stringify(placeholders));
  assert.deepEqual(Object.keys(manifest.server.mcp_config.env).sort(), ["SUUNTO_APP_NAME", "SUUNTO_CLIENT_ID", "SUUNTO_CLIENT_SECRET", "SUUNTO_MCPB_DEMO", "SUUNTO_SUBSCRIPTION_KEY"]);
  const cfg = manifest.user_config;
  assert.deepEqual([cfg.demo.type, cfg.demo.default, cfg.demo.required], ["boolean", true, false]);
  for (const k of ["client_id", "client_secret", "subscription_key"]) assert.deepEqual([cfg[k].type, cfg[k].sensitive, cfg[k].required], ["string", true, false], k);
  for (const [k, v] of Object.entries<any>(cfg)) assert.ok(v.title && v.description, `${k} has a title and description`);
  assert.doesNotMatch(JSON.stringify(manifest), /[\w.-]+@[\w.-]+\.\w+/, "no email address in the manifest");
});

// ---------- the zip ----------

// A reader for the zips buildZip writes: names and contents, through the central directory.
function readZip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const packed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataAt, dataAt + packed);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, size, name);
    out.set(name, Buffer.from(data));
    p += 46 + nameLen;
  }
  return out;
}

test("buildZip: without options it is the store-only zip it always was; compress deflates what shrinks and stamps a valid date", () => {
  const files = [{ name: "a.txt", data: Buffer.from("hello ".repeat(500)) }, { name: "b.bin", data: Buffer.from([1, 2, 3]) }, { name: "empty", data: Buffer.alloc(0) }];
  const plain = buildZip(files);
  const packed = buildZip(files, { compress: true });
  assert.ok(packed.length < plain.length);
  assert.equal(plain.readUInt16LE(8), 0, "method store");
  assert.equal(plain.readUInt16LE(12), 0, "date untouched without compress");
  assert.equal(packed.readUInt16LE(8), 8, "method deflate");
  assert.equal(packed.readUInt16LE(12), 0x21);
  for (const z of [plain, packed]) assert.deepEqual([...readZip(z)].map(([n, d]) => [n, d.toString("latin1")]), files.map((f) => [f.name, f.data.toString("latin1")]));
  const small = readZip(packed).get("b.bin")!;
  assert.deepEqual([...small], [1, 2, 3], "an entry that does not shrink is stored");
});

// ---------- the bundle ----------

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "suunto-mcpb-"));
  const w = async (rel: string, content: string) => {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), content);
  };
  await w("manifest.json", JSON.stringify({ manifest_version: "0.3", name: "x", version: "1.2.3", server: { type: "node", entry_point: "dist/mcpb-entry.js" } }));
  await w("package.json", JSON.stringify({ name: "x", version: "1.2.3", description: "d", license: "MIT", main: "dist/index.js", scripts: { build: "tsc", prepublishOnly: "x" }, dependencies: { a: "^1.0.0" }, devDependencies: { typescript: "^5" }, optionalDependencies: { k: "1" } }));
  await w("LICENSE", "MIT");
  await w("README.md", "readme");
  await w(".env", `SUUNTO_CLIENT_SECRET=${CANARY}`);
  await w("tokens.json", `{"accessToken":"${CANARY}"}`);
  await w("src/index.ts", "source");
  await w("dist/index.js", "console.log(1)");
  await w("dist/mcpb-entry.js", "import './index.js'");
  await w("dist/index.js.map", "{}");
  await w("dist/pack-mcpb.js", "packer");
  await w("dist/mcpb.js", "packer");
  await w("dist/x.test.js", "test");
  await w("dist/.env", CANARY);
  await w("dist/sub/lib.js", "lib");
  await w("stage/node_modules/a/index.js", "a");
  await w("stage/node_modules/a/package.json", '{"name":"a"}');
  await w("stage/node_modules/a/.env", CANARY);
  await w("stage/node_modules/a/.env.local", CANARY);
  await w("stage/node_modules/a/tokens.json", CANARY);
  await w("stage/node_modules/a/credentials.json", CANARY);
  await w("stage/node_modules/a/server.pem", CANARY);
  await w("stage/node_modules/a/index.js.map", "{}");
  await w("stage/node_modules/a/token.js", "legit code named token"); // a name that merely contains "token" is fine
  await w("stage/node_modules/@s/b/index.js", "b");
  await w("stage/node_modules/.package-lock.json", "{}");
  await mkdir(join(root, "stage/node_modules/.bin"), { recursive: true });
  await symlink("../a/index.js", join(root, "stage/node_modules/.bin/a"));
  return root;
}

const EXPECTED = [
  "LICENSE",
  "dist/index.js",
  "dist/mcpb-entry.js",
  "dist/sub/lib.js",
  "manifest.json",
  "node_modules/@s/b/index.js",
  "node_modules/a/index.js",
  "node_modules/a/package.json",
  "node_modules/a/token.js",
  "package.json",
];

test("bundle: only the manifest, the runtime package.json, the licence, dist/ (no maps, tests or packer) and node_modules go in; no secret file does", async () => {
  const root = await fixture();
  try {
    const files = await collectBundleFiles({ root, modulesDir: join(root, "stage/node_modules") });
    assert.deepEqual(files.map((f) => f.name).sort(), EXPECTED);
    for (const f of files) assert.ok(!f.data.includes(CANARY), `${f.name} holds the canary`);
    const pkg = JSON.parse(files.find((f) => f.name === "package.json")!.data.toString());
    assert.deepEqual(Object.keys(pkg).sort(), ["dependencies", "description", "license", "main", "name", "type", "version"]);
    assert.equal(pkg.type, "module");
    assert.deepEqual(pkg.dependencies, { a: "^1.0.0" }, "no dev or optional dependencies, no scripts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packMcpb: writes suunto-mcp-<version>.mcpb whose listing and contents are exactly the expected files", async () => {
  const root = await fixture();
  try {
    const out = join(root, "build");
    const r = await packMcpb({ root, modulesDir: join(root, "stage/node_modules"), outDir: out });
    assert.equal(r.path, join(out, "suunto-mcp-1.2.3.mcpb"));
    const zip = await readFile(r.path);
    const entries = readZip(zip);
    assert.deepEqual([...entries.keys()].sort(), EXPECTED);
    assert.deepEqual([...entries.keys()].sort(), [...r.files].sort());
    assert.ok(!zip.includes(CANARY), "the canary is nowhere in the compressed file");
    assert.ok(![...entries.keys()].some((n) => SECRET_NAME.test(n)));
    assert.ok(![...entries.values()].some((d) => d.includes(CANARY)));
    assert.equal(entries.get("dist/index.js")!.toString(), "console.log(1)");
    assert.equal(JSON.parse(entries.get("manifest.json")!.toString()).version, "1.2.3");
    assert.equal(entries.get("package.json")!.toString(), runtimePackageJson(JSON.parse(await readFile(join(root, "package.json"), "utf8"))));
    // the system's own unzip agrees that the archive is sound, where there is one
    const t = spawnSync("unzip", ["-tq", r.path], { encoding: "utf8" });
    if (!t.error) assert.equal(t.status, 0, t.stdout + t.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packMcpb: refuses a version mismatch, a missing build, a missing entry point and missing production modules", async () => {
  const root = await fixture();
  try {
    const modulesDir = join(root, "stage/node_modules");
    await assert.rejects(collectBundleFiles({ root, modulesDir: join(root, "nope") }), /production dependencies were not installed/);
    await writeFile(join(root, "manifest.json"), JSON.stringify({ version: "9.9.9", server: { entry_point: "dist/mcpb-entry.js" } }));
    await assert.rejects(collectBundleFiles({ root, modulesDir }), /manifest.json is version 9.9.9 but package.json is 1.2.3/);
    await writeFile(join(root, "manifest.json"), JSON.stringify({ version: "1.2.3", server: { entry_point: "dist/missing.js" } }));
    await assert.rejects(collectBundleFiles({ root, modulesDir }), /dist\/missing.js.*not in dist\/: run npm run build first/);
    await writeFile(join(root, "manifest.json"), JSON.stringify({ version: "1.2.3" }));
    await assert.rejects(collectBundleFiles({ root, modulesDir }), /no server.entry_point/);
    await rm(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "manifest.json"), JSON.stringify({ version: "1.2.3", server: { entry_point: "dist/mcpb-entry.js" } }));
    await assert.rejects(collectBundleFiles({ root, modulesDir }), /dist\/ does not exist: run npm run build first/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SECRET_NAME: .env files, token and credential files, keys and certificates match; ordinary code names do not", () => {
  for (const bad of [".env", "a/.env", "a/.env.local", ".npmrc", "tokens.json", "a/token.json", "credentials.json", "credentials", "id_rsa", "id_ed25519.pub", "a/server.pem", "k.key", "x.p12"]) assert.ok(SECRET_NAME.test(bad), bad);
  for (const ok of ["dist/token.js", "dist/tokens.js", "a/.environment", "env.js", "dist/auth.js", "a/keyring.js", "README.md", "a/monkey.js"]) assert.ok(!SECRET_NAME.test(ok), ok);
});

// ---------- the entry point, started the way a host starts it ----------

async function initialize(env: Record<string, string>): Promise<any> {
  const entry = fileURLToPath(new URL("./mcpb-entry.js", import.meta.url));
  const cwd = await mkdtemp(join(tmpdir(), "suunto-mcpb-run-"));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("SUUNTO_"))) as Record<string, string>;
  const child = spawn(process.execPath, [entry], { cwd, env: { ...clean, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  try {
    const reply = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no initialize response within 15 s")), 15_000);
      createInterface({ input: child.stdout }).on("line", (line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcpb-test", version: "1" } } }) + "\n");
    return (await reply).result;
  } finally {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  }
}

async function listToolNames(): Promise<string[]> {
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const cwd = await mkdtemp(join(tmpdir(), "suunto-mcpb-tools-"));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("SUUNTO_"))) as Record<string, string>;
  const child = spawn(process.execPath, [entry], { cwd, env: { ...clean, SUUNTO_DEMO: "1" }, stdio: ["pipe", "pipe", "ignore"] });
  try {
    const reply = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no tools/list response within 15 s")), 15_000);
      createInterface({ input: child.stdout }).on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcpb-test", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    return (await reply).result.tools.map((t: { name: string }) => t.name);
  } finally {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("manifest.json: privacy_policies points at the README's Privacy section, and tools lists exactly the tools the server lists", async () => {
  const manifest = JSON.parse(await readFile(join(repo, "manifest.json"), "utf8"));
  const readme = await readFile(join(repo, "README.md"), "utf8");
  assert.deepEqual(manifest.privacy_policies, ["https://github.com/googlarz/suunto-mcp#privacy"]);
  assert.match(readme, /^## Privacy$/m, "the policy URL needs a Privacy heading to land on");
  const privacy = readme.split(/^## Privacy$/m)[1].split(/^## /m)[0];
  for (const claim of [/stay on your computer|stays? (on|local)/i, /Suunto's API|Suunto's servers/, /nothing else is sent|no third-party/i, /demo mode makes no/i]) assert.match(privacy, claim);
  assert.equal(manifest.tools_generated, undefined, "every tool is listed, none is generated at run time");
  const listed = manifest.tools.map((t: any) => t.name);
  assert.deepEqual([...listed].sort(), (await listToolNames()).sort(), "manifest.json tools and the server's tools/list must be the same names");
  assert.equal(new Set(listed).size, listed.length);
  for (const t of manifest.tools) assert.ok(typeof t.description === "string" && t.description.length > 10 && t.description.length < 200 && !/\n/.test(t.description), t.name);
});

test("mcpb-entry: the demo checkbox on starts the server in demo mode with no credentials; off starts it normally", async () => {
  const on = await initialize({ SUUNTO_MCPB_DEMO: "true", SUUNTO_CLIENT_ID: "${user_config.client_id}" });
  assert.match(on.instructions, /DEMO MODE/);
  const off = await initialize({ SUUNTO_MCPB_DEMO: "false", SUUNTO_CLIENT_ID: "" });
  assert.equal(off.instructions, undefined);
  assert.equal(off.serverInfo.name, "suunto-mcp");
});
