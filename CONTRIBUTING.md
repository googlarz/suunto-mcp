# Contributing to Suunto MCP

Thanks for your interest. This is a small, focused project — PRs welcome,
especially if you have apizone access and can verify against a real
account.

## Quick start

```bash
git clone https://github.com/googlarz/suunto-mcp
cd suunto-mcp
npm install
npm test          # full suite, hermetic (no network, no credentials)
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

## The 1.x contract and its fixtures

[docs/CONTRACT.md](docs/CONTRACT.md) says what stays compatible within 1.x. `src/contract.test.ts` enforces it: it starts the real server in demo mode and compares the tool list (names, input schemas, annotations), the key shape of every read-only tool's result (with the fields demo data never fills listed under `unobserved`) and the names of `bin` commands, environment variables, MCP prompts and resources with `test-fixtures/contract/tools.json`, `outputs.json` and `surface.json`. A new environment variable must also be added to the environment table in [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Any difference fails, and the message says whether it is BREAKING (a removed or renamed tool or property, a changed type, a newly required input, changed annotations) or additive.

When you add a tool, an optional input or an output key on purpose, regenerate the fixtures and commit them with your change:

```bash
UPDATE_CONTRACT=1 npm test
git diff test-fixtures/contract/   # review: only additions should show
```

Never regenerate to make a BREAKING difference pass. A new read-only tool also needs a call in `OUTPUT_CALLS` in `src/contract.test.ts`.

## Where things tend to need work

- **24/7 product paths** in `api.ts` are best-effort. If your apizone
  entitlement uses a different prefix, set `SUUNTO_DAILY_PREFIX` and (if
  it's general) submit a fix.
- **Webhook subscription CRUD** is on the roadmap but not built.

## PR checklist

- [ ] `npm test` passes (if the contract test failed on an addition you meant, `UPDATE_CONTRACT=1 npm test` and commit the fixtures)
- [ ] `npm run build` succeeds
- [ ] New behavior has a test (or a clear note why it's not testable)
- [ ] No new top-level deps unless justified — Node's built-ins go a long way
- [ ] README or the matching file in docs/ updated if user-facing behavior changed

## Bugs against a real apizone account

Please attach (with secrets redacted):

- Output of `npm run doctor`
- Node version (`node -v`)
- Which apizone API products are subscribed
- The exact error message + (if a stack trace) the calling tool

## License

By contributing, you agree your changes are MIT-licensed.
