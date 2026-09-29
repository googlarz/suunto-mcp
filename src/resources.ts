import { localDate, type SuuntoClient } from "./api.js";

export const RESOURCES = [
  {
    uri: "suunto://recent/workout",
    name: "Most recent workout",
    description: "Summary of the latest workout synced from your Suunto watch.",
    mimeType: "application/json",
  },
  {
    uri: "suunto://today/sleep",
    name: "Last night's sleep",
    description: "Sleep stages, duration, and score for the most recent night.",
    mimeType: "application/json",
  },
  {
    uri: "suunto://today/recovery",
    name: "Today's recovery",
    description: "Recovery balance and stress state for today.",
    mimeType: "application/json",
  },
  {
    uri: "suunto://today/activity",
    name: "Today's activity",
    description: "Steps, calories, and daily heart rate for today.",
    mimeType: "application/json",
  },
  {
    uri: "suunto://this-week/summary",
    name: "This week's training summary",
    description:
      "Aggregated workout count, total duration, and total distance for the current ISO week.",
    mimeType: "application/json",
  },
];

// Local dates: the API windows are local days (see api.ts), so a UTC date would
// name the wrong day for the first hours after local midnight.
const today = () => localDate(0);

// A sleep is filed under the date of the night it began (noon to noon, see
// api.ts nightOf) — so "last night's sleep" as of right now is filed under
// yesterday, not today.
const yesterday = () => localDate(1);

function startOfIsoWeekMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const diff = (d.getDay() + 6) % 7; // Monday-based
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

export async function readResource(
  uri: string,
  client: SuuntoClient,
): Promise<{ uri: string; mimeType: string; text: string }> {
  let payload: unknown;

  switch (uri) {
    case "suunto://recent/workout": {
      const list = await client.listWorkouts({ limit: 1 });
      payload = list.payload[0] ?? null;
      break;
    }
    case "suunto://today/sleep":
      payload = await client.getSleep(yesterday());
      break;
    case "suunto://today/recovery":
      payload = await client.getRecovery(today());
      break;
    case "suunto://today/activity":
      payload = await client.getDailyActivity(today());
      break;
    case "suunto://this-week/summary": {
      const since = startOfIsoWeekMs();
      const list = await client.listWorkouts({ since, limit: 100 });
      const items = list.payload as any[];
      const total = items.reduce(
        (acc, w) => {
          acc.count++;
          acc.totalDurationS += Number(w.totalTime ?? 0);
          acc.totalDistanceM += Number(w.totalDistance ?? 0);
          return acc;
        },
        { count: 0, totalDurationS: 0, totalDistanceM: 0 },
      );
      payload = {
        weekStartISO: new Date(since).toISOString(),
        // The same Monday as a plain local date — weekStartISO is an instant, so in
        // a zone east of UTC its UTC date reads as the Sunday before.
        weekStart: localDate(0, new Date(since)),
        ...total,
        totalDurationHours: +(total.totalDurationS / 3600).toFixed(2),
        totalDistanceKm: +(total.totalDistanceM / 1000).toFixed(2),
        workouts: items.map((w) => ({
          workoutKey: w.workoutKey,
          activityId: w.activityId,
          startTime: w.startTime,
          totalTime: w.totalTime,
          totalDistance: w.totalDistance,
        })),
      };
      break;
    }
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }

  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(payload, null, 2),
  };
}
