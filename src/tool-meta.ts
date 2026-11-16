// MCP tool titles + annotations, applied to every tool in index.ts at startup
// (a tool with no entry here throws — see index.ts — so a new tool can't ship
// unannotated). Annotations are hints clients use: Claude Code treats
// readOnlyHint tools as safe in plan mode and for concurrent calls, and
// clients may ask before running destructive ones.
//
// Every tool talks to Suunto's cloud, so openWorldHint is true throughout, except the tools that touch local files only: log_session, set_plan, get_plan, queue_adjustment, list_approvals, get_data_overview,
// get_archive_status, and the prediction ledger and experiment tools that never read Suunto (log_prediction, void_prediction, get_prediction_stats, start_experiment,
// get_experiment, log_experiment_day, stop_experiment).
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };

// Creating a new remote object: not read-only, but nothing existing is overwritten.
const CREATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

// push_*_guide: passing guideId makes the call a PUT that overwrites an
// existing guide, so these can destroy data even though they usually create.
const PUSH: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const TOOL_META: Record<string, { title: string; annotations: ToolAnnotations }> = {
  list_workouts: { title: "List workouts", annotations: READ },
  get_workout: { title: "Get workout", annotations: READ },
  get_workout_samples: { title: "Get workout samples", annotations: READ },
  get_workout_fit: { title: "Get workout FIT data", annotations: READ },
  get_workout_laps: { title: "Get workout laps", annotations: READ },
  compare_workout_to_plan: { title: "Compare workout to plan", annotations: READ },
  get_workout_rest_profile: { title: "Get workout rest recovery profile", annotations: READ },
  // Read-only as far as the user's data goes: its one write is a rebuildable local cache of derived results.
  get_exercise_history: { title: "Get exercise history across sessions", annotations: READ },
  // Writes only the local journal file; the same key again REPLACES that entry (hence destructive); never contacts Suunto, hence not openWorld.
  log_session: { title: "Log what actually happened in a session", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  // Local plan file only, never Suunto. Destructive: mode "replace" (the default) overwrites the whole stored plan (the result returns the previous one). The same call twice leaves the same plan.
  set_plan: { title: "Set the training plan (local file, pushes nothing)", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  get_plan: { title: "Get the training plan (today and the next 7 days)", annotations: { readOnlyHint: true, openWorldHint: false } },
  // Reads Suunto. Without markSeen it is a pure read; with markSeen: true it writes the local marker (the same state again if repeated), so it is not read-only.
  get_catchup: { title: "Catch up: what is new since last time", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  // Reads Suunto and the local journal; its one write is the same rebuildable cache as get_exercise_history.
  get_benchmark: { title: "Get benchmark: a repeatable session over time", annotations: READ },
  // Reads Suunto's list and the local journal; writes nothing.
  get_tag_effects: { title: "Get tag effects: journal tags against the next night", annotations: READ },
  // Reads Suunto (list + FIT downloads) and writes ONLY new files in the local archive folder: never overwrites or deletes, so not destructive. Not idempotent: each call archives the next batch, so the same call twice has a different effect.
  archive_workouts: { title: "Archive workouts to local files (writes nothing at Suunto)", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  // Reads Suunto; with save: true it writes one local markdown file, and overwrite: true can replace a different one (hence destructive). The same call twice leaves the same file.
  get_weekly_report: { title: "Get the weekly report (optionally save it as a local markdown file)", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
  // Reads one route from Suunto and the local archive; writes nothing.
  estimate_route_time: { title: "Estimate a route's time from your own pace (and the latest start before sunset)", annotations: READ },
  get_archive_status: { title: "Get the local workout archive status", annotations: { readOnlyHint: true, openWorldHint: false } },
  // The prediction ledger (predictions.json). Nothing is ever replaced or deleted: a new prediction is a new entry (so not idempotent), a void and an outcome are added to the entry.
  // A void cannot be undone (the prediction is out of the scoring for good), so void_prediction is destructive; so is stop_experiment.
  log_prediction: { title: "Log a prediction before the fact (local ledger, immutable)", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  void_prediction: { title: "Void a prediction before its date (kept, with the reason; cannot be undone)", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  // Reads Suunto; writes the outcomes of due predictions to the local ledger, at most 20 per call (the next call scores the next ones), hence not idempotent.
  score_predictions: { title: "Score due predictions against Suunto's data (hit / miss / unresolvable)", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  get_prediction_stats: { title: "Get prediction statistics: hit rate, Brier score, calibration", annotations: { readOnlyHint: true, openWorldHint: false } },
  // The experiments file (experiments.json): nothing is replaced or deleted; stop keeps everything (but cannot be undone) and a corrected day log keeps the earlier answer.
  start_experiment: { title: "Start a randomized self-experiment (pre-registered, schedule drawn up front)", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  get_experiment: { title: "Get experiments: today's assignment, progress, adherence", annotations: { readOnlyHint: true, openWorldHint: false } },
  log_experiment_day: { title: "Log what actually happened on an experiment day", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  // Reads Suunto's sleep and recovery lists and the local file; writes nothing.
  analyze_experiment: { title: "Analyze an experiment: intention to treat and per protocol, permutation test", annotations: READ },
  stop_experiment: { title: "Stop an experiment (nothing is deleted, but it cannot be restarted)", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  // Reads one session's laps and FIT; writes nothing: logging the draft is a separate log_session call after the user confirmed it.
  draft_session_log: { title: "Draft a session log from the watch data (read-only; the user confirms, then log_session)", annotations: READ },
  // Reads Suunto (workouts, sleep, recovery), the local plan file and the journal; returns a proposal and writes nothing but the same rebuildable derived-data cache as get_exercise_history.
  propose_next_week: { title: "Propose next week's strength sessions (read-only: returns a proposal and a queuePayload, writes nothing)", annotations: READ },
  // The approval queue (approvals.json): queue_adjustment only adds an entry; list_approvals only reads; resolve_approval records the user's decision (the same call again returns the first result, but an
  // approve without push can be followed by the push itself, so it is not annotated idempotent) and, only with push: true on an approve, pushes NEW guides through the existing push path (never overwrites: not destructive).
  queue_adjustment: { title: "Queue a prepared change for the user's approval (local file, pushes nothing)", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  list_approvals: { title: "List the approval queue (pending, expired, done)", annotations: { readOnlyHint: true, openWorldHint: false } },
  resolve_approval: { title: "Approve or reject a queued change (push: true with approve is the only way it reaches the watch)", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  // Looks at the local files only (stat, readdir, read); changes none and never contacts Suunto.
  get_data_overview: { title: "Get an overview of the local files the server keeps (read-only)", annotations: { readOnlyHint: true, openWorldHint: false } },
  // Reads Suunto's workouts, sleep and recovery; keeps no state and writes nothing.
  simulate_plan: { title: "Simulate a candidate plan: CTL/ATL/TSB, ramp, risk days, your own response (read-only, model-based)", annotations: READ },
  get_daily_snapshot: { title: "Get daily snapshot", annotations: READ },
  get_baselines: { title: "Get personal baselines (sleep, HRV, recovery, steps)", annotations: READ },
  get_training_load: { title: "Get training load (CTL/ATL/TSB)", annotations: READ },
  forecast_training_load: { title: "Forecast training load (CTL/ATL/TSB) for planned days", annotations: READ },
  // Only returns an adjusted spec (and a queuePayload for queue_adjustment): pushing it is a separate push_strength_guide call.
  adjust_guide: { title: "Adjust a strength guide to today's recovery (returns it, pushes nothing)", annotations: READ },
  // dryRun defaults to true (validate only); a real push only ever creates new guides, never overwrites one.
  push_week_plan: { title: "Push a week of strength guides to the watch (dry run by default)", annotations: CREATE },
  export_workout_gpx: { title: "Export workout as GPX", annotations: READ },
  get_daily_activity: { title: "Get daily activity", annotations: READ },
  list_daily_activity: { title: "List daily activity", annotations: READ },
  get_sleep: { title: "Get sleep", annotations: READ },
  list_sleep: { title: "List sleep", annotations: READ },
  get_recovery: { title: "Get recovery", annotations: READ },
  list_recovery: { title: "List recovery", annotations: READ },
  get_daily_activity_statistics: { title: "Get daily activity statistics", annotations: READ },
  list_subscriptions: { title: "List webhook subscriptions", annotations: READ },
  list_routes: { title: "List routes", annotations: READ },
  get_route: { title: "Get route", annotations: READ },
  export_route: { title: "Export route as GPX", annotations: READ },
  get_upload_status: { title: "Get workout upload status", annotations: READ },
  list_guides: { title: "List SuuntoPlus guides", annotations: READ },
  upload_workout: { title: "Upload workout file", annotations: CREATE },
  upload_route: { title: "Import GPX route", annotations: CREATE },
  push_workout_guide: { title: "Push workout guide to watch", annotations: PUSH },
  push_interval_guide: { title: "Push interval guide to watch", annotations: PUSH },
  push_strength_guide: { title: "Push strength guide to watch", annotations: PUSH },
  delete_guide: {
    title: "Delete SuuntoPlus guide",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  // Appends to a history file and overwrites the averages sidecar; a re-run
  // for the same date throws instead of double-applying, hence idempotent.
  generate_daily_digest: {
    title: "Generate daily health digest",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
};
