# Security policy

Suunto MCP handles OAuth tokens and personal health data, so please report vulnerabilities privately.

**Report:** use GitHub's private vulnerability reporting (Security tab → "Report a vulnerability") on
[googlarz/suunto-mcp](https://github.com/googlarz/suunto-mcp/security/advisories/new). Please do not open a public issue for a security problem.

You can expect an acknowledgement within a few days. Fixes ship as a patch release of the latest version; only the latest release is supported.

## What is in scope

- Token or subscription-key exposure (logs, error messages, file permissions).
- A tool call that reads or writes files, or contacts hosts, beyond what its description says.
- The webhook receiver (`suunto-mcp-webhook`) accepting forged or oversized requests.
- The publish workflow (`.github/workflows/publish.yml`).

## Good to know

- Tokens live in `~/.suunto-mcp/tokens.json` (mode 0600) or the OS keychain (`SUUNTO_TOKEN_STORAGE=keychain`).
- The webhook receiver listens on `127.0.0.1` and rejects unsigned requests unless `SUUNTO_WEBHOOK_ALLOW_UNSIGNED=1` is set.
- `upload_workout` accepts only `.fit` and `.gpx` files.
