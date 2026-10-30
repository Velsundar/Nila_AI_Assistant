/**
 * Tiny LRU index (pure, no I/O) for the natural-voice audio cache. Values carry a byte size;
 * `set` returns the entries it evicted so the caller can delete their files. Pinned entries
 * (the interrupt acknowledgements) are never evicted.
 */
export type LruEntry<V> = { key: string; value: V; bytes: number; pinned: boolean };

export class LruIndex<V> {
  private map = new Map<string, LruEntry<V>>();
  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number,
  ) {}

  get size() {
    return this.map.size;
  }
  get bytes() {
    let n = 0;
    for (const e of this.map.values()) n += e.bytes;
    return n;
  }

  has(key: string) {
    return this.map.has(key);
  }

  /** Returns the value and marks it most recently used. */
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** Inserts/replaces and returns evicted entries (oldest unpinned first). Replaced values are returned too. */
  set(key: string, value: V, bytes: number, pinned = false): LruEntry<V>[] {
    const evicted: LruEntry<V>[] = [];
    const old = this.map.get(key);
    if (old) {
      this.map.delete(key);
      if (old.value !== value) evicted.push(old);
    }
    this.map.set(key, { key, value, bytes, pinned: pinned || !!old?.pinned });
    let total = this.bytes;
    for (const e of [...this.map.values()]) {
      if (this.map.size <= this.maxEntries && total <= this.maxBytes) break;
      if (e.pinned || e.key === key) continue;
      this.map.delete(e.key);
      total -= e.bytes;
      evicted.push(e);
    }
    return evicted;
  }

  delete(key: string): LruEntry<V> | undefined {
    const e = this.map.get(key);
    this.map.delete(key);
    return e;
  }

  /** Oldest first, for persisting. */
  entries(): LruEntry<V>[] {
    return [...this.map.values()];
  }

  /** Restores from `entries()` output; returns anything over the limits. */
  load(entries: LruEntry<V>[]): LruEntry<V>[] {
    this.map.clear();
    const evicted: LruEntry<V>[] = [];
    for (const e of entries) evicted.push(...this.set(e.key, e.value, e.bytes, e.pinned));
    return evicted;
  }
}
