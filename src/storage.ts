import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user?: string;
}

export async function loadTokens(path: string): Promise<TokenBundle | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as TokenBundle;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function saveTokens(path: string, bundle: TokenBundle): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(bundle, null, 2), "utf8");
  await chmod(path, 0o600);
}
