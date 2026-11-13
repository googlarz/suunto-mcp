import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { localDate } from "./api.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { addDays } from "./training-load.js";

export const PROMPTS = [
  {
    name: "suunto-morning",
    description: "Morning briefing: last night's sleep, recovery on waking, yesterday's load, and how ready today is.",
    arguments: [{ name: "date", description: "Day to brief for, YYYY-MM-DD (default: today).", required: false }],
  },
  {
    name: "suunto-weekly",
    description: "Weekly review: sleep, HRV, recovery and training load against the week before, plus each gym session against its plan.",
    arguments: [{ name: "endDate", description: "Last day of the review week, YYYY-MM-DD (default: yesterday).", required: false }],
  },
  {
    name: "suunto-gym-today",
    description: "Training readiness gate: decides from last night's sleep, HRV and recent load whether to train as planned or cut intensity.",
    arguments: [{ name: "date", description: "Training day, YYYY-MM-DD (default: today).", required: false }],
  },
  {
    name: "suunto-gym-review",
    description: "Review of a day's guided gym session: sets done against the plan, deviations, and heart-rate recovery in the rests.",
    arguments: [{ name: "date", description: "Day of the session, YYYY-MM-DD (default: today).", required: false }],
  },
];

const NOTES = [
  "Rules:",
  "- The night in a snapshot is the one that led INTO that date.",
  "- A snapshot section that is null is explained in `errors`: say 'no data', never guess.",
  "- Recovery Balance x100 equals the watch's Resources %. The Suunto app's single 'Recovery state %' is not available.",
  "- CTL from get_training_load can be about 1 point off the watch.",
  "- energyKcal looks like active energy, not total.",
  "Answer in the user's language.",
];

function dateArg(args: Record<string, string> | undefined, name: string, fallback: string): string {
  const v = args?.[name];
  if (v === undefined || v === "") return fallback;
  if (!isValidCalendarDate(v)) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid ${name} "${v}": expected a real calendar date as YYYY-MM-DD.`);
  }
  return v;
}

function morning(date: string): string {
  const y = addDays(date, -1);
  return [
    `Morning briefing for ${date} (yesterday = ${y}).`,
    `1. Call get_daily_snapshot ONCE with date=${y}, to=${date}. days[0] = ${y} (recovery low/high, steps, workouts). days[1] = ${date}: sleep.main is last night, recovery.morning the waking value, recovery.atBedtime the bedtime value.`,
    `2. Call get_baselines with date=${date}: the user's own band for sleep, HRV and recovery.`,
    `3. Call get_training_load with date=${y}, days=14.`,
    "4. Write a short briefing: last night (duration, score, HRV, wake-ups), recovery on waking, yesterday's load and workouts, and one concrete sentence on how ready today is. Put last night's sleep (sleepDurationS, sleepScore), HRV and waking recovery (recoveryMorning) against the user's own band: latest vs median and p25-p75 (latestVsBand). p25 null = too little history to judge; latest null = no value for last night (not synced, or a short night filed as a nap): say which.",
    "",
    ...NOTES,
  ].join("\n");
}

function weekly(end: string): string {
  const start = addDays(end, -13);
  return [
    `Weekly review of ${addDays(end, -6)} to ${end}, against the week before (${start} to ${addDays(end, -7)}).`,
    `1. Call get_daily_snapshot ONCE with date=${start}, to=${end}: 14 days, the first 7 are the week before, the last 7 the review week.`,
    `2. Call get_training_load with date=${end}, days=28.`,
    "3. For each gym session in the review week with hasLaps, call compare_workout_to_plan with its workoutKey. Check `reliable` and each deviation's `basis` before concluding; a countdown rest is not rest compliance.",
    "4. Report: sleep, HRV and recovery trend week vs week; training load trend; per gym session what the comparison shows.",
    "",
    ...NOTES,
  ].join("\n");
}

function gymToday(date: string): string {
  const y = addDays(date, -1);
  return [
    `Training readiness check for ${date}.`,
    `1. Call get_daily_snapshot with date=${date}: sleep.main is last night, recovery shows the day so far.`,
    `2. Call get_baselines with date=${date}: the user's own band (middle half of the last 28 days).`,
    `3. Call get_training_load with date=${y}, days=14.`,
    "4. Gate: if metrics.hrv.latestVsBand or metrics.sleepScore.latestVsBand is 'below', cut the planned intensity by 20-30% and say why in one line. Otherwise train as planned. If latestVsBand is null: p25 null means too little history; latest null means last night has no value (not synced yet, or a short night filed as a nap), so say the gate cannot be judged instead of 'train as planned'.",
    "",
    ...NOTES,
  ].join("\n");
}

function gymReview(date: string): string {
  return [
    `Review of the guided gym session(s) on ${date}.`,
    `1. Call get_daily_snapshot with date=${date}. Take its workouts with hasLaps true. If there are none, say so and stop.`,
    "2. For each, call compare_workout_to_plan and get_workout_rest_profile with its workoutKey.",
    "3. Check `reliable` in both results first. If false, say plainly which numbers are unreliable and why (`note`, deviation basis) and draw no conclusion from them. restMode 'countdown' makes every rest last exactly its target: that is not rest compliance.",
    "4. Report per exercise: sets done (sets.length) vs planned (planned.sets, read from the guide's labels; null when they give no count); each deviation with its code and basis (labels, plan or heuristic); rest recovery from the profile (peakHr to endHr, dropTotal, t10S/t20S/t30S, null = never reached; perExercise medians).",
    "",
    ...NOTES,
  ].join("\n");
}

export function getPrompt(name: string, args?: Record<string, string>, today: string = localDate()) {
  let text: string;
  switch (name) {
    case "suunto-morning":
      text = morning(dateArg(args, "date", today));
      break;
    case "suunto-weekly":
      text = weekly(dateArg(args, "endDate", addDays(today, -1)));
      break;
    case "suunto-gym-today":
      text = gymToday(dateArg(args, "date", today));
      break;
    case "suunto-gym-review":
      text = gymReview(dateArg(args, "date", today));
      break;
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
  const description = PROMPTS.find((p) => p.name === name)!.description;
  return { description, messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}
