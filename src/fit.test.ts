import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFit, summarizeFit } from "./fit.js";

test("fit: summarizeFit pulls session totals", () => {
  const parsed = {
    sessions: [
      {
        sport: "running",
        sub_sport: "trail",
        start_time: "2026-04-20T07:00:00Z",
        total_elapsed_time: 3600,
        total_timer_time: 3500,
        total_distance: 10.5,
        total_calories: 720,
        avg_heart_rate: 152,
        max_heart_rate: 178,
        avg_speed: 10.8,
        max_speed: 16.2,
        avg_power: 240,
        max_power: 410,
        total_ascent: 220,
        total_descent: 215,
        total_training_effect: 3.5,
      },
    ],
    laps: [{}, {}, {}],
    records: [
      { timestamp: 1, heart_rate: 130 },
      { timestamp: 2, heart_rate: 140 },
      { timestamp: 3, heart_rate: 150 },
    ],
  };
  const s = summarizeFit(parsed as any);
  assert.equal(s.sport, "running");
  assert.equal(s.sub_sport, "trail");
  assert.equal(s.total_distance_km, 10.5);
  assert.equal(s.avg_heart_rate, 152);
  assert.equal(s.max_heart_rate, 178);
  assert.equal(s.avg_power, 240);
  assert.equal(s.training_effect, 3.5);
  assert.equal(s.laps, 3);
  assert.equal(s.records_sample?.count, 3);
  assert.equal(s.records_sample?.first.heart_rate, 130);
  assert.equal(s.records_sample?.last.heart_rate, 150);
});

test("fit: summarizeFit handles empty FIT", () => {
  const s = summarizeFit({} as any);
  assert.equal(s.sport, undefined);
  assert.equal(s.records_sample, null);
  assert.equal(s.laps, 0);
});

test("fit: summarizeFit picks middle record correctly", () => {
  const records = Array.from({ length: 11 }, (_, i) => ({ idx: i }));
  const s = summarizeFit({ records } as any);
  assert.equal(s.records_sample?.middle.idx, 5);
  assert.equal(s.records_sample?.first.idx, 0);
  assert.equal(s.records_sample?.last.idx, 10);
});

// ---------- Real parser integration tests ----------

/**
 * Build a minimum-valid FIT byte stream:
 *   14-byte header  +  N data bytes  +  2-byte file CRC.
 *
 * Header layout (FIT spec):
 *   [0]    header size (14)
 *   [1]    protocol version (0x20 = 2.0)
 *   [2-3]  profile version (LE uint16)
 *   [4-7]  data size (LE uint32) — bytes between header and CRC
 *   [8-11] ".FIT" magic
 *   [12-13] header CRC (0 = skip validation)
 */
function buildMinimalFit(dataSize = 0): Uint8Array {
  const totalSize = 14 + dataSize + 2;
  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  buf[0] = 14;
  buf[1] = 0x20;
  view.setUint16(2, 100, true);
  view.setUint32(4, dataSize, true);
  buf.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  view.setUint16(12, 0, true);
  // file CRC (last 2 bytes) left as 0
  return buf;
}

test("fit: parseFit accepts a minimum-valid FIT byte stream", async () => {
  const bytes = buildMinimalFit();
  const parsed = await parseFit(bytes);
  // No data records — sessions/records should be absent or empty.
  assert.ok(parsed);
  const summary = summarizeFit(parsed);
  assert.equal(summary.sport, undefined);
  assert.equal(summary.records_sample, null);
});

test("fit: parseFit rejects obvious garbage", async () => {
  const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  await assert.rejects(parseFit(garbage));
});

test("fit: parseFit rejects empty input", async () => {
  await assert.rejects(parseFit(new Uint8Array(0)));
});
