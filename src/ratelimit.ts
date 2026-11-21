/**
 * Per-client token bucket. DNS queries over UDP carry spoofable source
 * addresses, so rate limiting is best-effort defense, not auth.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly burst: number,
    private readonly refillPerSec: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const existing = this.buckets.get(key);
    const bucket = existing ?? { tokens: this.burst, updated: now };
    const elapsedSec = Math.max(0, (now - bucket.updated) / 1000);
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.updated = now;
    if (this.buckets.size > 10_000) this.prune(now);
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  private prune(now: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens >= this.burst) this.buckets.delete(key);
      if (this.buckets.size <= 5_000) break;
      void now;
    }
  }
}
