# The 1.x contract

What you can rely on from suunto-mcp 1.0 onward, and what you cannot. It covers every 1.x release; a change that breaks it waits for 2.0.

## What 1.x promises

- **Names.** No tool, `bin` command, environment variable, MCP prompt (or one of its arguments) or MCP resource is removed or renamed. They are covered by the same compatibility rule as tools. The exception is the three hidden legacy tools below.
- **Input schemas.** A tool keeps its input properties and their types. A call that is valid today stays valid. A new input property is always optional, and a property never becomes required. An input may accept more (a new enum value, a higher maximum, a lower minimum, a lifted limit); it never accepts less.
- **Annotations change only toward more caution.** `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` may change in 1.x only this way: read-only true to false, destructive false to true, idempotent true to false, open-world false to true. That makes clients ask more often, never less, and is announced in the CHANGELOG. The opposite direction is breaking. Two tools are annotated for their most writing mode, not for their default call: `get_weekly_report` is not read-only because of its `save` option, and `get_catchup` because of `markSeen`. Called without them they only read. `get_exercise_history` is annotated read-only: it writes only its own rebuildable local cache.
- **Documented output fields.** The fields a tool's description (in `tools/list`) and the README say a result holds keep their name and type. New fields may appear, so read results by name and ignore what you do not know.
- **Bug fixes to wrong numbers are not breaking.** If a number was computed wrongly (a total that did not add up, a unit off by a factor), the fix changes the value and says so in the CHANGELOG.
- **Local files are versioned or rebuildable, and never silently overwritten.**

  | File | Rule |
  |---|---|
  | `journal.json`, `plan.json`, `seen.json`, `predictions.json`, `experiments.json`, `approvals.json`, archive records (`archive/<key>.json`) | Carry `"version": 1`. A file of a version this server does not know, or a damaged one, is refused with a message naming the file, and is left untouched. If a later 1.x changes a format, it reads the old version (any migration is announced in the CHANGELOG); it never discards what it cannot read. |
  | `tokens.json` | Written by the pairing step, read and rewritten when a token is refreshed. It has no version number. Pair again if a release ever says so. |
  | `health-export-state.json` (`sync-to-health-skill`'s watermark) | Unversioned: one `lastDate`. An unreadable one stops the sync instead of being treated as a first run. |
  | `cache/` | Derived data, rebuilt on demand. An entry written by another server version or schema is ignored and rebuilt, so the first call after an upgrade may be slower. |
  | `reports/week-<Monday>.md` | Written once; a different file of the same name is never replaced unless `overwrite: true` is passed. |
  | `archive/<key>.fit` | Written once, never overwritten or deleted. |
  | Daily digest history (`SUUNTO_HISTORY.md`) and averages sidecar | The history is append-only markdown, created owner-only (0600). The averages sidecar has no version number; an older file is merged onto the current defaults when read. |
  | Webhook log (`SUUNTO_WEBHOOK_LOG`) | Append-only lines, one event each, with no format version. The receiver stops appending past a size limit instead of rotating or overwriting. |

## What 1.x does not promise

- **Derived numbers' thresholds and models may be tuned.** For example the cut-offs of the heart-rate quality check, the false-alarm threshold of `get_tag_effects`, the route-time model, the training-load flags and the wording of notes. The fields stay; the verdict a borderline case gets may change. Each tuning is in the CHANGELOG.
- **The three hidden legacy tools.** `get_workout_samples`, `export_workout_gpx` and `list_subscriptions` are deprecated: Suunto's servers no longer answer them, and they are listed only with `SUUNTO_ENABLE_LEGACY_TOOLS=1`. They are outside this contract and may be removed in a 1.x minor release, with a CHANGELOG note.
- **Anything the README lists under "Known limits / not yet verified on real devices".** That section says what has not been checked against a real watch or real Suunto files. It may turn out different and be corrected without that being a break.
- **The text of descriptions, notes and error messages.** Read the fields, not the sentences.
- **Demo data.** Demo mode's synthetic data is for trying the tools; its values change between releases.
- **Suunto's side.** What Suunto's API returns, limits or changes is outside this project.
- **Anything not documented**, including the internal layout of `dist/` and of the `.mcpb` bundle.

## Deprecation

One rule. Everything inside this contract is removed or changed incompatibly only in 2.0. Something outside it (the hidden legacy tools above, an undocumented field) may go in a minor release. Either way the removal is announced in the CHANGELOG under the release that deprecates it, and the item keeps working for at least one more minor release.

## How the contract is checked

`src/contract.test.ts` starts the real server in demo mode (clock frozen, no network) and compares it with `test-fixtures/contract/`:

- `tools.json`: every tool's name, input schema (without description or example text) and annotations.
- `outputs.json`: the keys and value types (never the values) of what each read-only tool returns in demo mode, plus `get_catchup`, `get_weekly_report` and `push_week_plan`'s dry run, with a plan set first so the plan shapes show. Fields that demo data never fills (always null or an empty list) cannot be checked; the file's `unobserved` section lists them, so they do not look covered.
- `surface.json`: the `bin` commands, the environment variables the code reads (also required to be in the README's table), the MCP prompts with their arguments, and the MCP resources.

Any difference fails the test and says whether it is BREAKING or additive. Breaking: a removed or renamed tool, property, name or output key, a changed type, a newly required input, a narrowed input (fewer enum values, a lower maximum, a higher minimum), an annotation made less cautious. Additive: a new tool, optional input, output key or name, a widened input, and an annotation made more cautious (additive with notice: say so in the CHANGELOG). An additive change is allowed, but only on purpose: run `UPDATE_CONTRACT=1 npm test` and commit the changed fixtures. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Planned for 2.0

Intentions, not promises. They change names or behaviour, so they wait for a major version; where 1.x could add the new way without removing the old, it already did.

- **One naming for date parameters.** `from` / `to` everywhere. Done additively in 1.2 (`list_workouts` and `get_daily_activity_statistics` accept them next to `since` / `until` and `startdate` / `enddate`); 2.0 may drop the older names.
- **`dryRun` on every write tool**, not only `push_week_plan`, with the same default (validate only).
- **One data store with a migration**, instead of separate files (journal, plan, seen, predictions, experiments, approvals, cache, archive), so one version number, one backup and one overview cover them.
- **Removal of the legacy tools** `get_workout_samples`, `export_workout_gpx` and `list_subscriptions`. They are already hidden and outside this contract, and marked deprecated in their descriptions; they may go in a later 1.x minor release, announced in the CHANGELOG.
