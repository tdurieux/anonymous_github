/** Bounded TTL cache with one calculation per key and retry after failure. */
export class AsyncCache<T> {
  private entries = new Map<string, { expires: number; value: Promise<T> }>();
  constructor(private ttl: number, private capacity: number, private now = () => Date.now()) {}
  get size() { this.prune(); return this.entries.size; }
  clear() { this.entries.clear(); }
  private prune() {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(key);
  }
  get(key: string, calculate: () => Promise<T>): Promise<T> {
    this.prune();
    const cached = this.entries.get(key);
    if (cached) return cached.value;
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    const entry = { expires: Infinity, value: Promise.resolve().then(calculate) };
    this.entries.set(key, entry);
    entry.value.then(() => { entry.expires = this.now() + this.ttl; }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.value;
  }
}
