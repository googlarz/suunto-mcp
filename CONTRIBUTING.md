# Contributing to Suunto MCP

Thanks for your interest. This is a small, focused project — PRs welcome,
especially if you have apizone access and can verify against a real
account.

## Quick start

```bash
git clone https://github.com/googlarz/suunto-mcp
cd suunto-mcp
npm install
npm test          # 40 tests, ~10s
npm run build
```

Live testing requires `.env` filled in and `npm run auth` completed once.
Run `npm run doctor` to verify.

## Project layout

```
src/
  index.ts        MCP server entry — registers tools + resources, dispatches
  auth.ts         OAuth2 flow, token refresh (with concurrent-call dedup)
  auth-cli.ts     `npm run auth` command — runs the local browser flow
  api.ts          Suunto HTTP client — retry/backoff, pagination
  resources.ts    MCP resource definitions (today/sleep, this-week/summary, …)
  fit.ts          FIT binary → JSON summary using fit-file-parser
  storage.ts      Token persistence: file (default) or OS keychain
  errors.ts       Structured error hierarchy
  config.ts       Env-var loading + validation
  doctor.ts       `npm run doctor` health check
  webhook.ts      Standalone webhook receiver
  env.ts          dotenv loader (imported by every entry point)
```

Tests live alongside source as `*.test.ts` and run via Node's built-in
`node:test` runner — no test framework deps.

## Where things tend to need work

- **24/7 product paths** in `api.ts` are best-effort. If your apizone
  entitlement uses a different prefix, set `SUUNTO_DAILY_PREFIX` and (if
  it's general) submit a fix.
- **Webhook subscription CRUD** is on the roadmap but not built.
- **MCP Prompts** (preset templates) aren't wired up yet.

## PR checklist

- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] New behavior has a test (or a clear note why it's not testable)
- [ ] No new top-level deps unless justified — Node's built-ins go a long way
- [ ] README updated if user-facing behavior changed

## Bugs against a real apizone account

Please attach (with secrets redacted):

- Output of `npm run doctor`
- Node version (`node -v`)
- Which apizone API products are subscribed
- The exact error message + (if a stack trace) the calling tool

## License

By contributing, you agree your changes are MIT-licensed.
