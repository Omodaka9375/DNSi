/**
 * Aggregate, anonymous counters. One in-memory map keyed by metric name;
 * no addresses, no questions, nothing per-user. These exist so an operator
 * can answer "is this thing used and is the cache earning its keep"
 * without running a log pipeline.
 */
export class Counters {
  private readonly values = new Map<string, number>();
  /** Process-start timestamp; uptime is reported from this, not persisted. */
  readonly startedAt = Date.now();

  inc(name: string, by = 1): void {
    if (by <= 0) return;
    this.values.set(name, (this.values.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  /** Stable-ordered copy for dumps and persistence. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of [...this.values.keys()].sort()) out[k] = this.values.get(k) ?? 0;
    return out;
  }

  /** Restore counters from a previous snapshot (crossing restarts). */
  load(saved: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(saved)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        this.values.set(k, (this.values.get(k) ?? 0) + Math.floor(v));
      }
    }
  }

  static humanUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${sec}s` : `${sec}s`;
  }
}
