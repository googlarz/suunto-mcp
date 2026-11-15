// The .mcpb bundle starts the server through mcpb-entry.js, which first runs this over the environment the host built from
// manifest.json's user_config:
//  - the `demo` checkbox arrives as SUUNTO_MCPB_DEMO ("true" or "false": a host writes a boolean as text, and demo mode
//    only turns on for SUUNTO_DEMO=1), so it is translated here;
//  - a SUUNTO_* value that still holds an unreplaced "${user_config.…}" placeholder (a host that leaves an option the user
//    did not fill in as its literal text) is dropped, so it is never mistaken for a credential.
// Blank values need no handling here: env.js drops them for every entry point.
export function mapMcpbEnv(env: NodeJS.ProcessEnv = process.env): void {
  const demo = env.SUUNTO_MCPB_DEMO;
  delete env.SUUNTO_MCPB_DEMO;
  if (demo !== undefined && ["true", "1"].includes(demo.trim().toLowerCase())) env.SUUNTO_DEMO = "1";
  for (const key of Object.keys(env)) {
    if (key.startsWith("SUUNTO_") && (env[key] ?? "").includes("${user_config.")) delete env[key];
  }
}
