// @ts-ignore - no published types; package is CJS so default-import resolution varies
import FitParserModule from "fit-file-parser";
const FitParser: any = (FitParserModule as any).default ?? FitParserModule;

export interface ParsedFit {
  activity?: any;
  sessions?: any[];
  laps?: any[];
  records?: any[];
  events?: any[];
  device_infos?: any[];
}

export async function parseFit(bytes: Uint8Array): Promise<ParsedFit> {
  const parser = new FitParser({
    force: true,
    speedUnit: "km/h",
    lengthUnit: "km",
    temperatureUnit: "celsius",
    elapsedRecordField: true,
    mode: "list",
  });
  return new Promise((resolve, reject) => {
    parser.parse(Buffer.from(bytes), (err: Error | null, data: ParsedFit) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

export function summarizeFit(parsed: ParsedFit) {
  const session = parsed.sessions?.[0] ?? {};
  const records = parsed.records ?? [];
  const sample = records.length
    ? {
        first: records[0],
        middle: records[Math.floor(records.length / 2)],
        last: records[records.length - 1],
        count: records.length,
      }
    : null;
  return {
    sport: session.sport,
    sub_sport: session.sub_sport,
    start_time: session.start_time,
    total_elapsed_time_s: session.total_elapsed_time,
    total_timer_time_s: session.total_timer_time,
    total_distance_km: session.total_distance,
    total_calories: session.total_calories,
    avg_heart_rate: session.avg_heart_rate,
    max_heart_rate: session.max_heart_rate,
    avg_speed_kmh: session.avg_speed,
    max_speed_kmh: session.max_speed,
    avg_power: session.avg_power,
    max_power: session.max_power,
    total_ascent_m: session.total_ascent,
    total_descent_m: session.total_descent,
    training_effect: session.total_training_effect,
    laps: parsed.laps?.length ?? 0,
    records_sample: sample,
  };
}
