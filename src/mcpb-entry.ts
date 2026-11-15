// Entry point of the .mcpb bundle (manifest.json's server.entry_point): translate the host's settings, then start the server.
import { mapMcpbEnv } from "./mcpb-env.js";

mapMcpbEnv();
await import("./index.js");
