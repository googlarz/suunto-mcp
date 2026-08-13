import type { Config } from "./config.js";
import { getValidAccessToken } from "./auth.js";
import {
  SuuntoApiError,
  SuuntoAuthError,
  SuuntoForbiddenError,
  SuuntoNotFoundError,
  SuuntoRateLimitError,
} from "./errors.js";

const API_BASE = "https://cloudapi.suunto.com";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function errorFor(status: number, path: string, body: string, retryAfter?: number) {
  if (status === 401) return new SuuntoAuthError(path, body);
  if (status === 403) return new SuuntoForbiddenError(path, body);
  if (status === 404) return new SuuntoNotFoundError(path, body);
  if (status === 429) return new SuuntoRateLimitError(path, body, retryAfter);
  return new SuuntoApiError(status, path, body);
}

export class SuuntoClient {
  constructor(private readonly cfg: Config) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let attempt = 0;
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
        await sleep(backoffMs(attempt));
        attempt++;
        continue;
      }

      if (res.ok) return res;

      const retryAfter = Number(res.headers.get("retry-after")) || 0;

      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        await sleep(retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
        attempt++;
        continue;
      }

      const body = await res.text().catch(() => "");
      throw errorFor(res.status, path, body, retryAfter > 0 ? retryAfter : undefined);
    }
    throw lastErr ?? new Error("Suunto API: exhausted retries");
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.request(path);
    return (await res.json()) as T;
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

  getWorkout(workoutKey: string) {
    return this.json<any>(`/v3/workouts/${encodeURIComponent(workoutKey)}`);
  }

  // NOTE: not in v3 spec — kept at v2 (unverified, may break after Suunto deprecates v2)
  getWorkoutSamples(workoutKey: string) {
    return this.json<any>(`/v2/workout/samples/${encodeURIComponent(workoutKey)}`);
  }

  getWorkoutFit(workoutKey: string) {
    return this.bytes(`/v3/workouts/${encodeURIComponent(workoutKey)}/fit`);
  }

  // NOTE: not in v3 spec — kept at v2 (unverified, may break after Suunto deprecates v2)
  getWorkoutGpx(workoutKey: string) {
    return this.bytes(`/v2/workout/exportGpx/${encodeURIComponent(workoutKey)}`);
  }

  // ---------- 24/7 Activity (/247samples) ----------

  private dailyPrefix() {
    return process.env.SUUNTO_DAILY_PREFIX ?? "/247samples";
  }

  getDailyActivity(date: string) {
    const q = new URLSearchParams({
      from: String(startOfDayMs(date)),
      to: String(endOfDayMs(date)),
    });
    return this.json<any>(`${this.dailyPrefix()}/activity?${q.toString()}`);
  }

  async listDailyActivity(from: string, to: string) {
    const q = new URLSearchParams({
      from: String(startOfDayMs(from)),
      to: String(endOfDayMs(to)),
    });
    const res = await this.json<any>(`${this.dailyPrefix()}/activity?${q.toString()}`);
    return sortByTimestamp(res);
  }

  // ---------- Sleep (/247samples) ----------

  getSleep(date: string) {
    const q = new URLSearchParams({
      from: String(startOfDayMs(date)),
      to: String(endOfDayMs(date)),
    });
    return this.json<any>(`${this.dailyPrefix()}/sleep?${q.toString()}`);
  }

  async listSleep(from: string, to: string) {
    const q = new URLSearchParams({
      from: String(startOfDayMs(from)),
      to: String(endOfDayMs(to)),
    });
    const res = await this.json<any>(`${this.dailyPrefix()}/sleep?${q.toString()}`);
    return sortByTimestamp(res);
  }

  // ---------- Recovery / HRV (/247samples) ----------

  getRecovery(date: string) {
    const q = new URLSearchParams({
      from: String(startOfDayMs(date)),
      to: String(endOfDayMs(date)),
    });
    return this.json<any>(`${this.dailyPrefix()}/recovery?${q.toString()}`);
  }

  async listRecovery(from: string, to: string) {
    const q = new URLSearchParams({
      from: String(startOfDayMs(from)),
      to: String(endOfDayMs(to)),
    });
    const res = await this.json<any>(`${this.dailyPrefix()}/recovery?${q.toString()}`);
    return sortByTimestamp(res);
  }

  // ---------- Daily Activity Statistics (/247) ----------

  getDailyStats(startdate: string, enddate: string) {
    const q = new URLSearchParams({ startdate, enddate });
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
      throw errorFor(res.status, "/v2/guides/files", body);
    }
    return res.json();
  }

  async updateGuide(guideId: string, zip: Buffer): Promise<any> {
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
      throw errorFor(res.status, `/v2/guides/files/${guideId}`, body);
    }
    return res.json();
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

// Sort a list API response chronologically by the `timestamp` ISO8601 field.
// Handles both { payload: [...] } (Suunto's standard envelope) and plain arrays.
// Items without a `timestamp` field sort stably to the front.
function sortByTimestamp(response: any): any {
  const cmp = (a: any, b: any) =>
    String(a?.timestamp ?? "").localeCompare(String(b?.timestamp ?? ""));
  if (Array.isArray(response?.payload)) {
    return { ...response, payload: [...response.payload].sort(cmp) };
  }
  if (Array.isArray(response)) {
    return [...response].sort(cmp);
  }
  return response;
}

function startOfDayMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function endOfDayMs(date: string): number {
  return Date.parse(`${date}T23:59:59.999Z`);
}

function backoffMs(attempt: number) {
  const base = 500 * Math.pow(2, attempt);
  return base + Math.random() * 250;
}
