/** A bounded cache for short-lived failures. Keys must include access and content versions. */
export class ExpiringMap<T> {
  private entries = new Map<string, { value: T; expires: number }>();
  constructor(private capacity: number, private now = () => Date.now()) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
  set(key: string, value: T, ttl: number) {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(key);
    this.entries.delete(key);
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expires: this.now() + ttl });
  }
}
