interface WindowEntry {
  timestamps: number[];
}

export class RateLimiter {
  private store = new Map<string, WindowEntry>();

  constructor(
    private windowMs: number,
    private maxRequests: number
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry) {
      this.store.set(key, { timestamps: [now] });
      return true;
    }

    const windowStart = now - this.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    if (entry.timestamps.length >= this.maxRequests) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  reset(key: string): void {
    this.store.delete(key);
  }
}
