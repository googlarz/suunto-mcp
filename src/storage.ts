import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user?: string;
}

const KEYCHAIN_SERVICE = "suunto-mcp";
const KEYCHAIN_ACCOUNT = "tokens";

type KeyringEntry = { getPassword(): string | null; setPassword(p: string): void };

let keyringEntry: KeyringEntry | null | undefined;

async function getKeyringEntry(): Promise<KeyringEntry | null> {
  if (keyringEntry !== undefined) return keyringEntry;
  const mode = process.env.SUUNTO_TOKEN_STORAGE ?? "file";
  if (mode !== "keychain") {
    keyringEntry = null;
    return null;
  }
  try {
    // @ts-ignore - optional peer dep, may not be installed at build time
    const mod: any = await import("@napi-rs/keyring");
    keyringEntry = new mod.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch (err) {
    console.error(
      "SUUNTO_TOKEN_STORAGE=keychain requested but @napi-rs/keyring is not installed. " +
        "Run: npm install @napi-rs/keyring. Falling back to file storage.",
    );
    keyringEntry = null;
  }
  return keyringEntry ?? null;
}

export async function loadTokens(path: string): Promise<TokenBundle | null> {
  const entry = await getKeyringEntry();
  if (entry) {
    try {
      const raw = entry.getPassword();
      return raw ? (JSON.parse(raw) as TokenBundle) : null;
    } catch {
      return null;
    }
  }
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as TokenBundle;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function saveTokens(path: string, bundle: TokenBundle): Promise<void> {
  const entry = await getKeyringEntry();
  if (entry) {
    entry.setPassword(JSON.stringify(bundle));
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(bundle, null, 2), "utf8");
  await chmod(path, 0o600);
}

// Test-only: reset the cached keyring lookup so each test re-evaluates env.
export function __resetStorageCache(): void {
  keyringEntry = undefined;
}
