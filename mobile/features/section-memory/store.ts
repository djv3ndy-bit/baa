export type SectionLease = Readonly<{ scope: string; accountId: string | null; generation: number }>;
type Entry = { json: string; savedAt: number };

/** Short-lived display snapshots only. Never used to authorize an action or stored on disk. */
export class SectionMemoryStore {
  private scope = '';
  private accountId: string | null = null;
  private expiresAt = 0;
  private generation = 0;
  private role: string | null = null;
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  constructor(private now = Date.now, private ttl = 5 * 60_000, private maxEntries = 12, private maxCharacters = 2_000_000) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  version = () => this.generation;
  lease = (): SectionLease => ({ scope: this.scope, accountId: this.accountId, generation: this.generation });
  current = (lease: SectionLease) => lease.scope === this.scope && lease.accountId === this.accountId && lease.generation === this.generation;

  setSession(scope: string, accountId: string | null, expiresAt = 0) {
    const changed = this.scope !== scope || this.accountId !== accountId;
    this.scope = scope; this.accountId = accountId; this.expiresAt = expiresAt;
    if (changed) { this.role = null; this.reset(); }
  }
  reset() {
    this.entries.clear(); this.generation++;
    for (const listener of this.listeners) listener();
  }
  read<T>(lease: SectionLease, key: string): T | undefined {
    if (!this.current(lease) || !this.accountId || this.expiresAt <= this.now()) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    if (this.now() - entry.savedAt >= this.ttl) { this.entries.delete(key); return; }
    // Recency is bounded. Return a copy so an editor cannot mutate the saved snapshot.
    this.entries.delete(key); this.entries.set(key, entry);
    return JSON.parse(entry.json) as T;
  }
  save<T>(lease: SectionLease, key: string, accountId: string, role: string, value: T): boolean {
    if (!this.current(lease) || !accountId || accountId !== this.accountId || this.expiresAt <= this.now()) return false;
    if (this.role && this.role !== role) { this.role = role; this.reset(); return false; }
    this.role = role;
    let json: string;
    try { json = JSON.stringify(value); } catch { return false; }
    if (!json || json.length > this.maxCharacters) { this.entries.delete(key); return false; }
    this.entries.delete(key); this.entries.set(key, { json, savedAt: this.now() });
    let size = [...this.entries.values()].reduce((sum, item) => sum + item.json.length, 0);
    while (this.entries.size > this.maxEntries || size > this.maxCharacters) {
      const oldest = this.entries.keys().next().value!;
      size -= this.entries.get(oldest)!.json.length; this.entries.delete(oldest);
    }
    return true;
  }
  forget(lease: SectionLease, key: string) { if (this.current(lease)) this.entries.delete(key); }
}

export const sectionMemory = new SectionMemoryStore();
