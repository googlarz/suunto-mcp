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
    `2. Call get_training_load with date=${y}, days=14.`,
    "3. Write a short briefing: last night (duration, score, HRV, wake-ups), recovery on waking, yesterday's load and workouts, and one concrete sentence on how ready today is.",
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
    `2. Call get_training_load with date=${y}, days=14.`,
    "3. Gate: if HRV is clearly below the user's recent level or the sleep score is low, cut the planned intensity by 20-30% and say why in one line. Otherwise train as planned.",
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
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
  const description = PROMPTS.find((p) => p.name === name)!.description;
  return { description, messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}
