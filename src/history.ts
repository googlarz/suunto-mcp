// get_exercise_history: progression of one exercise (or an index of all of them)
// across guided gym sessions. Each session is reduced once, by the same pure
// functions the single-workout tools use (shapeLaps -> compareWorkout ->
// buildRestProfile), to a small per-exercise record that is cached on disk
// (cache.ts). Weights and reps are NOT measured: the watch only records the
// guide's text, so they are what was planned unless the journal (journal.ts) says otherwise.
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, localDate, workoutDate } from "./api.js";
import { MIN_AGE_MS, cacheDir, cacheEnabled, readCache, writeCache } from "./cache.js";
import { STRENGTH_CUT_MIN, WORKOUT_CAP, compareWorkout, norm } from "./compare.js";
import { parseFit, type ParsedFit } from "./fit.js";
import { loadJournal, validEntries, type JournalEntry } from "./journal.js";
import { LAP_EXTENSIONS, shapeLaps } from "./laps.js";
import { buildRestProfile } from "./rest-profile.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { addDays } from "./training-load.js";

export const DEFAULT_WEEKS = 8;
export const MAX_WEEKS = 26;
// Uncached sessions read per call (two requests each): keeps one call inside Suunto's rate limit.
export const MAX_FETCH = 8;
// A name the guide cut keeps most of its text: shorter than this it is too likely to be a whole name that
// merely starts another ('Squat' / 'Squat Jump'), and is never folded into a longer one.
export const MIN_CUT_NAME = 12;
const WORKOUT_LIMIT = 400;
const ERROR_MAX = 200;

export interface RestAfterSet1 {
  endHr: number;
  dropTotal: number | null;
  t20S: number | null;
  coverage: number;
}

export interface ExerciseRecord {
  name: string;
  detail: string | null;
  cut: boolean; // the name may have been shortened by the guide's 40-character limit
  load: { kg: number } | null; // from the label's text: what was planned
  setsDone: number;
  plannedSets: number | null;
  restS: number | null;
  restAfterSet1: RestAfterSet1 | null;
  deviations: string[];
  reliable: boolean;
}

export interface WorkoutRecord {
  workoutKey: string;
  date: string;
  exercises: ExerciseRecord[];
}

// The first "<number>kg" in a detail text: "100kg 3x5" -> 100, "2x20kg 3x8/leg" -> 20, "62,5kg" -> 62.5.
// null when there is none ("RPE6 8-12", "BW 3x15") or when the weight is added to bodyweight
// ("BW+10kg 3x8"): a weight is never guessed.
export function parseLoadKg(detail: string | null): number | null {
  const m = detail === null ? null : /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*kg/i.exec(detail);
  if (m === null || /\bBW\b|bodyweight/i.test(detail!.slice(0, m.index))) return null;
  return Number(m[1].replace(",", "."));
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Length of a label's text before cleanLabel replaced its line breaks with " | " (as compare.ts does).
const rawLen = (label: string) => label.length - 2 * (label.split(" | ").length - 1);

// One workout's laps (and its FIT, when rests are to be profiled) -> per-exercise records. Pure.
export function deriveRecord(laps: ReturnType<typeof shapeLaps>, parsed: ParsedFit | null, date: string): WorkoutRecord {
  const cmp = compareWorkout(laps);
  const profile = parsed ? buildRestProfile(laps, parsed) : null;
  const exercises = cmp.exercises.map((ex): ExerciseRecord => {
    const rest = profile?.rests.find((r) => r.exerciseN === ex.n && r.set === 1);
    const kg = parseLoadKg(ex.detail);
    return {
      name: ex.name,
      detail: ex.detail,
      cut: cmp.format === "workout" ? ex.name.length >= WORKOUT_CAP : ex.detail !== null && rawLen(`${ex.name} | ${ex.detail}`) >= STRENGTH_CUT_MIN,
      load: kg === null ? null : { kg },
      setsDone: ex.sets.length,
      plannedSets: ex.planned.sets,
      restS: ex.planned.restS,
      restAfterSet1: rest && rest.endHr !== null ? { endHr: rest.endHr, dropTotal: rest.dropTotal, t20S: rest.t20S, coverage: rest.coverage } : null,
      deviations: [...new Set(cmp.deviations.filter((d) => d.ex === ex.n).map((d) => d.code))],
      reliable: profile ? profile.reliable : cmp.reliable,
    };
  });
  return { workoutKey: laps.workoutKey ?? "", date, exercises };
}

// A stored name matches a query when both are the same after normalisation (case, accents and
// punctuation ignored), or when the stored name may have been cut by the guide and the query starts with it.
export function nameMatches(query: string, stored: { name: string; cut: boolean }): boolean {
  const q = norm(query);
  const s = norm(stored.name);
  return q !== "" && (q === s || (stored.cut && s.length >= MIN_CUT_NAME && q.startsWith(s)));
}

export const COLS = [
  "date", "workoutKey", "detail", "kg", "loadSource", "setsDone", "plannedSets", "restS",
  "restEndHr", "restDropTotal", "restT20S", "restCoverage", "deviations", "reliable", "journal",
] as const;

type Client = Pick<SuuntoClient, "listWorkouts" | "getWorkoutWithExtensions" | "getWorkoutFit">;
export interface HistoryDeps {
  now?: number;
  parse?: (bytes: Buffer) => Promise<ParsedFit>;
  loadJournal?: () => Promise<Record<string, JournalEntry>>;
}

const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.payload ?? []);

// The index groups a cut name with the longer name it is a prefix of, but only when that is certain: exactly
// one longer name was seen and the cut name has at least MIN_CUT_NAME characters. Any other cut name that
// is a prefix of something stays on its own and is listed in `unresolved` ("A / B / C": A is a prefix of B and C).
function canonical(distinct: Map<string, { name: string; cut: boolean }>): { resolve: (n: string) => string; unresolved: string[] } {
  const target = new Map<string, string>();
  const unresolved: string[] = [];
  for (const [key, e] of distinct) {
    if (!e.cut) continue;
    const longer = [...distinct.keys()].filter((k) => k.length > key.length && k.startsWith(key));
    if (longer.length === 1 && key.length >= MIN_CUT_NAME) target.set(key, longer[0]);
    else if (longer.length > 0) unresolved.push([e.name, ...longer.map((k) => distinct.get(k)!.name)].join(" / "));
  }
  const resolve = (key: string): string => {
    let k = key;
    while (target.has(k)) k = target.get(k)!;
    return k;
  };
  return { resolve, unresolved };
}

// Sessions that failed to load in this process. They are tried after the ones not tried yet, so a few
// bad sessions cannot use up every call's quota and starve the older ones behind them.
const failedKeys = new Set<string>();
export const clearFailedSessions = (): void => failedKeys.clear();

export async function buildExerciseHistory(client: Client, opts: { name?: string; weeks?: number; date?: string }, deps: HistoryDeps = {}) {
  const weeks = opts.weeks ?? DEFAULT_WEEKS;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_WEEKS) throw new Error(`weeks must be a whole number from 1 to ${MAX_WEEKS}, got ${weeks}.`);
  const to = opts.date ?? localDate();
  if (!isValidCalendarDate(to)) throw new Error(`"${to}" is not a valid calendar date (YYYY-MM-DD).`);
  const from = addDays(to, -(weeks * 7 - 1));
  const now = deps.now ?? Date.now();
  const parse = deps.parse ?? parseFit;

  const bounds = dayFetchBounds(from, to);
  const listed = rowsOf(await client.listWorkouts({ since: bounds.from, until: bounds.to, limit: WORKOUT_LIMIT }));
  const items = listed
    .map((w) => ({ key: String(w?.workoutKey ?? "").toLowerCase(), date: workoutDate(w), startMs: typeof w?.startTime === "number" ? w.startTime : null, hasLaps: Array.isArray(w?.extensionTypes) && w.extensionTypes.includes("MANUALLAP") }))
    .filter((w) => w.hasLaps && /^[0-9a-f]{24}$/.test(w.key) && w.date >= from && w.date <= to)
    .sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0));

  const records = new Map<string, WorkoutRecord>();
  const uncached: typeof items = [];
  for (const w of items) {
    const hit = await readCache<WorkoutRecord>(w.key);
    if (hit) records.set(w.key, { ...hit, date: w.date });
    else uncached.push(w);
  }

  const errors: { workoutKey: string; date: string; error: string }[] = [];
  const tryOrder = [...uncached.filter((w) => !failedKeys.has(w.key)), ...uncached.filter((w) => failedKeys.has(w.key))];
  const batch = tryOrder.slice(0, MAX_FETCH);
  let unwritable = 0; // sessions old enough to cache that could not be stored
  for (const w of batch) {
    try {
      const laps = shapeLaps(await client.getWorkoutWithExtensions(w.key, LAP_EXTENSIONS));
      const cmp = compareWorkout(laps);
      // a per-exercise guide has no between-set rests, and an unreadable one no exercises: the FIT would add nothing
      const parsed = cmp.status === "ok" && cmp.format !== "strength-perExercise" ? await parse(await client.getWorkoutFit(w.key)) : null;
      const record = deriveRecord(laps, parsed, w.date);
      record.workoutKey = w.key;
      records.set(w.key, record);
      failedKeys.delete(w.key);
      const stored = await writeCache(w.key, w.startMs, record, now);
      if (!stored && cacheEnabled() && w.startMs !== null && Number.isFinite(w.startMs) && now - w.startMs >= MIN_AGE_MS) unwritable++;
    } catch (err: any) {
      failedKeys.add(w.key);
      errors.push({ workoutKey: w.key, date: w.date, error: String(err?.message ?? err).slice(0, ERROR_MAX) });
    }
  }
  const pending = uncached.length - batch.length;

  let journal: Record<string, JournalEntry> = {};
  let journalError: string | null = null;
  let journalIgnored = 0;
  // Demo mode has no journal of its own (log_session writes nothing there): the real file must not leak in.
  if (process.env.SUUNTO_DEMO !== "1") {
    try {
      ({ entries: journal, ignored: journalIgnored } = validEntries(await (deps.loadJournal ?? loadJournal)()));
    } catch (err: any) {
      journalError = String(err?.message ?? err).slice(0, ERROR_MAX);
    }
  }

  const ordered = items.map((w) => records.get(w.key)).filter((r): r is WorkoutRecord => r !== undefined).sort((a, b) => a.date.localeCompare(b.date) || a.workoutKey.localeCompare(b.workoutKey));

  const notes = [
    "Weights and reps come from the guide's text, i.e. what was PLANNED, unless a journal entry (log_session) says otherwise (loadSource 'journal'); the watch does not record them. Sessions with reliable false are included but their mapping or rest profile is best effort.",
  ];
  if (pending > 0 && !cacheEnabled() && process.env.SUUNTO_DEMO !== "1") {
    notes.push(`${pending} older session(s) are not read: the cache is off (SUUNTO_CACHE=off), so each call reads only the ${MAX_FETCH} newest sessions and calling again will not reach the older ones.`);
  } else if (pending > 0 && (unwritable > 0 || errors.length > 0)) {
    const why = [
      unwritable > 0 ? `the cache is not writable (${cacheDir()}), so the ${unwritable} session(s) read this call were not saved and every call starts from the newest ${MAX_FETCH} again` : "",
      errors.length > 0 ? `${errors.length} session(s) failed to load (see errors) and stay uncached, so pending may never reach 0` : "",
    ].filter(Boolean);
    notes.push(`${pending} older session(s) are not read yet, and calling again will not help: ${why.join("; ")}.`);
  } else if (pending > 0) {
    notes.push(`${pending} older session(s) are not read yet (at most ${MAX_FETCH} uncached ones are fetched per call): call again until pending is 0.`);
  }
  if (listed.length >= WORKOUT_LIMIT) notes.push(`Reached the ${WORKOUT_LIMIT}-workout limit; older sessions in the range may be missing.`);
  if (journalIgnored > 0) notes.push(`${journalIgnored} journal ${journalIgnored === 1 ? "entry" : "entries"} ignored: not a valid log_session entry (fix or delete ${journalIgnored === 1 ? "it" : "them"} in the journal file).`);
  if (journalError) notes.push(`The journal could not be read (${journalError}); loads are from the labels only.`);

  const head = { from, to };
  const distinct = new Map<string, { name: string; cut: boolean }>();
  for (const r of ordered) {
    for (const e of r.exercises) {
      const k = norm(e.name);
      const prev = distinct.get(k);
      distinct.set(k, { name: e.name, cut: e.cut && (prev?.cut ?? true) });
    }
  }

  if (opts.name === undefined) {
    const { resolve: canon, unresolved } = canonical(distinct);
    if (unresolved.length > 0) notes.push(`These names look alike and could not be told apart, so they are listed separately: ${unresolved.join("; ")}.`);
    const groups = new Map<string, { sessions: Set<string>; lastDate: string; lastDetail: string | null; name: string }>();
    for (const r of ordered) {
      for (const e of r.exercises) {
        const k = canon(norm(e.name));
        const g = groups.get(k) ?? { sessions: new Set<string>(), lastDate: "", lastDetail: null, name: distinct.get(k)!.name };
        g.sessions.add(r.workoutKey);
        g.lastDate = r.date; // records are oldest first
        g.lastDetail = e.detail;
        groups.set(k, g);
      }
    }
    const exercises = [...groups.values()]
      .map((g) => ({ name: g.name, sessions: g.sessions.size, lastDate: g.lastDate, lastDetail: g.lastDetail }))
      .sort((a, b) => b.sessions - a.sessions || b.lastDate.localeCompare(a.lastDate) || a.name.localeCompare(b.name));
    return { ...head, sessions: ordered.length, exercises, pending, errors, notes };
  }

  notes.push("name matches a stored exercise name when both are equal after normalisation (case, accents and punctuation ignored), or when the stored name may have been cut by the guide's 40-character limit and the name starts with it.");
  notes.push(`sessions.cols = [${COLS.join(", ")}]; each row is an array in that order. kg is the top set's weight; restEndHr, restDropTotal, restT20S and restCoverage describe the rest after set 1 (null when missing).`);
  const rows: unknown[][] = [];
  let firstLoadKg: number | null = null;
  let lastLoadKg: number | null = null;
  const endHrs: number[] = [];
  for (const r of ordered) {
    const entry = journal[r.workoutKey];
    for (const e of r.exercises) {
      if (!nameMatches(opts.name, e)) continue;
      const jEx = entry?.exercises?.find((x) => nameMatches(x.name, e));
      const jKgs = (jEx?.sets ?? []).map((s) => s.kg).filter((k): k is number => typeof k === "number");
      const kg = jKgs.length ? Math.max(...jKgs) : e.load?.kg ?? null;
      const jr = entry ? Object.fromEntries(Object.entries({ note: entry.note, feeling: entry.feeling, sets: jEx?.sets, exerciseNote: jEx?.note }).filter(([, v]) => v !== undefined)) : null;
      const rest = e.restAfterSet1;
      if (kg !== null) {
        firstLoadKg ??= kg;
        lastLoadKg = kg;
      }
      if (e.reliable && rest) endHrs.push(rest.endHr);
      rows.push([
        r.date, r.workoutKey, e.detail, kg, jKgs.length ? "journal" : "label", e.setsDone, e.plannedSets, e.restS,
        rest?.endHr ?? null, rest?.dropTotal ?? null, rest?.t20S ?? null, rest?.coverage ?? null, e.deviations, e.reliable,
        jr && Object.keys(jr).length ? jr : null,
      ]);
    }
  }
  if (rows.length === 0) {
    const names = [...distinct.values()].slice(0, 15).map((d) => d.name);
    notes.push(`No exercise matches "${opts.name}" in ${from}..${to}.${names.length ? ` Names seen: ${names.join("; ")}.` : ""}`);
  }
  const endHrMedian = median(endHrs);
  return {
    name: opts.name,
    ...head,
    sessions: { cols: COLS, rows },
    summary: { sessions: rows.length, firstLoadKg, lastLoadKg, restEndHrMedian: endHrMedian === null ? null : Math.round(endHrMedian) },
    pending,
    errors,
    notes,
  };
}
