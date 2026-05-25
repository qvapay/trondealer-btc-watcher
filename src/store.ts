import { randomUUID } from 'node:crypto';
import type { WatchedAddress } from './types.js';

class InMemoryStore {
  private watches = new Map<string, WatchedAddress>();
  private addressIndex = new Map<string, Set<string>>(); // address -> Set<id>

  add(params: Omit<WatchedAddress, 'id' | 'status' | 'created_at'>): WatchedAddress {
    const id = randomUUID();
    const watch: WatchedAddress = {
      ...params,
      id,
      status: 'pending',
      created_at: Date.now(),
    };
    this.watches.set(id, watch);

    // Index por address (múltiples watches pueden compartir address)
    if (!this.addressIndex.has(watch.address)) {
      this.addressIndex.set(watch.address, new Set());
    }
    this.addressIndex.get(watch.address)!.add(id);

    return watch;
  }

  get(id: string): WatchedAddress | undefined {
    return this.watches.get(id);
  }

  getByAddress(address: string): WatchedAddress[] {
    const ids = this.addressIndex.get(address);
    if (!ids) return [];
    return Array.from(ids)
      .map(id => this.watches.get(id))
      .filter((w): w is WatchedAddress => w !== undefined && w.status !== 'expired');
  }

  update(id: string, patch: Partial<WatchedAddress>): WatchedAddress | undefined {
    const existing = this.watches.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.watches.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    const watch = this.watches.get(id);
    if (!watch) return false;
    this.addressIndex.get(watch.address)?.delete(id);
    this.watches.delete(id);
    return true;
  }

  expireOld(): number {
    const now = Date.now();
    let count = 0;
    for (const watch of this.watches.values()) {
      if (watch.expires_at && watch.expires_at < now && watch.status === 'pending') {
        this.update(watch.id, { status: 'expired' });
        count++;
      }
    }
    return count;
  }

  list(): WatchedAddress[] {
    return Array.from(this.watches.values());
  }

  stats() {
    const total = this.watches.size;
    const by_status: Record<string, number> = {};
    for (const w of this.watches.values()) {
      by_status[w.status] = (by_status[w.status] || 0) + 1;
    }
    return { total, by_status, unique_addresses: this.addressIndex.size };
  }
}

export const store = new InMemoryStore();
