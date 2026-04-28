import type { Config } from "./config.js";
import { getValidAccessToken } from "./auth.js";

const API_BASE = "https://cloudapi.suunto.com";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        await sleep(retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
        attempt++;
        continue;
      }

      const body = await res.text().catch(() => "");
      throw new Error(`Suunto API ${res.status} ${path}: ${body}`);
    }
    throw lastErr ?? new Error("Suunto API: exhausted retries");
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.request(path);
    return (await res.json()) as T;
  }

  async bytes(path: string): Promise<Uint8Array> {
    const res = await this.request(path);
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---------- Workouts ----------

  async listWorkouts(opts: { since?: number; until?: number; limit?: number } = {}) {
    const limit = opts.limit ?? 25;
    const collected: any[] = [];
    let until = opts.until;

    while (collected.length < limit) {
      const q = new URLSearchParams();
      if (opts.since) q.set("since", String(opts.since));
      if (until) q.set("until", String(until));
      const qs = q.toString();
      const page = await this.json<{ payload: any[]; metadata?: any }>(
        `/v2/workouts${qs ? `?${qs}` : ""}`,
      );
      const items = page.payload ?? [];
      if (items.length === 0) break;

      for (const w of items) {
        if (collected.length >= limit) break;
        collected.push(w);
      }

      if (items.length < 25) break;
      const oldest = items[items.length - 1];
      const t = Number(oldest?.startTime);
      if (!Number.isFinite(t)) break;
      until = t - 1;
    }

    return { payload: collected, metadata: { count: collected.length } };
  }

  getWorkout(workoutKey: string) {
    return this.json<any>(`/v2/workout/${encodeURIComponent(workoutKey)}`);
  }

  getWorkoutSamples(workoutKey: string) {
    return this.json<any>(`/v2/workout/samples/${encodeURIComponent(workoutKey)}`);
  }

  getWorkoutFit(workoutKey: string) {
    return this.bytes(`/v2/workout/exportFit/${encodeURIComponent(workoutKey)}`);
  }

  getWorkoutGpx(workoutKey: string) {
    return this.bytes(`/v2/workout/exportGpx/${encodeURIComponent(workoutKey)}`);
  }

  // ---------- 24/7 Activity ----------
  // Endpoint paths reflect the documented Suunto 24/7 product. If your
  // entitlement uses a different path prefix, override via SUUNTO_DAILY_PREFIX.

  private dailyPrefix() {
    return process.env.SUUNTO_DAILY_PREFIX ?? "/v2";
  }

  /** Daily activity summary for one date (YYYY-MM-DD): steps, calories, HR. */
  getDailyActivity(date: string) {
    return this.json<any>(`${this.dailyPrefix()}/activity/${date}`);
  }

  /** Daily activity range. */
  listDailyActivity(from: string, to: string) {
    const q = new URLSearchParams({ from, to });
    return this.json<any>(`${this.dailyPrefix()}/activity?${q.toString()}`);
  }

  // ---------- Sleep ----------

  /** Sleep summary for one date (YYYY-MM-DD): stages, duration, score. */
  getSleep(date: string) {
    return this.json<any>(`${this.dailyPrefix()}/sleep/${date}`);
  }

  listSleep(from: string, to: string) {
    const q = new URLSearchParams({ from, to });
    return this.json<any>(`${this.dailyPrefix()}/sleep?${q.toString()}`);
  }

  // ---------- Recovery / HRV ----------

  getRecovery(date: string) {
    return this.json<any>(`${this.dailyPrefix()}/recovery/${date}`);
  }

  listRecovery(from: string, to: string) {
    const q = new URLSearchParams({ from, to });
    return this.json<any>(`${this.dailyPrefix()}/recovery?${q.toString()}`);
  }

  // ---------- Subscriptions / Webhooks ----------

  subscriptions() {
    return this.json<any>(`/v2/subscriptions`);
  }
}

function backoffMs(attempt: number) {
  const base = 500 * Math.pow(2, attempt);
  return base + Math.random() * 250;
}
