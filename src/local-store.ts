// A versioned local JSON document with the conventions every suunto-mcp state file follows (journal.ts, plan.ts,
// catchup.ts): path override by environment variable (the caller's), `version: 1`, a strict parser that refuses unknown
// fields, a damaged / foreign / other-version file refused with a message naming it and never overwritten, an atomic
// write (temp file, then rename) with the file 0600 and a folder it creates 0700. The prediction ledger and the
// experiments file use it; demo mode uses the in-memory twin, so nothing reaches the disk there.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface DocStore<T> {
  load(): Promise<T | null>;
  save(doc: T): Promise<void>;
}

export function memoryDocStore<T>(): DocStore<T> {
  let held: T | null = null;
  return { load: async () => (held === null ? null : structuredClone(held)), save: async (d) => void (held = structuredClone(d)) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// A missing file is no document (null); anything else that is not exactly what this server writes throws.
// `parse` gets the file's object (with `version`) and must throw on anything it does not know.
export function fileDocStore<T>(path: string, what: string, parse: (raw: Record<string, unknown>) => T): DocStore<T> {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (err: any) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
      let file: unknown;
      try {
        file = JSON.parse(raw);
      } catch {
        throw new Error(`${path} is not valid JSON; fix or delete it`);
      }
      if (!isObject(file)) throw new Error(`${path} is not a suunto-mcp ${what} file; fix or delete it`);
      // rewriting another version's file as version 1 would drop what this server cannot read
      if (file.version !== 1) throw new Error(`${path} is ${what} version ${JSON.stringify(file.version) ?? "unknown"}, but this server reads and writes version 1 only; it is left untouched`);
      try {
        return parse(file);
      } catch (err: any) {
        throw new Error(`${path} is invalid (${err.message}); fix or delete it`);
      }
    },
    async save(doc) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        await writeFile(tmp, JSON.stringify({ version: 1, ...doc }, null, 2), { encoding: "utf8", mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },
  };
}

// Calls run one after the other: two at once would each read the file before the other's write. Not a lock between
// processes: two writes within the same few milliseconds can still collide (the file is re-read right before each write).
export function serialQueue(): <T>(run: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  };
}
