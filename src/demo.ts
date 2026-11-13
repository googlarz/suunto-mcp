// Demo mode (SUUNTO_DEMO=1): the whole server on synthetic data, with no
// credentials and no network, so a new user can try every tool and prompt while
// Suunto still reviews their API application.
//
// DemoClient extends SuuntoClient and replaces only the two transport methods,
// json() and bytes(). Everything above them — listWorkouts paging, the day and
// night bucketing, the snapshot / baselines / training-load / lap shaping —
// runs unchanged on API-shaped responses generated here. Every day's data is a
// pure function of (seed, date); "today" only decides which days exist and how
// much of the current day has happened by `now`.
import { SuuntoClient, localDate } from "./api.js";
import { loadConfig } from "./config.js";
import { SuuntoEmptyResponseError, SuuntoNotFoundError } from "./errors.js";
import { addDays } from "./training-load.js";
import { buildDemoFit } from "./demo-fit.js";

export const isDemo = (env: NodeJS.ProcessEnv = process.env): boolean => env.SUUNTO_DEMO === "1";

export const DEMO_NOTICE = "DEMO DATA (synthetic) — set real Suunto credentials to see your own.";

export const DEMO_INSTRUCTIONS =
  `DEMO MODE is on (SUUNTO_DEMO=1). ${DEMO_NOTICE} Every tool result carries "demo": true; the numbers are generated, not measured. ` +
  "Tell the user so whenever you present them. Nothing is sent to Suunto and no tool writes anything.";

// Applied to every successful tool result, in one place (index.ts text()). Tool
// results are JSON text, so the marker is a field, not a prefix line that would
// break a client's JSON.parse: an object gets a top-level `demo: true`; anything
// else (an array, a string such as a GPX file) becomes { demo: true, data }.
export function markDemo(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  const out = value !== null && typeof value === "object" && !Array.isArray(value) ? { demo: true, ...value } : { demo: true, data: value };
  return JSON.stringify(out, null, /^[[{]\n/.test(text) ? 2 : undefined);
}

const WRITE_EFFECT: Record<string, string> = {
  upload_workout: "upload your .fit/.gpx file to Suunto and start processing it",
  upload_route: "import your .gpx file as a route on your Suunto account",
  push_workout_guide: "build the SuuntoPlus guide and push it to your Suunto account",
  push_interval_guide: "build the interval guide and push it to your Suunto account",
  push_strength_guide: "build the strength guide and push it to your Suunto account",
  delete_guide: "permanently delete that guide from your Suunto account",
  log_session: "save what you say happened in that session to your local training journal",
  generate_daily_digest: "compute the day's digest, append it to your history file and update the averages file",
};

// What a non-read-only tool returns in demo mode instead of writing anything.
export function demoWriteResult(tool: string): string {
  const effect = WRITE_EFFECT[tool] ?? "change data on your Suunto account";
  return JSON.stringify({
    message: `Demo mode: nothing was written and nothing left this machine. With real Suunto credentials, ${tool} would ${effect}.`,
  });
}

// ---------- deterministic randomness ----------

function rngFor(seed: number, key: string): () => number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY_MS = 86_400_000;
const epochDay = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday

// ---------- the synthetic training programme ----------

interface Exercise { name: string; sets: number; reps: number; kg: number; restS: number }
const PROGRAMME: Record<number, { guide: string; exercises: Exercise[] }> = {
  1: { guide: "PUSH A", exercises: [
    { name: "Bench Press", sets: 4, reps: 8, kg: 70, restS: 90 },
    { name: "Overhead Press", sets: 3, reps: 8, kg: 40, restS: 90 },
    { name: "Incline DB Press", sets: 3, reps: 10, kg: 24, restS: 75 },
    { name: "Triceps Pushdown", sets: 3, reps: 12, kg: 30, restS: 60 },
  ] },
  3: { guide: "PULL B", exercises: [
    { name: "Barbell Row", sets: 4, reps: 8, kg: 60, restS: 90 },
    { name: "Lat Pulldown", sets: 3, reps: 10, kg: 55, restS: 75 },
    { name: "Seated Cable Row", sets: 3, reps: 12, kg: 50, restS: 60 },
    { name: "Biceps Curl", sets: 3, reps: 12, kg: 14, restS: 60 },
  ] },
  5: { guide: "LEGS C", exercises: [
    { name: "Back Squat", sets: 4, reps: 5, kg: 90, restS: 120 },
    { name: "Romanian Deadlift", sets: 3, reps: 8, kg: 80, restS: 120 },
    { name: "Leg Press", sets: 3, reps: 10, kg: 140, restS: 90 },
  ] },
};
const MAX_HR = 185;
const HR_ZONE_EDGES = [0.6, 0.7, 0.8, 0.9].map((f) => f * MAX_HR);
const GUIDE_IDS: Record<string, string> = { "PUSH A": "demo0001", "PULL B": "demo0002", "LEGS C": "demo0003" };

interface DemoLap { off: number; dur: number; kind: "prep" | "set" | "rest" | "done"; label: string; min: number; avg: number; max: number; kcal: number }

interface DemoWorkout {
  key: string;
  startMs: number;
  durationS: number;
  base: any; // the scalar fields of a list item / workout summary
  summary: any; // SummaryExtension
  intensity: any; // IntensityExtension
  laps: DemoLap[] | null;
  hr: number[]; // one value per second
  sport: number;
  distanceM: number;
}

const ROUTES = [
  { id: "d3e000000000000000000001", description: "Riverside loop (demo)", distance: 8200, lat: 52.5145, lon: 13.35, rx: 0.012, ry: 0.007 },
  { id: "d3e000000000000000000002", description: "Forest hill circuit (demo)", distance: 12400, lat: 52.45, lon: 13.2, rx: 0.02, ry: 0.011 },
];

export class DemoClient extends SuuntoClient {
  private readonly offsetMin: number;
  private readonly today: string;
  private readonly firstDay: string;
  private readonly cache = new Map<string, any>();
  private workoutList: DemoWorkout[] | undefined;

  // `now` decides which days exist (about 8 weeks ending today) and how much of
  // today has happened; `seed` varies the whole data set.
  constructor(private readonly clock: Date = new Date(), private readonly seed = 2026) {
    super(loadConfig());
    this.offsetMin = -clock.getTimezoneOffset();
    this.today = localDate(0, clock);
    this.firstDay = addDays(this.today, -55);
  }

  // ---------- time helpers (the watch's local time = this machine's) ----------

  private ms(date: string, minutes: number): number {
    return Date.parse(`${date}T00:00:00Z`) + (minutes - this.offsetMin) * 60_000;
  }

  private stamp(instantMs: number): string {
    const local = new Date(instantMs + this.offsetMin * 60_000).toISOString().slice(0, 23);
    const a = Math.abs(this.offsetMin);
    return `${local}${this.offsetMin < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
  }

  private inWindow(date: string): boolean {
    return date >= this.firstDay && date <= this.today;
  }

  private memo<T>(key: string, make: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key);
  }

  private rng(key: string) {
    return rngFor(this.seed, key);
  }

  // ---------- sleep: the night that begins on the evening of `date` ----------

  private night(date: string): { rows: any[]; score: number | null; wakeMin: number | null } {
    return this.memo(`night:${date}`, () => {
      const empty = { rows: [], score: null, wakeMin: null };
      if (!this.inWindow(date)) return empty;
      const r = this.rng(`sleep:${date}`);
      const bedMin = 22 * 60 + 15 + Math.floor(r() * 90);
      const short = r() < 0.08;
      const durS = Math.round((short ? 4.6 + r() * 0.8 : 6.3 + r() * 1.9) * 3600);
      const start = this.ms(date, bedMin);
      const end = start + durS * 1000;
      const rows: any[] = [];
      let score: number | null = null;
      let wakeMin: number | null = null;
      if (end <= this.clock.getTime()) {
        const deep = Math.round(durS * (0.16 + r() * 0.07));
        const rem = Math.round(durS * (0.2 + r() * 0.06));
        score = Math.round(clamp(45 + (durS / 3600 - 5) * 9 + (r() - 0.4) * 14, 38, 96));
        wakeMin = bedMin + Math.round(durS / 60) - 1440;
        rows.push({
          timestamp: this.stamp(start),
          entryData: {
            SleepId: epochDay(date) * 10,
            IsNap: false,
            BedtimeStart: this.stamp(start),
            BedtimeEnd: this.stamp(end),
            Duration: durS,
            DeepSleepDuration: deep,
            REMSleepDuration: rem,
            LightSleepDuration: durS - deep - rem,
            SleepQualityScore: score,
            AvgHRV: r1(46 + r() * 22 - (short ? 8 : 0)),
            HRAvg: r1(52 + r() * 7),
            HRMin: Math.round(46 + r() * 6),
            MaxSpo2: Math.round(96 + r() * 3),
            SleepOnsetLatencyDuration: Math.round(300 + r() * 900),
            WakeAfterSleepOnsetDuration: Math.round(600 + r() * 1800),
            WakeBeforeOffBedDuration: Math.round(120 + r() * 600),
          },
        });
      }
      // an afternoon nap that day: filed with the night after it, flagged IsNap
      if (r() < 0.18) {
        const napStart = this.ms(date, 13 * 60 + 30 + Math.floor(r() * 60));
        const napS = Math.round(1200 + r() * 1200);
        if (napStart + napS * 1000 <= this.clock.getTime()) {
          rows.push({
            timestamp: this.stamp(napStart),
            entryData: {
              SleepId: epochDay(date) * 10 + 1,
              IsNap: true,
              BedtimeStart: this.stamp(napStart),
              BedtimeEnd: this.stamp(napStart + napS * 1000),
              Duration: napS,
              SleepQualityScore: Math.round(50 + r() * 20),
              AvgHRV: r1(40 + r() * 15),
              HRAvg: r1(58 + r() * 6),
              HRMin: Math.round(52 + r() * 6),
            },
          });
        }
      }
      return { rows, score, wakeMin };
    });
  }

  // ---------- recovery (Balance 0-1, a sample every 30 minutes) ----------

  private morningBalance(date: string): number {
    const score = this.night(addDays(date, -1)).score ?? 62;
    return clamp(0.58 + ((score - 63) / 100) * 0.9 + (this.rng(`rec:${date}`)() - 0.5) * 0.1, 0.4, 0.97);
  }

  private recoveryRows(date: string): any[] {
    if (!this.inWindow(date)) return [];
    const r = this.rng(`recday:${date}`);
    const morning = this.morningBalance(date);
    const prevEvening = clamp(this.morningBalance(addDays(date, -1)) - 0.3, 0.1, 1);
    const wake = this.night(addDays(date, -1)).wakeMin ?? 6 * 60 + 45;
    const rows: any[] = [];
    for (let m = 0; m < 1440; m += 30) {
      const at = this.ms(date, m);
      if (at > this.clock.getTime()) break;
      let balance: number;
      if (m < wake) {
        const x = m / wake;
        balance = prevEvening + (morning - prevEvening) * (x * x * (3 - 2 * x)); // recharges while asleep
      } else {
        balance = morning - 0.3 * Math.pow(clamp((m - wake) / (22 * 60 - wake), 0, 1), 0.8); // drains through the day
      }
      balance = clamp(balance + (r() - 0.5) * 0.03, 0.05, 1);
      rows.push({ timestamp: this.stamp(at), entryData: { Balance: r2(balance), StressState: m >= wake && m < 22 * 60 && r() < 0.35 ? 2 : 1 } });
    }
    return rows;
  }

  // ---------- 24/7 activity (a sample every 10 minutes) ----------

  private activityRows(date: string): any[] {
    return this.memo(`act:${date}`, () => {
      if (!this.inWindow(date)) return [];
      const r = this.rng(`act:${date}`);
      const ran = this.workouts().some((w) => w.sport === 1 && this.dateOf(w) === date);
      const steps = 5500 + r() * 5000 + (ran ? 3000 : 0);
      const kcal = 650 + r() * 450 + (ran ? 250 : 0);
      const wake = this.night(addDays(date, -1)).wakeMin ?? 6 * 60 + 45;
      const bed = 22 * 60 + 45;
      const weight = (slot: number) => {
        const m = slot * 10;
        return m < wake || m >= bed ? 0 : (0.25 + r()) * (1 + 0.8 * Math.sin(((m - wake) / (bed - wake)) * Math.PI));
      };
      const weights = Array.from({ length: 144 }, (_, s) => weight(s));
      const total = weights.reduce((a, b) => a + b, 0);
      const rows: any[] = [];
      for (let s = 0; s < 144; s++) {
        const at = this.ms(date, s * 10);
        if (at > this.clock.getTime()) break;
        const share = weights[s] / total;
        rows.push({
          timestamp: this.stamp(at),
          entryData: {
            HR: Math.round(weights[s] === 0 ? 52 + r() * 6 : 62 + r() * 22),
            StepCount: Math.round(steps * share),
            EnergyConsumption: Math.round(kcal * share * 4184),
          },
        });
      }
      return rows;
    });
  }

  // ---------- workouts ----------

  private dateOf(w: DemoWorkout): string {
    return new Date(w.startMs + this.offsetMin * 60_000).toISOString().slice(0, 10);
  }

  private workouts(): DemoWorkout[] {
    if (this.workoutList) return this.workoutList;
    const built: DemoWorkout[] = [];
    for (let date = this.firstDay; date <= this.today; date = addDays(date, 1)) {
      const dow = weekday(date);
      const r = this.rng(`day:${date}`);
      const run = dow === 6 || (dow === 2 && r() < 0.55);
      if (run) built.push(this.run(date, dow === 6));
      else if (PROGRAMME[dow]) built.push(this.gym(date));
    }
    // the third most recent completed gym session carries the planted deviation
    const oddKey = built.filter((w) => w.laps && w.startMs + w.durationS * 1000 <= this.clock.getTime()).slice(-3)[0]?.key;
    this.workoutList = built
      .filter((w) => w.startMs + w.durationS * 1000 <= this.clock.getTime())
      .map((w) => (w.key === oddKey ? this.gym(this.dateOf(w), true) : w))
      .sort((a, b) => b.startMs - a.startMs);
    return this.workoutList;
  }

  private finish(key: string, startMs: number, activityId: number, hr: number[], laps: DemoLap[] | null, o: { distanceM: number; ascent: number; kcal: number; tss: number; recoveryS: number; guide?: string; sport: number }): DemoWorkout {
    const durationS = hr.length;
    const avg = Math.round(hr.reduce((a, b) => a + b, 0) / hr.length);
    const max = Math.max(...hr);
    const zoneS = [0, 0, 0, 0, 0];
    for (const h of hr) zoneS[HR_ZONE_EDGES.filter((e) => h >= e).length]++;
    const tss = r1(o.tss);
    return {
      key,
      startMs,
      durationS,
      sport: o.sport,
      distanceM: o.distanceM,
      laps,
      hr,
      base: {
        workoutKey: key,
        activityId,
        startTime: startMs,
        stopTime: startMs + durationS * 1000,
        timeOffsetInMinutes: this.offsetMin,
        totalTime: laps ? r1(laps.reduce((a, l) => a + l.dur, 0)) : durationS,
        totalDistance: o.distanceM,
        totalAscent: o.ascent,
        totalDescent: o.ascent,
        energyConsumption: o.kcal,
        hrdata: { avg, max: MAX_HR, workoutAvgHR: avg, workoutMaxHR: max },
        tss: { trainingStressScore: tss, calculationMethod: "HR" },
        tssList: [{ calculationMethod: "HR", trainingStressScore: tss }],
        recoveryTime: o.recoveryS,
        extensionTypes: laps ? ["SUMMARY", "INTENSITY", "MANUALLAP"] : ["SUMMARY", "INTENSITY"],
      },
      summary: {
        type: "SummaryExtension",
        pte: r1(laps ? 1.6 + (avg - 100) / 40 : 2.4 + (avg - 130) / 25),
        peakEpoc: Math.round(laps ? 14 + (max - 120) / 3 : 35 + (max - 150)),
        recoveryTime: o.recoveryS,
        apps: o.guide ? [{ name: o.guide, authorId: "demo", id: GUIDE_IDS[o.guide] }] : [],
        feeling: null,
      },
      intensity: {
        type: "IntensityExtension",
        zones: { heartRate: Object.fromEntries(zoneS.map((s, i) => [`zone${i + 1}`, { totalTime: s }])) },
      },
    };
  }

  private gym(date: string, odd = false): DemoWorkout {
    const dow = weekday(date);
    const tpl = PROGRAMME[dow];
    const r = this.rng(`gym:${date}`);
    const progress = 2.5 * Math.floor((Math.floor((epochDay(date) + 3) / 7) % 8) / 2);
    const laps: DemoLap[] = [];
    let off = 0;
    let hr = 88 + r() * 8;
    const add = (kind: DemoLap["kind"], dur: number, label: string, min: number, avg: number, max: number) => {
      laps.push({ off: r1(off), dur: r1(dur), kind, label, min: Math.round(min), avg: Math.round(avg), max: Math.round(max), kcal: Math.round(dur * (kind === "rest" ? 0.07 : 0.1)) });
      off += r1(dur);
    };
    tpl.exercises.forEach((ex, i) => {
      const detail = `${ex.kg + progress}kg ${ex.sets}x${ex.reps}`;
      add("prep", 70 + r() * 60, `${detail} | ${ex.name}`, hr - 3, hr + 2, hr + 8);
      hr += 2;
      const base = 28 + r() * 14;
      for (let k = 1; k <= ex.sets; k++) {
        const end = Math.min(hr + 16 + r() * 12, 168);
        // a forgotten lap press: the third set of the first exercise swallows an extra effort
        add("set", odd && i === 0 && k === 3 ? base * 2.5 : base * (0.9 + r() * 0.2), `${ex.name} | ${detail}`, hr - 2, (hr + end) / 2, end + 3);
        hr = end;
        if (k < ex.sets) {
          const peak = hr + 4;
          const low = Math.max(peak - (ex.restS * 0.22 + r() * 6), 85);
          add("rest", ex.restS, `Next: set ${k + 1}/${ex.sets}`, low, (peak + low) / 2, peak);
          hr = low;
        }
      }
    });
    add("done", 2 + r() * 2, "Session complete", hr - 2, hr, hr + 2);
    if (odd) {
      // two laps pressed after the guide ended: work that belongs to no exercise
      add("done", 30 + r() * 10, "Session complete", hr, hr + 6, hr + 12);
      add("done", 2, "Session complete", hr, hr + 2, hr + 3);
    }
    const hrSeries: number[] = [];
    for (let t = 0; t < Math.ceil(off); t++) {
      const l = laps.find((x) => t >= x.off && t < x.off + x.dur) ?? laps[laps.length - 1];
      const f = clamp((t - l.off) / l.dur, 0, 1);
      hrSeries.push(clamp(Math.round(l.kind === "rest" ? l.max - (l.max - l.min) * f : l.kind === "done" ? l.avg : l.min + (l.max - l.min) * f), 40, 190));
    }
    const kcal = laps.reduce((a, l) => a + l.kcal, 0);
    const startMs = this.ms(date, 6 * 60 + 45 + Math.floor(this.rng(`gymstart:${date}`)() * 60));
    const tss = (hrSeries.length / 3600) * Math.pow(hrSeries.reduce((a, b) => a + b, 0) / hrSeries.length / 168, 2) * 100 * 1.15;
    return this.finish(this.key(date, 1), startMs, 23, hrSeries, laps, { distanceM: 0, ascent: 0, kcal, tss, recoveryS: 14_400 + Math.round(r() * 7200), guide: tpl.guide, sport: 10 });
  }

  private run(date: string, long: boolean): DemoWorkout {
    const r = this.rng(`run:${date}`);
    const durS = Math.round((long ? 62 + r() * 28 : 36 + r() * 22) * 60);
    const avg = long ? 144 + r() * 6 : 148 + r() * 6;
    const hrSeries: number[] = [];
    for (let t = 0; t < durS; t++) {
      const ramp = Math.min(1, t / 420);
      hrSeries.push(clamp(Math.round(98 + (avg - 98) * ramp + 4 * Math.sin(t / 170) + (r() - 0.5) * 3), 60, 180));
    }
    const mean = hrSeries.reduce((a, b) => a + b, 0) / durS;
    const paceSPerKm = 335 + r() * 45;
    const startMs = this.ms(date, (long ? 8 * 60 + 15 : 17 * 60 + 30) + Math.floor(r() * 30));
    const tss = (durS / 3600) * Math.pow(mean / 168, 2) * 100;
    return this.finish(this.key(date, 2), startMs, 3, hrSeries, null, {
      distanceM: Math.round((durS / paceSPerKm) * 1000),
      ascent: Math.round(20 + r() * 110),
      kcal: Math.round((durS / 60) * 11.2),
      tss,
      recoveryS: 32_400 + Math.round(r() * 14_400),
      sport: 1,
    });
  }

  // 24 hex characters, like a real workoutKey; the date and kind are readable in it
  private key(date: string, n: number): string {
    return `d3e0${date.replaceAll("-", "")}0${n}0000000000`;
  }

  private find(key: string): DemoWorkout | undefined {
    return this.workouts().find((w) => w.key === key);
  }

  private workoutBody(w: DemoWorkout, wanted: string[]) {
    const extensions: any[] = [];
    if (wanted.includes("SummaryExtension")) extensions.push(w.summary);
    if (wanted.includes("IntensityExtension")) extensions.push(w.intensity);
    if (wanted.includes("ManualLapStreamExtension") && w.laps) {
      extensions.push({
        type: "ManualLapStreamExtension",
        markers: w.laps.map((l) => ({
          startTime: w.startMs + Math.round(l.off * 1000),
          endTime: w.startMs + Math.round((l.off + l.dur) * 1000),
          totals: { duration: l.dur, energy: l.kcal, hr: { min: l.min, avg: l.avg, max: l.max }, intervalNotes: l.label.replaceAll(" | ", "\f") },
        })),
      });
    }
    return { error: null, payload: { ...w.base, ...(extensions.length ? { extensions } : {}) }, metadata: {} };
  }

  private fit(w: DemoWorkout): Buffer {
    const t0 = w.startMs / 1000;
    const max = Math.max(...w.hr);
    return buildDemoFit({
      records: w.hr.map((hr, t) => ({ unixS: t0 + t, hr })),
      laps: w.laps?.map((l) => ({ startUnixS: t0 + l.off, durationS: l.dur })),
      startUnixS: t0,
      elapsedS: w.base.totalTime,
      sport: w.sport,
      subSport: w.sport === 10 ? 20 : 0,
      calories: w.base.energyConsumption,
      avgHr: w.base.hrdata.workoutAvgHR,
      maxHr: max,
      distanceM: w.distanceM,
    });
  }

  // ---------- routes, guides ----------

  private route(i: number) {
    const x = ROUTES[i];
    const modified = this.clock.getTime() - (i + 3) * 9 * DAY_MS;
    return {
      id: x.id,
      description: x.description,
      visibility: "PRIVATE",
      activityIds: [3],
      startPoint: { altitude: 38, latitude: x.lat, longitude: x.lon + x.rx },
      centerPoint: { altitude: 41, latitude: x.lat, longitude: x.lon },
      endPoint: { altitude: 38, latitude: x.lat, longitude: x.lon + x.rx },
      totalDistance: x.distance,
      averageSpeed: 2.9,
      created: modified - DAY_MS,
      modified,
      watchEnabled: i === 0,
      turnWaypointsEnabled: false,
    };
  }

  private gpx(i: number): Buffer {
    const x = ROUTES[i];
    const pts = Array.from({ length: 48 }, (_, k) => {
      const a = (k / 47) * 2 * Math.PI;
      return `<rtept lat="${(x.lat + x.ry * Math.sin(a)).toFixed(5)}" lon="${(x.lon + x.rx * Math.cos(a)).toFixed(5)}"><ele>${Math.round(40 + 6 * Math.sin(2 * a))}</ele></rtept>`;
    });
    return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="suunto-mcp demo"><rte><name>${x.description}</name>${pts.join("")}</rte></gpx>`);
  }

  private routeIndex(path: string): number {
    const id = decodeURIComponent(path.split("/")[3] ?? "");
    const i = ROUTES.findIndex((x) => x.id === id);
    if (i < 0) throw new SuuntoNotFoundError(path, "Resource not found (demo mode has two routes: see list_routes).");
    return i;
  }

  // ---------- the transport: API paths in, API-shaped bodies out ----------

  override async json<T>(path: string): Promise<T> {
    const url = new URL(path, "https://demo.invalid");
    const p = url.pathname;
    const q = url.searchParams;
    const bounds = (): [number, number] => [Number(q.get("from")), Number(q.get("to"))];
    const between = (rows: any[]) => {
      const [from, to] = bounds();
      return rows.filter((r) => Date.parse(r.timestamp) >= from && Date.parse(r.timestamp) <= to);
    };
    const days = (): string[] => {
      const [from, to] = bounds();
      const all: string[] = [];
      for (let d = addDays(this.firstDay, -1); d <= addDays(this.today, 1); d = addDays(d, 1)) if (this.ms(d, 1440) > from && this.ms(d, 0) < to) all.push(d);
      return all;
    };

    let body: unknown;
    if (p === "/v3/workouts/") {
      const since = q.has("since") ? Number(q.get("since")) : -Infinity;
      const until = q.has("until") ? Number(q.get("until")) : Infinity;
      const offset = Number(q.get("offset") ?? 0);
      const limit = Number(q.get("limit") ?? 50);
      const all = this.workouts().filter((w) => w.startMs >= since && w.startMs <= until);
      body = {
        payload: all.slice(offset, offset + limit).map((w) => ({ ...w.base, extensions: [w.summary, w.intensity] })),
        metadata: { count: all.length },
      };
    } else if (/^\/v3\/workouts\/[0-9a-f]{24}$/.test(p)) {
      const w = this.find(p.split("/")[3]);
      if (!w) throw new SuuntoEmptyResponseError(p);
      body = this.workoutBody(w, (q.get("extensions") ?? "").split(","));
    } else if (p.endsWith("/sleep")) {
      body = between(days().flatMap((d) => this.night(d).rows));
    } else if (p.endsWith("/recovery")) {
      body = between(days().flatMap((d) => this.recoveryRows(d)));
    } else if (p.endsWith("/activity")) {
      body = between(days().flatMap((d) => this.activityRows(d)));
    } else if (p === "/247/daily-activity-statistics") {
      const from = (q.get("startdate") ?? "").slice(0, 10);
      const to = (q.get("enddate") ?? "").slice(0, 10);
      const metric = (Name: string, value: (rows: any[]) => number) => {
        const Samples = [];
        for (let d = from; d <= to; d = addDays(d, 1)) {
          const rows = this.activityRows(d);
          if (rows.length) Samples.push({ TimeISO8601: `${d}T12:00:00${this.stamp(0).slice(23)}`, Value: value(rows) });
        }
        return { Name, Aggregation: "sum", Sources: [{ Samples }] };
      };
      body = [metric("stepcount", (rows) => rows.reduce((a, r) => a + r.entryData.StepCount, 0)), metric("energyconsumption", (rows) => rows.reduce((a, r) => a + r.entryData.EnergyConsumption, 0))];
    } else if (p === "/v2/route") {
      body = ROUTES.map((_, i) => this.route(i));
    } else if (/^\/v2\/route\/[^/]+$/.test(p)) {
      body = this.route(this.routeIndex(p));
    } else if (p === "/v2/guides/items") {
      // The real list: { error, payload, metadata } with every field of a listed guide, null where it usually is.
      const payload = Object.entries(GUIDE_IDS).map(([name, id], i) => {
        const modified = this.clock.getTime() - (i + 1) * 3 * DAY_MS;
        return {
          id, username: "demo", type: "sequence", modificationTime: modified, fileModificationTime: modified, name,
          description: PROGRAMME[[1, 3, 5][i]].exercises.map((e) => e.name).join(" · ").slice(0, 60), shortDescription: name, owner: "demo",
          url: null, iconUrl: null, backgroundUrl: null, richText: null, activities: null, localDate: this.today, usage: "workout",
          pinned: false, externalId: null, ownerId: null, catalogueId: null, extended: null,
        };
      });
      body = { error: null, payload, metadata: { ts: this.clock.getTime() } };
    } else if (p === "/v2/subscriptions") {
      body = [];
    } else {
      throw new SuuntoNotFoundError(p, "Not available in demo mode.");
    }
    return JSON.parse(JSON.stringify(body)) as T;
  }

  override async bytes(path: string): Promise<Buffer> {
    const p = new URL(path, "https://demo.invalid").pathname;
    const fit = /^\/v3\/workouts\/([0-9a-f]{24})\/fit$/.exec(p);
    if (fit) {
      const w = this.find(fit[1]);
      if (!w) throw new SuuntoNotFoundError(p, "No such workout in demo mode.");
      return this.fit(w);
    }
    if (/^\/v2\/route\/[^/]+\/export$/.test(p)) return this.gpx(this.routeIndex(p));
    throw new SuuntoNotFoundError(p, "Not available in demo mode.");
  }
}
