import type { Config } from "./config.js";
import { getValidAccessToken } from "./auth.js";
import { isValidCalendarDate } from "./schema-validate.js";
import {
  SuuntoApiError,
  SuuntoAuthError,
  SuuntoEmptyResponseError,
  SuuntoEndpointUnavailableError,
  SuuntoForbiddenError,
  SuuntoNotFoundError,
  SuuntoRateLimitError,
} from "./errors.js";

const API_BASE = "https://cloudapi.suunto.com";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;
// A server-supplied Retry-After must not park an MCP tool call past the
// client's own timeout: each wait is capped, and so is the total across retries.
export const MAX_RETRY_AFTER_S = 30;
export const RETRY_BUDGET_MS = 45_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function retryDelayMs(retryAfterSeconds: number, attempt: number) {
  return retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds, MAX_RETRY_AFTER_S) * 1000
    : backoffMs(attempt);
}

// The wait before the next retry, or null when it would push the total past
// the budget — the error is then thrown instead of hanging the call.
export function nextRetryDelayMs(retryAfterSeconds: number, attempt: number, waitedMs: number): number | null {
  // Asked to wait longer than we may: a capped retry would fire early and fail again.
  if (retryAfterSeconds > MAX_RETRY_AFTER_S) return null;
  const delay = retryDelayMs(retryAfterSeconds, attempt);
  return waitedMs + delay <= RETRY_BUDGET_MS ? delay : null;
}

// Suunto's Azure API-management gateway answers HTTP 401 for three different
// conditions; only the body tells them apart. A rate limit clears in about
// 90 s, so it is not retried in-process — the caller is told to wait instead.
function errorFor(status: number, path: string, body: string, retryAfter?: number) {
  if (status === 401) {
    if (/RateLimitExceeded/.test(body)) {
      return new SuuntoRateLimitError(
        path,
        `${body}\n\nSuunto's rate limit was hit (its gateway reports this as HTTP 401, not an auth failure). Wait about 2 minutes and retry.`,
        retryAfter,
      );
    }
    if (/OperationNotFound/.test(body)) return new SuuntoEndpointUnavailableError(path, body);
    return new SuuntoAuthError(path, body);
  }
  if (status === 403) return new SuuntoForbiddenError(path, body);
  if (status === 404) return new SuuntoNotFoundError(path, body);
  if (status === 429) return new SuuntoRateLimitError(path, body, retryAfter);
  return new SuuntoApiError(status, path, body);
}

// The Guide API's 400 for an owner mismatch is a bare {"error":{"description":
// "..."}} with no error code — the only way to recognize it is the wording.
// Surface the actual fix (SUUNTO_APP_NAME) instead of a raw API error.
function guideErrorFor(status: number, path: string, body: string): Error {
  if (status === 400 && /owner/i.test(body)) {
    return new SuuntoApiError(
      status,
      path,
      `${body}\n\nThis usually means SUUNTO_APP_NAME doesn't exactly match the app name registered on apizone.suunto.com. Check apizone → your app → confirm the exact name, fix the env var, and restart Claude.`,
    );
  }
  return errorFor(status, path, body);
}

// Every workoutKey seen live is 24 hex characters. Anything else makes the
// server answer 500, which request() would retry for ~8 s before failing with
// an error that says nothing about the key.
const WORKOUT_KEY = /^[0-9a-f]{24}$/i;

function assertWorkoutKey(workoutKey: string): void {
  if (!WORKOUT_KEY.test(workoutKey)) {
    throw new SuuntoNotFoundError(
      "/v3/workouts",
      `${JSON.stringify(workoutKey)} is not a workout key — expected the 24-character workoutKey returned by list_workouts.`,
    );
  }
}

function workoutPath(workoutKey: string): string {
  assertWorkoutKey(workoutKey);
  return `/v3/workouts/${workoutKey}`;
}

export class SuuntoClient {
  constructor(private readonly cfg: Config) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let attempt = 0;
    let waitedMs = 0;
    let lastErr: unknown;
    while (attempt <= MAX_RETRIES) {
      const token = await getValidAccessToken(this.cfg);
      let res: Response;
      try {
        res = await fetch(`${API_BASE}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            "Ocp-Apim-Subscription-Key": this.cfg.subscriptionKey,
            Accept: "application/json",
            ...(init.headers ?? {}),
          },
        });
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_RETRIES) throw err;
        const delay = backoffMs(attempt);
        await sleep(delay);
        waitedMs += delay;
        attempt++;
        continue;
      }

      if (res.ok) return res;

      const retryAfter = Number(res.headers.get("retry-after")) || 0;

      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        const delay = nextRetryDelayMs(retryAfter, attempt, waitedMs);
        if (delay !== null) {
          await sleep(delay);
          waitedMs += delay;
          attempt++;
          continue;
        }
      }

      const body = await res.text().catch(() => "");
      throw errorFor(res.status, path, body, retryAfter > 0 ? retryAfter : undefined);
    }
    throw lastErr ?? new Error("Suunto API: exhausted retries");
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.request(path);
    const text = await res.text();
    // A well-formed but unknown workout key gets HTTP 200 with no body at all.
    if (text.trim() === "") throw new SuuntoEmptyResponseError(path);
    return JSON.parse(text) as T;
  }

  async bytes(path: string): Promise<Buffer> {
    const res = await this.request(path);
    return Buffer.from(await res.arrayBuffer());
  }

  // ---------- Workouts (v3) ----------

  async listWorkouts(opts: { since?: number; until?: number; limit?: number } = {}) {
    const limit = opts.limit ?? 25;
    const PAGE = 50;
    const collected: any[] = [];
    let offset = 0;

    while (collected.length < limit) {
      const remaining = limit - collected.length;
      const pageSize = Math.min(PAGE, remaining);
      const q = new URLSearchParams({ "filter-by-modification-time": "false" });
      if (opts.since !== undefined) q.set("since", String(opts.since));
      if (opts.until !== undefined) q.set("until", String(opts.until));
      q.set("limit", String(pageSize));
      q.set("offset", String(offset));
      const page = await this.json<{ payload: any[]; metadata?: any }>(
        `/v3/workouts/?${q.toString()}`,
      );
      const items = page.payload ?? [];
      if (items.length === 0) break;

      for (const w of items) {
        if (collected.length >= limit) break;
        collected.push(w);
      }

      if (items.length < pageSize) break;
      offset += items.length;
    }

    return { payload: collected, metadata: { count: collected.length } };
  }

  async getWorkout(workoutKey: string) {
    return this.json<any>(workoutPath(workoutKey));
  }

  // Undocumented but live: v3 accepts ?extensions=<names> and embeds those
  // blocks in the payload. Names are case-sensitive and need the "Extension"
  // suffix; an unknown name fails the whole call with HTTP 400, and a
  // workout that lacks a requested extension simply omits it.
  async getWorkoutWithExtensions(workoutKey: string, extensions: string[]) {
    return this.json<any>(`${workoutPath(workoutKey)}?extensions=${extensions.join(",")}`);
  }

  // NOTE: not in v3 spec — kept at v2 (unverified, may break after Suunto deprecates v2)
  async getWorkoutSamples(workoutKey: string) {
    assertWorkoutKey(workoutKey);
    return this.json<any>(`/v2/workout/samples/${workoutKey}`);
  }

  async getWorkoutFit(workoutKey: string) {
    const path = `${workoutPath(workoutKey)}/fit`;
    try {
      return await this.bytes(path);
    } catch (err) {
      // Unlike the JSON endpoints, /fit answers 403 (not 404) for a well-formed
      // key that doesn't exist. Stays a Forbidden error — a real permission
      // problem is possible too — but says what to check first.
      if (err instanceof SuuntoForbiddenError) {
        throw new SuuntoForbiddenError(
          path,
          `${err.body}\n\nFor a workoutKey that doesn't exist Suunto answers 403 instead of 404 on the FIT download — check the key against list_workouts before suspecting permissions.`,
        );
      }
      throw err;
    }
  }

  // NOTE: not in v3 spec — kept at v2 (unverified, may break after Suunto deprecates v2)
  async getWorkoutGpx(workoutKey: string) {
    assertWorkoutKey(workoutKey);
    return this.bytes(`/v2/workout/exportGpx/${workoutKey}`);
  }

  // ---------- 24/7 Activity (/247samples) ----------

  private dailyPrefix() {
    return process.env.SUUNTO_DAILY_PREFIX ?? "/247samples";
  }

  private query(bounds: { from: number; to: number }) {
    return new URLSearchParams({ from: String(bounds.from), to: String(bounds.to) }).toString();
  }

  getDailyActivity(date: string) {
    return this.listDailyActivity(date, date);
  }

  async listDailyActivity(from: string, to: string) {
    assertRange(from, to);
    const res = await this.json<any>(`${this.dailyPrefix()}/activity?${this.query(dayFetchBounds(from, to))}`);
    return selectDays(res, from, to);
  }

  // ---------- Sleep (/247samples) ----------
  // A date means "the night of that date" (see nightOf), one row per SleepId.

  getSleep(date: string) {
    return this.listSleep(date, date);
  }

  async listSleep(from: string, to: string) {
    assertRange(from, to);
    const res = await this.json<any>(`${this.dailyPrefix()}/sleep?${this.query(nightFetchBounds(from, to))}`);
    return selectNights(res, from, to);
  }

  // ---------- Recovery / HRV (/247samples) ----------

  getRecovery(date: string) {
    return this.listRecovery(date, date);
  }

  async listRecovery(from: string, to: string) {
    assertRange(from, to);
    const res = await this.json<any>(`${this.dailyPrefix()}/recovery?${this.query(dayFetchBounds(from, to))}`);
    return selectDays(res, from, to);
  }

  // ---------- Daily Activity Statistics (/247) ----------

  getDailyStats(startdate: string, enddate: string) {
    const q = new URLSearchParams({ startdate: normalizeOffset(startdate), enddate: normalizeOffset(enddate) });
    return this.json<any>(`/247/daily-activity-statistics?${q.toString()}`);
  }

  // ---------- Routes ----------

  listRoutes() {
    return this.json<any>(`/v2/route`);
  }

  async exportRoute(routeId: string): Promise<Buffer> {
    return this.bytes(`/v2/route/${encodeURIComponent(routeId)}/export`);
  }

  // ---------- Workout Upload ----------

  async initiateUpload(opts: {
    description?: string;
    comment?: string;
    notifyUser?: boolean;
    privacy?: "DEFAULT" | "PRIVATE" | "FOLLOWERS" | "PUBLIC";
  }): Promise<{ uploadId: string; uploadUrl: string }> {
    const token = await getValidAccessToken(this.cfg);
    const res = await fetch(`${API_BASE}/v2/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Ocp-Apim-Subscription-Key": this.cfg.subscriptionKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        description: opts.description ?? "",
        comment: opts.comment ?? "",
        notifyUser: opts.notifyUser ?? false,
        privacy: opts.privacy ?? "DEFAULT",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw errorFor(res.status, "/v2/upload", body);
    }
    return (await res.json()) as { uploadId: string; uploadUrl: string };
  }

  async uploadFile(uploadUrl: string, fileBytes: Buffer, contentType: string): Promise<void> {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: fileBytes.buffer as ArrayBuffer,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new SuuntoApiError(res.status, uploadUrl, body);
    }
  }

  getUploadStatus(uploadId: string) {
    return this.json<any>(`/v2/upload/${encodeURIComponent(uploadId)}`);
  }

  // ---------- SuuntoPlus Guides ----------

  async createGuide(zip: Buffer): Promise<any> {
    this.assertAppName();
    const token = await getValidAccessToken(this.cfg);
    const res = await fetch(`${API_BASE}/v2/guides/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Ocp-Apim-Subscription-Key": this.cfg.subscriptionKey,
        "Content-Type": "application/zip",
        Accept: "application/json",
      },
      body: new Uint8Array(zip),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw guideErrorFor(res.status, "/v2/guides/files", body);
    }
    return res.json();
  }

  async updateGuide(guideId: string, zip: Buffer): Promise<any> {
    this.assertAppName();
    const token = await getValidAccessToken(this.cfg);
    const res = await fetch(`${API_BASE}/v2/guides/files/${encodeURIComponent(guideId)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Ocp-Apim-Subscription-Key": this.cfg.subscriptionKey,
        "Content-Type": "application/zip",
        Accept: "application/json",
      },
      body: new Uint8Array(zip),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw guideErrorFor(res.status, `/v2/guides/files/${guideId}`, body);
    }
    return res.json();
  }

  private assertAppName(): void {
    if (!this.cfg.appName) {
      throw new Error(
        "SUUNTO_APP_NAME is not set. Guide push needs it to exactly match the app name " +
          "registered on apizone.suunto.com — add SUUNTO_APP_NAME=your-app-name to your .env " +
          "(or the MCP config's env block) and restart Claude.",
      );
    }
  }

  listGuides() {
    return this.json<any>(`/v2/guides/items`);
  }

  async deleteGuide(guideId: string): Promise<void> {
    await this.request(`/v2/guides/files/${encodeURIComponent(guideId)}`, {
      method: "DELETE",
    });
  }

  // ---------- Subscriptions / Webhooks ----------

  subscriptions() {
    return this.json<any>(`/v2/subscriptions`);
  }
}

// This endpoint answers HTTP 400 to a UTC offset written +0200 (what `date +%z`
// prints) and accepts +02:00 or none, so rewrite the former to the latter.
export function normalizeOffset(datetime: string): string {
  return datetime.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)([+-]\d{2})(\d{2})$/, "$1$2:$3");
}

// A reversed range would come back as an empty list — indistinguishable from
// "no data" — so refuse it instead.
// Both ends must be real calendar dates too: the CLI passes raw arguments, and
// a date like 2026-02-30 would fetch one window but be labelled by another.
function assertRange(from: string, to: string): void {
  for (const date of [from, to]) {
    if (!isValidCalendarDate(date)) throw new Error(`"${date}" is not a valid calendar date (YYYY-MM-DD).`);
  }
  if (from > to) throw new Error(`from (${from}) must be on or before to (${to}).`);
}

// ---------- Day and night bucketing (24/7 endpoints) ----------
// Suunto filters 24/7 rows by epoch-ms bounds on each row's timestamp, but
// stamps every row in the wearer's local time (ISO 8601 with an offset), so a
// UTC-midnight window cuts each local day at 02:00 (01:00 in winter) — measured
// live: get_recovery("D") returned local D 02:00 through D+1 01:30, and a
// 03:00 bedtime was filed a night too late. Fixing the bounds with this
// machine's time zone would only be right while it matches the watch's, so
// nothing here reads the host zone: each query fetches a window wider than any
// real UTC offset (-12:00 … +14:00) allows, then every row is placed by its OWN
// local date, read from its timestamp string.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OFFSET_MARGIN = 14 * HOUR;

function utcMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

// Superset of every instant that can carry a local date in [from, to]
// (recovery, activity, workouts).
export function dayFetchBounds(from: string, to: string) {
  return { from: utcMidnight(from) - OFFSET_MARGIN, to: utcMidnight(to) + DAY + OFFSET_MARGIN - 1 };
}

// Same for nights, which run to noon of the next local day.
export function nightFetchBounds(from: string, to: string) {
  return { from: utcMidnight(from) - OFFSET_MARGIN, to: utcMidnight(to) + 2 * DAY - 1 };
}

// A sleep row without a readable timestamp still has its BedtimeStart.
const instant = (row: any): number => {
  const t = Date.parse(row?.timestamp);
  return Number.isNaN(t) ? Date.parse(row?.entryData?.BedtimeStart) : t;
};
const byInstant = (a: any, b: any) => instant(a) - instant(b);

// Suunto's list endpoints answer either { payload: [...] } or a bare array.
function mapRows(response: any, fn: (rows: any[]) => any[]): any {
  if (Array.isArray(response?.payload)) return { ...response, payload: fn(response.payload) };
  if (Array.isArray(response)) return fn(response);
  return response;
}

// The wearer's local calendar date of a row: the date part of its own timestamp.
export function rowDate(row: any): string {
  const date = String(row?.timestamp ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

// Recovery and activity: the rows of local days from..to inclusive, in true
// time order. Sorting compares instants, not strings — on a fall-back day the
// local 02:xx hour occurs twice and the strings order it wrongly. Suunto
// sometimes repeats a row (identical payload, same instant); one is kept.
export function selectDays(response: any, from: string, to: string): any {
  return mapRows(response, (rows) => {
    const seen = new Set<number>();
    return rows
      .filter((row) => {
        const date = rowDate(row);
        if (date === "" || date < from || date > to) return false;
        const t = instant(row);
        if (Number.isNaN(t)) return false; // an unreadable instant can't be ordered or deduped
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      })
      .sort(byInstant);
  });
}

// Sleep rows are stamped with their BedtimeStart. "The night of D" is every
// sleep that begins between noon on D and noon on D+1, local: it keeps a 23:00,
// a 00:30 and a 03:00 bedtime together as one night, and files an afternoon nap
// with the night after it. Every instant belongs to exactly one date, so a
// range of dates never drops or repeats a sleep. The rule uses BedtimeStart
// alone (which never changes between revisions) — never IsNap, which flips
// while a sleep is still in progress.
export function nightOf(row: any): string | null {
  const local = String(row?.entryData?.BedtimeStart ?? row?.timestamp ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  // The local clock reading is treated as UTC only to do date arithmetic on it.
  const shifted = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 12 * HOUR;
  return new Date(shifted).toISOString().slice(0, 10);
}

// Suunto re-emits a sleep every time it revises it (2–66 rows per SleepId
// measured, all with the same timestamp). The longest Duration is the most
// refined revision — keep that one; on a tie the later row.
function longestPerSleepId(rows: any[]): any[] {
  const kept = new Map<number, number>(); // SleepId -> index of the row to keep
  rows.forEach((row, i) => {
    const id = row?.entryData?.SleepId;
    if (typeof id !== "number") return;
    const cur = kept.get(id);
    if (cur === undefined || (row.entryData.Duration ?? 0) >= (rows[cur].entryData.Duration ?? 0)) kept.set(id, i);
  });
  return rows.filter((row, i) => {
    const id = row?.entryData?.SleepId;
    return typeof id !== "number" || kept.get(id) === i;
  });
}

// Sleep: one row per sleep, for the nights from..to inclusive, oldest first.
export function selectNights(response: any, from: string, to: string): any {
  return mapRows(response, (rows) =>
    longestPerSleepId(rows)
      .filter((row) => {
        const night = nightOf(row);
        return night !== null && night >= from && night <= to && !Number.isNaN(instant(row));
      })
      .sort(byInstant),
  );
}

// The local calendar date of a workout, from its own UTC offset.
// "" when it can't be told (no usable startTime) — never a made-up date.
export function workoutDate(workout: any): string {
  const raw = workout?.startTime;
  const start = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  const offset = Number(workout?.timeOffsetInMinutes);
  const t = start + (Number.isFinite(offset) ? offset : 0) * 60_000;
  const d = new Date(t);
  return Number.isFinite(t) && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "";
}

// YYYY-MM-DD of this machine's local calendar day, `daysAgo` days before `now`
// — only for "today"/"yesterday" defaults, never for bucketing data.
export function localDate(daysAgo = 0, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function backoffMs(attempt: number) {
  const base = 500 * Math.pow(2, attempt);
  return base + Math.random() * 250;
}
