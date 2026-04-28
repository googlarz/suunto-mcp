// Centralized .env loader. Imported by entry points (auth-cli, doctor,
// webhook, index) before they read process.env. dotenv will NOT override
// values already set in the shell / by Claude Desktop's env: block, so
// it's safe to load unconditionally.
import { config } from "dotenv";
config();
