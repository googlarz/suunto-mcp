# The 1.x contract

What you can rely on from suunto-mcp 1.0 onward, and what you cannot. It covers every 1.x release; a change that breaks it waits for 2.0.

## What 1.x promises

- **Tool names.** No tool is removed or renamed.
- **Input schemas.** A tool keeps its input properties and their types. A call that is valid today stays valid. A new input property is always optional. A property never becomes required, and its accepted range is not narrowed.
- **Annotations.** A tool's `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` do not change. Clients use them to decide when to ask before running something, so a change would be breaking.
- **Documented output fields.** The fields a tool's description (in `tools/list`) and the README say a result holds keep their name and type. New fields may appear, so read results by name and ignore what you do not know.
- **Bug fixes to wrong numbers are not breaking.** If a number was computed wrongly (a total that did not add up, a unit off by a factor), the fix changes the value and says so in the CHANGELOG.
- **Local files are versioned and never silently overwritten.** What the server keeps on your computer carries a format version or is rebuildable:

  | File | Rule |
  |---|---|
  | `journal.json`, `plan.json`, `seen.json`, archive records (`archive/<key>.json`) | Carry `"version": 1`. A file of a version this server does not know, or a damaged one, is refused with a message naming the file, and is left untouched. If a later 1.x changes a format, it reads the old version (any migration is announced in the CHANGELOG); it never discards what it cannot read. |
  | `cache/` | Derived data, rebuilt on demand. An entry written by another server version or schema is ignored and rebuilt, so the first call after an upgrade may be slower. |
  | `reports/week-<Monday>.md` | Written once; a different file of the same name is never replaced unless `overwrite: true` is passed. |
  | `archive/<key>.fit` | Written once, never overwritten or deleted. |
  | Daily digest history and averages sidecar | The history is append-only markdown. The averages sidecar has no version number; an older file is merged onto the current defaults when read. |

## What 1.x does not promise

- **Derived numbers' thresholds and models may be tuned.** For example the cut-offs of the heart-rate quality check, the false-alarm threshold of `get_tag_effects`, the route-time model, the training-load flags and the wording of notes. The fields stay; the verdict a borderline case gets may change. Each tuning is in the CHANGELOG.
- **Anything the README lists under "Known limits / not yet verified on real devices".** That section says what has not been checked against a real watch or real Suunto files. It may turn out different and be corrected without that being a break.
- **The text of descriptions, notes and error messages.** Read the fields, not the sentences.
- **Demo data.** Demo mode's synthetic data is for trying the tools; its values change between releases.
- **Suunto's side.** What Suunto's API returns, limits or changes is outside this project.
- **Anything not documented**, including the internal layout of `dist/` and of the `.mcpb` bundle.

## Deprecation

A tool, input property, output field, environment variable or command that is going away is announced in the CHANGELOG under the release that deprecates it, and keeps working for at least one more minor release. Anything covered by the promise above is removed only in 2.0.

## How the contract is checked

`src/contract.test.ts` starts the real server in demo mode and compares it with `test-fixtures/contract/`:

- `tools.json`: every tool's name, input schema (without description text) and annotations.
- `outputs.json`: the keys and value types (never the values) of what each read-only tool returns in demo mode.

Any difference fails the test and says whether it is BREAKING (a removed or renamed tool or property, a changed type, a newly required input, changed annotations) or additive (a new tool, a new optional input, a new output key). An additive change is allowed, but only on purpose: run `UPDATE_CONTRACT=1 npm test` and commit the changed fixtures. See [CONTRIBUTING.md](../CONTRIBUTING.md).
