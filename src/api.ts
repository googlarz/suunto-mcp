import type { Config } from "./config.js";
import { getValidAccessToken } from "./auth.js";

const API_BASE = "https://cloudapi.suunto.com";

export class SuuntoClient {
  constructor(private readonly cfg: Config) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await getValidAccessToken(this.cfg);
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Ocp-Apim-Subscription-Key": this.cfg.subscriptionKey,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Suunto API ${res.status} ${path}: ${body}`);
    }
    return res;
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

  listWorkouts(opts: { since?: number; until?: number; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.since) q.set("since", String(opts.since));
    if (opts.until) q.set("until", String(opts.until));
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.json<{ payload: any[]; metadata: any }>(
      `/v2/workouts${qs ? `?${qs}` : ""}`,
    );
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

  // ---------- Subscriptions / Webhooks ----------

  subscriptions() {
    return this.json<any>(`/v2/subscriptions`);
  }
}
