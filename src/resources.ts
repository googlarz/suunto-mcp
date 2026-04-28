import type { SuuntoClient } from "./api.js";

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
    description: "Recovery / HRV / stress for today.",
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

const today = () => new Date().toISOString().slice(0, 10);

function startOfIsoWeekMs(): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Monday-based
  d.setUTCDate(d.getUTCDate() - diff);
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
      payload = await client.getSleep(today());
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
