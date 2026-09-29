// Centralized .env loader. Imported by entry points (auth-cli, doctor,
// webhook, index) before they read process.env. dotenv will NOT override
// values already set in the shell / by Claude Desktop's env: block, so
// it's safe to load unconditionally.
import { config } from "dotenv";
import { dropBlankEnv } from "./blank-env.js";

// Blank values are dropped both before and after dotenv runs. Before: dotenv
// never overrides a variable that is already set, so a blank one from the shell
// or the client's env block would otherwise shadow the real value in .env.
// After: a .env copied from .env.example carries blank values of its own.
dropBlankEnv();
config();
dropBlankEnv();
