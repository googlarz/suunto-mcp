#!/usr/bin/env node
// npm run pack:mcpb (builds first): installs the production dependencies into build/stage/ from package-lock.json, then
// writes build/suunto-mcp-<version>.mcpb. Optional dependencies (the OS keychain module) are left out so the bundle is
// plain JavaScript that does not depend on the platform it was packed on. Needs network for npm ci; uploads nothing.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packMcpb } from "./mcpb.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "build", "stage");

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const f of ["package.json", "package-lock.json"]) await copyFile(join(root, f), join(stage, f));
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
const { path, files, bytes } = await packMcpb({ root, modulesDir: join(stage, "node_modules"), outDir: join(root, "build") });
await rm(stage, { recursive: true, force: true });
console.log(`${path}: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
