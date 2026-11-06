// Builds the 3-file ZIP (manifest.json + guide.json + icon.png) required by
// POST /v2/guides/files. Uses STORE (uncompressed) entries — no deflate
// needed, keeps this dependency-free while still producing a valid PKZIP.
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method: store
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + file.data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralBuf, end]);
}

// Minimal 8x8 solid-gray PNG — Guide API requires an icon.png but doesn't
// need it to look like anything; watch UI doesn't render a per-guide icon.
export function buildIconPng(): Buffer {
  const size = 300; // Guide API requires exactly 300x300
  const rowBytes = 1 + size * 3; // filter byte + RGB
  const raw = Buffer.alloc(rowBytes * size, 0);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = raw[px + 1] = raw[px + 2] = 0x88;
    }
  }
  return encodePng(raw, size);
}

function encodePng(raw: Buffer, size: number): Buffer {
  function chunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Blue (#2563EB) to violet (#7C3AED); both keep a white glyph clearly readable.
const ICON_START = [37, 99, 235];
const ICON_END = [124, 58, 237];

// Olympic barbell, side view, as rounded rects mirrored around the icon
// centre: [|dx| from, |dx| to, half height, corner radius]. Plates graduate
// in size, largest next to the grip, 2-3 px apart; a small collar and the
// sleeve tip follow, all on a thin bar that spans almost the full width.
const BARBELL_RECTS: [number, number, number, number][] = [
  [0, 142, 5, 0], // bar
  [58, 78, 95, 8], // plate 1
  [80, 94, 75, 7], // plate 2
  [97, 109, 55, 6], // plate 3
  [112, 120, 20, 3], // collar
  [122, 142, 7, 7], // sleeve tip
];
const GRIP_HALF = 58; // knurled grip: |dx| < 58
const KNURL_PITCH = 6;
const KNURL_ALPHA = 0.55;

// Signed distance (px, negative inside) to a rounded rect centred on the y axis, symmetric in x.
function roundedRectDist(dx: number, dy: number, x0: number, x1: number, hh: number, r: number): number {
  const cx = (x0 + x1) / 2;
  const hw = (x1 - x0) / 2;
  const qx = Math.abs(Math.abs(dx) - cx) - (hw - r);
  const qy = Math.abs(dy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Strength guide list icon: blue to violet diagonal gradient with a white
// barbell on top. Deterministic; filter 1 (sub) per row keeps the
// smooth gradient small after deflate.
export function buildStrengthIconPng(): Buffer {
  const size = 300;
  const [c0, c1] = [ICON_START, ICON_END];
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(rowBytes * size);
  const row = new Uint8Array(size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * (size - 1));
      const dx = x + 0.5 - size / 2;
      const dy = y + 0.5 - size / 2;
      let cover = 0;
      for (const [a, b, hh, r] of BARBELL_RECTS) {
        const d = roundedRectDist(dx, dy, a, b, hh, r);
        cover = Math.max(cover, Math.min(1, Math.max(0, 0.5 - d)));
      }
      // Knurling: 2 px wide ticks every KNURL_PITCH px, 14 px tall, semi-transparent.
      const adx = Math.abs(dx);
      if (adx < GRIP_HALF) {
        const k = (adx - KNURL_PITCH / 2) / KNURL_PITCH;
        const d = roundedRectDist(Math.abs(k - Math.round(k)) * KNURL_PITCH, dy, 0, 2, 7, 0);
        cover = Math.max(cover, KNURL_ALPHA * Math.min(1, Math.max(0, 0.5 - d)));
      }
      for (let c = 0; c < 3; c++) {
        const bg = c0[c] + (c1[c] - c0[c]) * t;
        row[x * 3 + c] = Math.round(bg + (255 - bg) * cover);
      }
    }
    const start = y * rowBytes;
    raw[start] = 1; // filter: sub
    for (let i = 0; i < size * 3; i++) {
      raw[start + 1 + i] = (row[i] - (i >= 3 ? row[i - 3] : 0)) & 0xff;
    }
  }
  return encodePng(raw, size);
}

export interface GuideExercise {
  name: string;
  detail: string;
}

export interface GuidePlan {
  title: string;
  date: string; // YYYY-MM-DD
  exercises: GuideExercise[];
}

// One text step per exercise + one rest step between exercises + a closing
// "done" step. Confirmed against apizone.suunto.com/suuntoplus-guide-description:
// - a step advances via its own "transitions" array — { condition: { type:
//   "manualLap" } } jumps to the next step on lap press. createManualLap is
//   a DIFFERENT, unrelated property (only logs a lap marker for HR-window
//   averaging) — it does not advance anything.
// - "notification" is an optional per-step object (title/text) shown with a
//   vibrate/sound when that step starts — used here to confirm "next up" so
//   the lap press's effect is felt, not just seen.
// - rest steps have no target duration — a "duration" field with window:"step"
//   is a stopwatch (counts up from step start), plus a text field previewing
//   the next exercise. User decides when they're ready and laps to advance,
//   same as every other step — no auto-timeout.
export function buildGuideJson(plan: GuidePlan, ownerAppName: string) {
  const exercises = plan.exercises;
  const steps: Record<string, unknown>[] = [];

  exercises.forEach((ex, i) => {
    const isLast = i === exercises.length - 1;
    steps.push({
      type: "fields",
      title: `${i + 1}/${exercises.length}`,
      // Two separate fields, not one \n-joined string — field order is
      // priority order per the schema ("prioritize the most important
      // value as first field... watch gives best location/biggest size"),
      // so the name and detail each get their own sizing/placement instead
      // of being crammed into one small text block.
      fields: [
        { type: "text", value: truncate(ex.name, 54) },
        { type: "text", value: truncate(ex.detail, 54) },
      ],
      notification: { title: "NEXT", text: truncate(ex.name, 54) },
      transitions: [{ condition: { type: "manualLap" } }],
    });

    if (!isLast) {
      const next = exercises[i + 1];
      steps.push({
        type: "fields",
        title: "REST",
        fields: [
          { type: "duration", window: "step" },
          { type: "text", value: truncate(`Next: ${next.name}`, 54) },
          { type: "text", value: truncate(next.detail, 54) },
        ],
        transitions: [{ condition: { type: "manualLap" } }],
      });
    }
  });

  steps.push({
    type: "fields",
    title: "DONE",
    fields: [{ type: "text", value: "Session complete" }],
  });

  return {
    type: "sequence",
    name: plan.title,
    description: `${exercises.length} exercise${exercises.length === 1 ? "" : "s"}`,
    shortDescription: plan.title,
    localDate: plan.date,
    usage: "workout",
    owner: ownerAppName,
    steps,
  };
}

// Text fields are capped at 54 characters (confirmed).
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

// Confirmed (both in the docs and on-device): a text field over 40
// characters hides every OTHER field in the same step, not just itself —
// there's no "wider" or "auto-fit" option, this is the hard ceiling for a
// text field that has to coexist with e.g. a live heartRate field. Below
// 40 both render; above it the text takes over the whole screen. Every
// text field in buildStrengthGuideJson that shares a step with another
// field uses this instead of the generic 54-char truncate() cap.
const TEXT_WITH_SIBLING_FIELDS_MAX = 40;

export function buildGuideZip(plan: GuidePlan, ownerAppName: string): Buffer {
  const manifest = {
    name: plan.title,
    type: "sequence",
    owner: ownerAppName,
    description: `Gym Coach plan for ${plan.date}`,
  };
  const guide = buildGuideJson(plan, ownerAppName);

  return buildZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf8") },
    { name: "guide.json", data: Buffer.from(JSON.stringify(guide), "utf8") },
    { name: "icon.png", data: buildIconPng() },
  ]);
}

// ---------- Interval (cardio) guides ----------

export interface IntervalSegment {
  label: string; // step title, truncated to 13 chars
  durationSec?: number; // time-based auto-advance (mutually exclusive with distanceM)
  distanceM?: number; // distance-based auto-advance
  targetHrMin?: number;
  targetHrMax?: number;
  notifyText?: string; // optional vibrate + popup shown when this segment starts
}

export interface IntervalBlock {
  times?: number; // >1 wraps segments in a RepeatStep
  segments: IntervalSegment[];
}

export interface IntervalPlan {
  title: string;
  date: string; // YYYY-MM-DD
  blocks: IntervalBlock[];
}

// Auto-advancing interval steps — no lap press needed mid-run. Each segment
// is a FieldsStep with a "transitions" condition on stepDuration or
// stepDistance (the same confirmed mechanism as gym guides' manualLap
// condition, just a different condition type — both live under the same
// Transition object per the schema). RepeatStep wraps a block's segments
// when block.times > 1, matching Suunto's own Pyramid interval sample.
function buildIntervalStep(seg: IntervalSegment): Record<string, unknown> {
  const hasDuration = seg.durationSec !== undefined;
  const hasDistance = seg.distanceM !== undefined;
  if (hasDuration === hasDistance) {
    // Both optional in the type, but exactly one is required — otherwise
    // the step gets no transitions object at all and never auto-advances,
    // contradicting the "auto-advancing interval guide" this builds.
    throw new Error(
      `Interval segment "${seg.label}" must have exactly one of durationSec or distanceM (got ${
        hasDuration && hasDistance ? "both" : "neither"
      }).`,
    );
  }
  const fields: Record<string, unknown>[] = [];
  if (seg.targetHrMin !== undefined && seg.targetHrMax !== undefined) {
    fields.push({
      type: "targetHeartRate",
      value: Math.round((seg.targetHrMin + seg.targetHrMax) / 2),
      min: seg.targetHrMin,
      max: seg.targetHrMax,
    });
  }
  fields.push({ type: "heartRate" });
  if (seg.durationSec !== undefined) {
    fields.push({ type: "stepDurationCountdown", value: seg.durationSec });
  } else if (seg.distanceM !== undefined) {
    fields.push({ type: "stepDistanceCountdown", value: seg.distanceM });
  }

  const step: Record<string, unknown> = {
    type: "fields",
    title: truncate(seg.label, 13),
    fields,
  };
  if (seg.notifyText) {
    step.notification = { title: truncate(seg.label, 13), text: truncate(seg.notifyText, 54) };
  }
  if (seg.durationSec !== undefined) {
    step.transitions = [{ condition: { type: "stepDuration", value: seg.durationSec } }];
  } else if (seg.distanceM !== undefined) {
    step.transitions = [{ condition: { type: "stepDistance", value: seg.distanceM } }];
  }
  return step;
}

export function buildIntervalGuideJson(plan: IntervalPlan, ownerAppName: string) {
  const steps: Record<string, unknown>[] = [];

  for (const block of plan.blocks) {
    const segSteps = block.segments.map(buildIntervalStep);
    if (block.times && block.times > 1) {
      steps.push({ type: "repeat", times: block.times, steps: segSteps });
    } else {
      steps.push(...segSteps);
    }
  }

  steps.push({
    type: "fields",
    title: "DONE",
    fields: [{ type: "text", value: "Session complete" }],
  });

  return {
    type: "sequence",
    name: plan.title,
    description: `Interval session`,
    shortDescription: plan.title,
    localDate: plan.date,
    usage: "workout",
    owner: ownerAppName,
    steps,
  };
}

export function buildIntervalGuideZip(plan: IntervalPlan, ownerAppName: string): Buffer {
  const manifest = {
    name: plan.title,
    type: "sequence",
    owner: ownerAppName,
    description: `Interval plan for ${plan.date}`,
  };
  const guide = buildIntervalGuideJson(plan, ownerAppName);

  return buildZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf8") },
    { name: "guide.json", data: Buffer.from(JSON.stringify(guide), "utf8") },
    { name: "icon.png", data: buildIconPng() },
  ]);
}

// ---------- Strength (resistance training) guides ----------

export interface StrengthExercise {
  name: string; // e.g. "Bench Press 15°"
  detail: string; // display string, e.g. "60kg 3x10" — shown on set steps and (unless plates is given) on the prep screen before the exercise
  sets: number; // 1-100
  restSec: number; // rest between sets within this exercise. Not applied between exercises — that's the self-paced prep stopwatch
  restTargetHr?: number; // bpm 40-200 — adds a targetHeartRate gauge (40..restTargetHr) to this exercise's between-set rest steps (both restModes). Not on prep/set steps.
  plates?: string; // per-side plate breakdown for barbell exercises, e.g. "2x20+1x5/side" — shown on the prep screen INSTEAD of detail (that's the moment you're loading the bar, not mid-set). Omit for non-barbell exercises (dumbbell, machine, bodyweight, cable) — detail is shown there instead. The math is done by the caller, not this tool.
}

// Rest BETWEEN SETS only (before an exercise and between exercises is
// always a self-paced prep stopwatch, see buildPrepStep).
// "countdown" (default): rest counts down from restSec and auto-advances
// into the next set with a vibration, hands-free.
// "stopwatch": rest counts up, the user laps when ready.
export type StrengthRestMode = "countdown" | "stopwatch";

// "perSet" (default, recommended): one step per set and one per rest, so
// laps bound every individual set and rest — needed to read HR/duration
// per set from the synced workout (the point of this tool over
// push_workout_guide). "perExercise": one step for the whole exercise
// (all sets folded into ex.detail, e.g. "60kg 3x10"), like
// push_workout_guide — coarser data, but a shorter Guide list on watches
// where scrolling through every set is more friction than it's worth.
// (No between-set rests in this mode, so restMode has no effect.)
export type StrengthLapGranularity = "perSet" | "perExercise";

export interface StrengthPlan {
  title: string;
  date: string; // YYYY-MM-DD
  exercises: StrengthExercise[];
  restMode?: StrengthRestMode; // default "countdown"
  lapGranularity?: StrengthLapGranularity; // default "perSet"
}

// Step titles are cropped to 13 chars on the watch (same as interval labels).
// "<exercise>/<N> - <set>/<S>" is 13 chars at 10 of 12 exercises with 10
// sets; 3-digit set counts (up to 100 allowed) get cropped by truncate().
function strengthTitle(exIndex: number, totalExercises: number, set?: number | "REST", sets?: number): string {
  const e = `${exIndex + 1}/${totalExercises}`;
  if (set === undefined) return e;
  return truncate(set === "REST" ? `${e} REST` : `${e} - ${set}/${sets}`, 13);
}

// Two-line text field (line1 \n line2) under the 40-char limit for fields
// that share a step. The line named by `cut` is the one shortened (the
// exercise name); the other is capped at 38 so the name keeps 1+ char.
function twoLineText(line1: string, line2: string, cut: "first" | "second"): string {
  const max = TEXT_WITH_SIBLING_FIELDS_MAX;
  if (cut === "first") {
    const keep = truncate(line2, max - 2);
    return `${truncate(line1, max - 1 - keep.length)}\n${keep}`;
  }
  const keep = truncate(line1, max - 2);
  return `${keep}\n${truncate(line2, max - 1 - keep.length)}`;
}

// Popup when a set starts. The last set of an exercise announces what comes
// next (the following exercise's name) instead of repeating this one.
// Notifications are not part of lap labels (those come from step text).
function setNotification(
  ex: StrengthExercise,
  set: number,
  nextEx: StrengthExercise | undefined,
): { title: string; text: string } {
  if (set < ex.sets) return { title: `SET ${set}/${ex.sets}`, text: truncate(`${ex.name} - ${ex.detail}`, 54) };
  return {
    title: "LAST SET",
    text: truncate(nextEx ? `Next: ${nextEx.name}` : `${ex.name} - ${ex.detail}`, 54),
  };
}

function buildRestStep(
  restSec: number,
  nextFieldText: string,
  stepTitle: string,
  restMode: StrengthRestMode,
  restTargetHr?: number,
): Record<string, unknown> {
  // Optional HR gauge straight after the live HR (before the timer), same
  // shape as buildIntervalGuideJson's targetHeartRate.
  const hrFields: Record<string, unknown>[] = [{ type: "heartRate", title: "HR" }];
  if (restTargetHr !== undefined) {
    hrFields.push({ type: "targetHeartRate", value: Math.round((40 + restTargetHr) / 2), min: 40, max: restTargetHr });
  }
  // HR first (guaranteed the best slot/most likely to actually render — a
  // text field ahead of it was observed on-device to push HR off screen
  // entirely, not just get cropped as the docs describe for long text),
  // then the timer, then context text as the lowest priority.
  if (restMode === "countdown") {
    return {
      type: "fields",
      title: stepTitle,
      fields: [
        ...hrFields,
        { type: "stepDurationCountdown", value: restSec },
        { type: "text", value: truncate(nextFieldText, TEXT_WITH_SIBLING_FIELDS_MAX) },
      ],
      transitions: [{ condition: { type: "stepDuration", value: restSec } }],
    };
  }
  return {
    type: "fields",
    title: stepTitle,
    fields: [
      ...hrFields,
      { type: "duration", window: "step" },
      { type: "text", value: truncate(`${restSec}s target · ${nextFieldText}`, TEXT_WITH_SIBLING_FIELDS_MAX) },
    ],
    transitions: [{ condition: { type: "manualLap" } }],
  };
}

// Before every exercise — the very first one and each one after another
// exercise — the user needs time to walk to the station and set up the
// weight, and decides how long that takes by looking at HR. So this is
// always a self-paced stopwatch (never a countdown), advanced by a lap
// press, and shows what they're setting up for: what's being loaded (plate
// breakdown if given, otherwise the plain weight/reps detail) and the
// exercise's name. HR first (see buildRestStep's note — a text field ahead
// of a number field was observed on-device to hide the number entirely),
// then the stopwatch, then that combined into one 2-line text field (\n)
// rather than two separate text fields, to keep this to 3 fields total.
function buildPrepStep(
  ex: StrengthExercise,
  exIndex: number,
  totalExercises: number,
): Record<string, unknown> {
  const loadInfo = ex.plates ?? ex.detail;
  return {
    type: "fields",
    title: strengthTitle(exIndex, totalExercises),
    fields: [
      { type: "heartRate", title: "HR" },
      { type: "duration", window: "step" },
      { type: "text", value: twoLineText(loadInfo, ex.name, "second") },
    ],
    transitions: [{ condition: { type: "manualLap" } }],
  };
}

// Neither push_workout_guide (one lap per whole exercise) nor
// push_interval_guide (auto-advance only) fits resistance training on its
// own — this tool sits between them. Session flow:
//   prep (stopwatch) → set 1 → rest → set 2 → ... → last set
//   → prep for the next exercise (stopwatch) → set 1 → ... → DONE
// - Prep, set: end on a lap press (the user decides when they're set up
//   and when their reps are done). The press is itself logged as a manual
//   lap by the watch (confirmed behavior, also relied on by
//   buildGuideJson's REST step), so those boundaries need no bookkeeping.
// - Rest between sets, restMode "countdown" (default): auto-advances after
//   restSec with no button press, so nothing marks the next set's start —
//   that set step gets createManualLap: true (a lap the instant it begins)
//   to keep every set and rest in its own lap. restMode "stopwatch": ends
//   on a lap press like the others, no createManualLap needed.
// - lapGranularity "perSet" (default): sets are unrolled as explicit steps
//   (RepeatStep can't show a live "current iteration" counter, so this
//   can't use RepeatStep — same as buildGuideJson's exercises.forEach).
// - lapGranularity "perExercise": one work step per exercise after its
//   prep, like buildGuideJson; no between-set rests, so restMode is moot.
//
// Titles carry the counters: prep "4/7", set "4/7 - 2/3", rest "4/7 REST"
// (its text spells out "Next: set 3/3"). perExercise work steps are "4/7". Lap
// labels are built from step TEXT, never from titles, so titles are free.
//
// Field layout: 2 fields on the work step, 3 on rest/prep (well inside the
// 4-5 max), ordered by priority — the schema gives the first field the
// best placement/biggest size. heartRate is always first: confirmed
// on-device that a text field ahead of it can hide it entirely rather than
// just cropping (unlike the docs' description of long text cropping other
// fields), so HR gets the guaranteed slot on every step. Name/detail
// (and detail/name on prep) are combined into one \n-joined text field
// instead of two separate ones, to keep total field counts low.
export function buildStrengthGuideJson(plan: StrengthPlan, ownerAppName: string) {
  const exercises = plan.exercises;
  const steps: Record<string, unknown>[] = [];
  const totalExercises = exercises.length;
  for (const ex of exercises) {
    if (ex.restTargetHr !== undefined && (!Number.isInteger(ex.restTargetHr) || ex.restTargetHr < 40 || ex.restTargetHr > 200)) {
      throw new Error(`Exercise "${ex.name}": restTargetHr must be an integer from 40 to 200 bpm (got ${ex.restTargetHr}).`);
    }
  }
  const restMode = plan.restMode ?? "countdown";
  const lapGranularity = plan.lapGranularity ?? "perSet";

  exercises.forEach((ex, exIndex) => {
    steps.push(buildPrepStep(ex, exIndex, totalExercises));

    if (lapGranularity === "perExercise") {
      steps.push({
        type: "fields",
        title: strengthTitle(exIndex, totalExercises),
        fields: [
          { type: "heartRate", title: "HR" },
          { type: "text", value: twoLineText(ex.name, ex.detail, "first") },
        ],
        notification: { title: "GO", text: truncate(ex.name, 54) },
        transitions: [{ condition: { type: "manualLap" } }],
      });
      return;
    }

    for (let set = 1; set <= ex.sets; set++) {
      const isLastSet = set === ex.sets;
      const step: Record<string, unknown> = {
        type: "fields",
        title: strengthTitle(exIndex, totalExercises, set, ex.sets),
        // HR first — a text field ahead of it was observed on-device to
        // hide it entirely, not just crop it as the docs describe for long
        // text (see buildRestStep). Name+detail combined into one 2-line
        // text field (\n) instead of two separate fields.
        fields: [
          { type: "heartRate", title: "HR" },
          { type: "text", value: twoLineText(ex.name, ex.detail, "first") },
        ],
        notification: setNotification(ex, set, exercises[exIndex + 1]),
        transitions: [{ condition: { type: "manualLap" } }],
      };
      // Set 1 follows a prep stopwatch that ended on a lap press; later
      // sets follow a rest, which only needs the extra lap if it auto-advanced.
      if (set > 1 && restMode === "countdown") step.createManualLap = true;
      steps.push(step);

      if (!isLastSet) {
        steps.push(
          buildRestStep(
            ex.restSec,
            `Next: set ${set + 1}/${ex.sets}`,
            strengthTitle(exIndex, totalExercises, "REST"),
            restMode,
            ex.restTargetHr,
          ),
        );
      }
    }
  });

  steps.push({
    type: "fields",
    title: "DONE",
    fields: [{ type: "text", value: "Session complete" }],
  });

  return {
    type: "sequence",
    name: plan.title,
    // No documented max for description; 60 is a conservative guess (unverified on-device).
    description: truncate(exercises.map((e) => e.name).join(" · "), 60),
    shortDescription: truncate(plan.title, 23),
    localDate: plan.date,
    usage: "workout",
    owner: ownerAppName,
    steps,
  };
}

export function buildStrengthGuideZip(plan: StrengthPlan, ownerAppName: string): Buffer {
  const manifest = {
    name: plan.title,
    type: "sequence",
    owner: ownerAppName,
    description: `Strength plan for ${plan.date}`,
  };
  const guide = buildStrengthGuideJson(plan, ownerAppName);

  return buildZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf8") },
    { name: "guide.json", data: Buffer.from(JSON.stringify(guide), "utf8") },
    { name: "icon.png", data: buildStrengthIconPng() },
  ]);
}
