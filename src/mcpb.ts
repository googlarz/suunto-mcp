// npm run pack:mcpb: the one-click .mcpb bundle (a zip of manifest.json, the built dist/ and the production node_modules).
// A strict allowlist decides what goes in; whatever the folders hold besides that (sources, tests, .env, token files,
// credentials) never reaches the bundle. Nothing is uploaded or published.
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildZip } from "./guide-zip.js";

// A name that must never be in a bundle, wherever it sits (checked on every file, including inside node_modules).
export const SECRET_NAME = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|tokens?\.json|credentials(\.json)?|id_(rsa|ed25519|ecdsa).*|[^/]*\.(pem|p12|pfx|key))$/i;
// Build tooling that is compiled into dist/ but has no place in the bundle.
const DIST_SKIP = /(\.map|\.test\.js)$|^(pack-mcpb|mcpb)\.js$/;
const MODULES_SKIP = /(\.map)$|^\.package-lock\.json$/;

export interface BundleFile {
  name: string;
  data: Buffer;
}

async function walk(dir: string, prefix: string, skip: RegExp): Promise<BundleFile[]> {
  const out: BundleFile[] = [];
  for (const entry of (await readdir(dir)).sort()) {
    const name = `${prefix}/${entry}`;
    const full = join(dir, entry);
    const st = await lstat(full);
    if (st.isSymbolicLink()) continue; // links (node_modules/.bin) are not followed
    if (st.isDirectory()) out.push(...(await walk(full, name, skip)));
    else if (st.isFile() && !SECRET_NAME.test(name) && !skip.test(entry)) out.push({ name, data: await readFile(full) });
  }
  return out;
}

// What the bundle's package.json says: enough for Node to read dist/ as ES modules and for the version to be seen, nothing
// from the repository's scripts or dev dependencies.
export function runtimePackageJson(pkg: any): string {
  const { name, version, description, license, main, dependencies } = pkg;
  return JSON.stringify({ name, version, description, license, type: "module", main, dependencies }, null, 2) + "\n";
}

export async function collectBundleFiles(opts: { root: string; modulesDir: string }): Promise<BundleFile[]> {
  const manifest = JSON.parse(await readFile(join(opts.root, "manifest.json"), "utf8"));
  const pkg = JSON.parse(await readFile(join(opts.root, "package.json"), "utf8"));
  if (manifest.version !== pkg.version) throw new Error(`manifest.json is version ${manifest.version} but package.json is ${pkg.version}; make them the same.`);
  const entry: unknown = manifest.server?.entry_point;
  if (typeof entry !== "string") throw new Error("manifest.json has no server.entry_point.");
  let dist: BundleFile[];
  try {
    dist = await walk(join(opts.root, "dist"), "dist", DIST_SKIP);
  } catch (err: any) {
    if (err.code === "ENOENT") throw new Error("dist/ does not exist: run npm run build first.");
    throw err;
  }
  if (!dist.some((f) => f.name === entry)) throw new Error(`${entry} (manifest.json's entry_point) is not in dist/: run npm run build first.`);
  const modules = await walk(opts.modulesDir, "node_modules", MODULES_SKIP).catch((err) => {
    throw err.code === "ENOENT" ? new Error(`${opts.modulesDir} does not exist: the production dependencies were not installed.`) : err;
  });
  const license = await readFile(join(opts.root, "LICENSE")).catch(() => null);
  return [
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") },
    { name: "package.json", data: Buffer.from(runtimePackageJson(pkg)) },
    ...(license ? [{ name: "LICENSE", data: license }] : []),
    ...dist,
    ...modules,
  ];
}

export async function packMcpb(opts: { root: string; modulesDir: string; outDir: string }): Promise<{ path: string; files: string[]; bytes: number }> {
  const files = await collectBundleFiles(opts);
  const bad = files.find((f) => SECRET_NAME.test(f.name));
  if (bad) throw new Error(`${bad.name} must not be in a bundle.`); // belt and braces: walk() already skips these
  const version = JSON.parse(files.find((f) => f.name === "package.json")!.data.toString()).version;
  const zip = buildZip(files, { compress: true });
  await mkdir(opts.outDir, { recursive: true });
  const path = join(opts.outDir, `suunto-mcp-${version}.mcpb`);
  await writeFile(`${path}.tmp`, zip);
  await rename(`${path}.tmp`, path);
  return { path, files: files.map((f) => f.name), bytes: zip.length };
}
