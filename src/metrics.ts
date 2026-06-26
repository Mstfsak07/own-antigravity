import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

type RouteStats = {
  count: number;
  statuses: Record<string, number>;
};

type ProviderStats = {
  requests: number;
  errors: number;
};

export type TrafficRecord = {
  at: string;
  actor?: string;
  event?: string;
  method: string;
  route: string;
  provider: string;
  model: string;
  resolvedModel?: string;
  account?: string;
  statusCode: number;
  durationMs?: number;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
  requestBody?: unknown;
  responseBody?: unknown;
  errorBody?: unknown;
};

export type ProviderTrafficRecordInput = {
  at?: string;
  actor?: string;
  event?: string;
  method: string;
  route: string;
  provider: string;
  model?: string;
  resolvedModel?: string;
  account?: string;
  statusCode: number;
  startedAt?: number;
  durationMs?: number;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
  requestBody?: unknown;
  responseBody?: unknown;
  errorBody?: unknown;
};

const MAX_RECENT_RECORDS = 500;
const MAX_HISTORY_LOAD = 1000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVES = 5;

export function serializeTrafficPayload(value: unknown, maxLength = 12000): string {
  if (value === undefined) return "";
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (!text) return "";
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n…` : text;
  } catch {
    const text = String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n…` : text;
  }
}

export function estimateTrafficTokens(requestBody: unknown, responseBody: unknown): {
  input: number;
  output: number;
  total: number;
} {
  const requestText = serializeTrafficPayload(requestBody, 4000);
  const responseText = serializeTrafficPayload(responseBody, 4000);
  const input = requestText ? Math.max(1, Math.ceil(requestText.length / 4)) : 0;
  const output = responseText ? Math.max(1, Math.ceil(responseText.length / 4)) : 0;
  return {
    input,
    output,
    total: input + output
  };
}

function compactTrafficPayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = serializeTrafficPayload(value);
  if (text === "") return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class Metrics {
  private readonly startedAt = Date.now();
  private readonly trafficPath: string;
  private readonly auditPath: string;
  private totalRequests = 0;
  private errorCount = 0;
  private fallbackCount = 0;
  private lastError: { at: string; route: string; statusCode: number } | undefined;
  private recentErrors: Array<{ at: string; route: string; statusCode: number }> = [];
  private recentRequests: TrafficRecord[] = [];
  private readonly routes = new Map<string, RouteStats>();
  private readonly providers = new Map<string, ProviderStats>();
  private activeProvider: string | undefined;

  constructor(dataDir?: string) {
    this.trafficPath = dataDir ? join(dataDir, "traffic-log.jsonl") : "";
    this.auditPath = dataDir ? join(dataDir, "audit-log.jsonl") : "";
    this.recentRequests = this.loadTrafficHistory();
  }

  private archivePattern(path: string): RegExp {
    const stem = basename(path, ".jsonl").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${stem}-\\d{8}T\\d{6}\\.jsonl\\.gz$`);
  }

  private archiveName(path: string): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "T");
    return `${basename(path, ".jsonl")}-${stamp}.jsonl.gz`;
  }

  private parseTrafficLines(raw: string): TrafficRecord[] {
    const history: TrafficRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as TrafficRecord;
        if (record && record.at && record.route) {
          history.push(record);
        }
      } catch {
        continue;
      }
    }
    return history;
  }

  private readArchiveRecords(path: string): TrafficRecord[] {
    try {
      const raw = gunzipSync(readFileSync(path)).toString("utf8");
      return this.parseTrafficLines(raw);
    } catch {
      return [];
    }
  }

  private pruneArchives(path: string): void {
    const dir = dirname(path);
    const archives = readdirSync(dir)
      .filter((name) => this.archivePattern(path).test(name))
      .map((name) => ({
        name,
        fullPath: join(dir, name),
        mtimeMs: statSync(join(dir, name)).mtimeMs
      }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    for (const archive of archives.slice(MAX_ARCHIVES)) {
      try {
        rmSync(archive.fullPath, { force: true });
      } catch {}
    }
  }

  private maybeRotate(path: string): void {
    if (!path || !existsSync(path)) {
      return;
    }
    const size = statSync(path).size;
    if (size < MAX_LOG_BYTES) {
      return;
    }
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const archivePath = join(dir, this.archiveName(path));
    const raw = readFileSync(path);
    writeFileSync(archivePath, gzipSync(raw));
    writeFileSync(path, "", "utf8");
    this.pruneArchives(path);
  }

  private loadTrafficHistory(): TrafficRecord[] {
    if (!this.trafficPath || !existsSync(this.trafficPath)) {
      return this.loadArchivedTrafficHistory();
    }
    const live = this.parseTrafficLines(readFileSync(this.trafficPath, "utf8"));
    const archived = this.loadArchivedTrafficHistory();
    return [...live.reverse(), ...archived].slice(0, MAX_HISTORY_LOAD);
  }

  private loadArchivedTrafficHistory(): TrafficRecord[] {
    if (!this.trafficPath) {
      return [];
    }
    const dir = dirname(this.trafficPath);
    if (!existsSync(dir)) {
      return [];
    }
    const archives = readdirSync(dir)
      .filter((name) => this.archivePattern(this.trafficPath).test(name))
      .sort()
      .reverse()
      .slice(0, MAX_ARCHIVES);
    const history: TrafficRecord[] = [];
    for (const name of archives) {
      const records = this.readArchiveRecords(join(dir, name));
      history.push(...records.reverse());
      if (history.length >= MAX_HISTORY_LOAD) {
        break;
      }
    }
    return history.slice(0, MAX_HISTORY_LOAD);
  }

  private persistTraffic(record: TrafficRecord): void {
    if (!this.trafficPath) {
      return;
    }
    mkdirSync(dirname(this.trafficPath), { recursive: true });
    appendFileSync(this.trafficPath, `${JSON.stringify(record)}\n`, "utf8");
    this.maybeRotate(this.trafficPath);
    if (this.auditPath) {
      mkdirSync(dirname(this.auditPath), { recursive: true });
      appendFileSync(
        this.auditPath,
        `${JSON.stringify({
          at: record.at,
          event: record.event ?? "request",
          actor: record.actor ?? record.account ?? record.provider,
          provider: record.provider,
          model: record.model,
          resolvedModel: record.resolvedModel,
          account: record.account,
          statusCode: record.statusCode,
          route: record.route,
          tokens: record.tokens
        })}\n`,
        "utf8"
      );
      this.maybeRotate(this.auditPath);
    }
  }

  record(method: string, route: string, statusCode: number): void {
    this.totalRequests += 1;
    const key = `${method.toUpperCase()} ${route}`;
    const stats = this.routes.get(key) ?? { count: 0, statuses: {} };
    stats.count += 1;
    stats.statuses[String(statusCode)] = (stats.statuses[String(statusCode)] ?? 0) + 1;
    this.routes.set(key, stats);
    if (statusCode >= 400) {
      this.errorCount += 1;
      this.lastError = { at: new Date().toISOString(), route: key, statusCode };
      this.recentErrors = [this.lastError, ...this.recentErrors].slice(0, 20);
    }
  }

  recordFallback(): void {
    this.fallbackCount += 1;
  }

  recordProviderRequest(provider: string, ok: boolean): void {
    this.activeProvider = provider;
    const stats = this.providers.get(provider) ?? { requests: 0, errors: 0 };
    stats.requests += 1;
    if (!ok) {
      stats.errors += 1;
    }
    this.providers.set(provider, stats);
  }

  recordTraffic(record: TrafficRecord): void {
    this.recentRequests = [record, ...this.recentRequests].slice(0, MAX_RECENT_RECORDS);
    this.persistTraffic(record);
  }

  recordProviderTraffic(input: ProviderTrafficRecordInput): TrafficRecord {
    const responsePayload = input.responseBody ?? input.errorBody;
    const record: TrafficRecord = {
      at: input.at ?? new Date().toISOString(),
      actor: input.actor,
      event: input.event ?? (input.statusCode >= 400 ? "error" : "request"),
      method: input.method,
      route: input.route,
      provider: input.provider,
      model: input.model ?? input.resolvedModel ?? "-",
      resolvedModel: input.resolvedModel,
      account: input.account,
      statusCode: input.statusCode,
      durationMs: input.durationMs ?? (input.startedAt !== undefined ? Date.now() - input.startedAt : undefined),
      tokens: input.tokens ?? estimateTrafficTokens(input.requestBody, responsePayload),
      requestBody: compactTrafficPayload(input.requestBody),
      responseBody: compactTrafficPayload(input.responseBody),
      errorBody: compactTrafficPayload(input.errorBody)
    };
    this.recordTraffic(record);
    return record;
  }

  setActiveProvider(provider: string): void {
    this.activeProvider = provider;
  }

  snapshot(accountCounts?: { healthy: number; unhealthy: number }) {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      totalRequests: this.totalRequests,
      errorCount: this.errorCount,
      fallbackCount: this.fallbackCount,
      activeProvider: this.activeProvider,
      providerRequests: Object.fromEntries([...this.providers.entries()].map(([provider, stats]) => [provider, stats.requests])),
      providerErrors: Object.fromEntries([...this.providers.entries()].map(([provider, stats]) => [provider, stats.errors])),
      accounts: accountCounts,
      lastError: this.lastError,
      recentErrors: this.recentErrors,
      recentRequests: this.recentRequests,
      auditTrail: this.recentRequests.slice(0, 100).map((record) => ({
        at: record.at,
        event: record.event ?? "request",
        actor: record.actor ?? record.account ?? record.provider,
        provider: record.provider,
        model: record.model,
        resolvedModel: record.resolvedModel,
        account: record.account,
        statusCode: record.statusCode,
        route: record.route,
        tokens: record.tokens
      })),
      routes: Object.fromEntries(this.routes.entries())
    };
  }
}
