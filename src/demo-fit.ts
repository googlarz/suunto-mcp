// Minimal FIT writer for demo mode: heart-rate records, lap messages and one
// session message — just what get_workout_fit and get_workout_rest_profile read.
// No dependency; the same encoding as test-fixtures/fit-builder.mjs (which stays
// test-only) without its developer-field support.
const FIT_EPOCH_OFFSET_S = 631065600;

function crc16(bytes: number[]): number {
  const table = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
  let crc = 0;
  for (const b of bytes) {
    let tmp = table[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ table[b & 0xf];
    tmp = table[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ table[(b >> 4) & 0xf];
  }
  return crc;
}

const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const fitTime = (unixS: number): number[] => u32(Math.round(unixS) - FIT_EPOCH_OFFSET_S);

// header 0x40 | local type, reserved, little endian, global message number, [field number, size, base type]
function definition(local: number, global: number, fields: number[][]): number[] {
  return [0x40 | local, 0, 0, ...u16(global), fields.length, ...fields.flat()];
}

const U32 = 0x86, U16 = 0x84, U8 = 0x02, ENUM = 0x00;

export interface DemoFit {
  records: { unixS: number; hr: number }[];
  laps?: { startUnixS: number; durationS: number }[];
  startUnixS: number;
  elapsedS: number;
  sport: number; // FIT sport enum: 1 running, 10 training
  subSport: number; // 0 generic, 20 strength_training
  calories: number;
  avgHr: number;
  maxHr: number;
  distanceM?: number;
}

export function buildDemoFit(f: DemoFit): Buffer {
  const body: number[] = [];
  body.push(...definition(3, 20, [[253, 4, U32], [3, 1, U8]]));
  for (const r of f.records) body.push(0x03, ...fitTime(r.unixS), r.hr);
  if (f.laps?.length) {
    body.push(...definition(4, 19, [[253, 4, U32], [2, 4, U32], [7, 4, U32]]));
    for (const l of f.laps) body.push(0x04, ...fitTime(l.startUnixS + l.durationS), ...fitTime(l.startUnixS), ...u32(Math.round(l.durationS * 1000)));
  }
  // session (18): timestamp, start_time, sport, sub_sport, total_elapsed_time, total_timer_time, total_distance (cm), total_calories, avg/max heart rate
  body.push(...definition(5, 18, [[253, 4, U32], [2, 4, U32], [5, 1, ENUM], [6, 1, ENUM], [7, 4, U32], [8, 4, U32], [9, 4, U32], [11, 2, U16], [16, 1, U8], [17, 1, U8]]));
  body.push(0x05, ...fitTime(f.startUnixS + f.elapsedS), ...fitTime(f.startUnixS), f.sport, f.subSport, ...u32(Math.round(f.elapsedS * 1000)), ...u32(Math.round(f.elapsedS * 1000)), ...u32(Math.round((f.distanceM ?? 0) * 100)), ...u16(f.calories), f.avgHr, f.maxHr);
  const header = [14, 0x20, ...u16(100), ...u32(body.length), 0x2e, 0x46, 0x49, 0x54];
  header.push(...u16(crc16(header)));
  const all = [...header, ...body];
  return Buffer.from([...all, ...u16(crc16(all))]);
}
