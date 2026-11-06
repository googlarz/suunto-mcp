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
  developer_data_ids?: any[];
  field_descriptions?: any[];
}

export interface DeveloperInfo {
  apps: { devIdx?: number; developerId?: number; applicationId?: string; manufacturerId?: unknown; version?: number }[];
  fields: { name: string; units: string; devIdx: number; fieldNo: number; baseType: number }[];
  devChannels: string[]; // developer fields that carry a value in at least one record
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const hex = (bytes: unknown): string | undefined =>
  Array.isArray(bytes) ? bytes.map((b) => Number(b).toString(16).padStart(2, "0")).join("") : typeof bytes === "string" ? bytes : undefined;

// SuuntoPlus apps can write extra channels into the FIT as developer fields.
// fit-file-parser lists them in developer_data_ids / field_descriptions and puts
// each value in the record under the field's own name. Null when there are none.
export function developerInfo(parsed: ParsedFit): DeveloperInfo | null {
  const ids = parsed.developer_data_ids ?? [];
  const descriptions = parsed.field_descriptions ?? [];
  if (ids.length === 0 && descriptions.length === 0) return null;
  const apps = ids.map((a: any) =>
    defined({ devIdx: a.developer_data_index, developerId: a.developer_id, applicationId: hex(a.application_id), manufacturerId: a.manufacturer_id, version: a.application_version }),
  );
  const fields = descriptions.map((d: any) => ({
    name: d.field_name as string,
    units: (d.units ?? "") as string,
    devIdx: d.developer_data_index as number,
    fieldNo: d.field_definition_number as number,
    baseType: d.fit_base_type_id as number,
  }));
  const records = parsed.records ?? [];
  const devChannels = fields.map((f) => f.name).filter((name) => records.some((r) => r?.[name] !== undefined && r[name] !== null));
  return { apps, fields, devChannels };
}

export async function parseFit(bytes: Buffer): Promise<ParsedFit> {
  const parser = new FitParser({
    force: true,
    speedUnit: "km/h",
    lengthUnit: "km",
    temperatureUnit: "celsius",
    elapsedRecordField: true,
    mode: "list",
  });
  return new Promise((resolve, reject) => {
    parser.parse(bytes, (err: Error | null, data: ParsedFit) => {
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
    // The parser is configured with lengthUnit: "km" — total_ascent/descent
    // are lengths too, so they come out in km despite the field name here
    // claiming meters. Convert, don't just relabel.
    total_ascent_m: session.total_ascent !== undefined ? session.total_ascent * 1000 : undefined,
    total_descent_m: session.total_descent !== undefined ? session.total_descent * 1000 : undefined,
    training_effect: session.total_training_effect,
    laps: parsed.laps?.length ?? 0,
    records_sample: sample,
    // SuuntoPlus app channels written into the FIT as developer fields; null when there are none.
    developer: developerInfo(parsed),
  };
}
