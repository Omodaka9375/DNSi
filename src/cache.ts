import type { AnswerRecord } from "./wire.js";

/** Tiny LRU cache keyed by normalized QNAME ("answers get served free"). */
export class AnswerCache {
  private map = new Map<string, { records: AnswerRecord[]; expiresAt: number }>();

  constructor(private readonly maxEntries = 10_000) {}

  get(key: string): AnswerRecord[] | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, hit); // refresh recency
    return hit.records;
  }

  set(key: string, records: AnswerRecord[], ttlSec: number): void {
    if (this.maxEntries <= 0) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { records, expiresAt: Date.now() + ttlSec * 1000 });
  }
}
