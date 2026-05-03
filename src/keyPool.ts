import { quarantineMs } from "./errors.js";
import type { ErrorClass, HealthState } from "./types.js";

export type ApiKeyLease = {
  id: string;
  value: string;
};

type KeyEntry = {
  id: string;
  value: string;
  health: HealthState;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isRetryable(entry: KeyEntry, now = Date.now()): boolean {
  return !entry.health.nextRetryAt || Date.parse(entry.health.nextRetryAt) <= now;
}

export class ApiKeyPool {
  private index = 0;
  private readonly entries: KeyEntry[];

  constructor(keys: string[], private readonly quarantineSeconds = 300) {
    this.entries = keys.map((value, index) => ({
      id: `key-${index + 1}`,
      value,
      health: { healthy: true, consecutiveFailures: 0 }
    }));
  }

  hasKeys(): boolean {
    return this.entries.length > 0;
  }

  next(): ApiKeyLease | undefined {
    const candidates = this.entries.filter((entry) => entry.health.healthy || isRetryable(entry));
    if (candidates.length === 0) {
      return undefined;
    }

    const entry = candidates[this.index % candidates.length];
    this.index += 1;
    return { id: entry.id, value: entry.value };
  }

  reportSuccess(id: string): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) {
      return;
    }
    entry.health = {
      healthy: true,
      consecutiveFailures: 0,
      lastSuccessAt: nowIso()
    };
  }

  reportFailure(id: string, reason: ErrorClass): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) {
      return;
    }
    const failures = entry.health.consecutiveFailures + 1;
    entry.health = {
      healthy: false,
      consecutiveFailures: failures,
      lastSuccessAt: entry.health.lastSuccessAt,
      lastFailureAt: nowIso(),
      disabledReason: reason,
      nextRetryAt: new Date(Date.now() + quarantineMs(reason, this.quarantineSeconds, failures)).toISOString()
    };
  }

  size(): number {
    return this.entries.length;
  }

  snapshot() {
    return this.entries.map((entry) => ({
      id: entry.id,
      healthy: entry.health.healthy,
      lastSuccessAt: entry.health.lastSuccessAt,
      lastFailureAt: entry.health.lastFailureAt,
      consecutiveFailures: entry.health.consecutiveFailures,
      disabledReason: entry.health.disabledReason,
      nextRetryAt: entry.health.nextRetryAt
    }));
  }
}
