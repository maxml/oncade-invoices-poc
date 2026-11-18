/** In-memory sliding-window limiter: at most `max` hits per key within `windowMs`. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true if it is within the limit. */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(t);
    return true;
  }

  /** True if the key is already at the limit (does not record a hit). */
  blocked(key: string): boolean {
    const t = this.now();
    return (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs).length >= this.max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) if (!v.some((h) => t - h < this.windowMs)) this.hits.delete(k);
  }
}
