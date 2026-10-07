// MCP tool titles + annotations, applied to every tool in index.ts at startup
// (a tool with no entry here throws — see index.ts — so a new tool can't ship
// unannotated). Annotations are hints clients use: Claude Code treats
// readOnlyHint tools as safe in plan mode and for concurrent calls, and
// clients may ask before running destructive ones.
//
// Every tool talks to Suunto's cloud, so openWorldHint is true throughout.
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
  get_daily_snapshot: { title: "Get daily snapshot", annotations: READ },
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
