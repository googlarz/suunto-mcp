// .env.example ships blank lines (SUUNTO_TOKEN_PATH=, SUUNTO_DAILY_PREFIX=).
// dotenv reads those as "", and every `process.env.X ?? default` in this
// codebase keeps "" instead of falling back — pairing then died with
// `ENOENT open ''` and the 24/7 path silently became "/activity". A blank
// value always means "not set", so drop it once for everyone.
export function dropBlankEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if ((key.startsWith("SUUNTO_") || key === "PORT") && env[key] === "") delete env[key];
  }
}
