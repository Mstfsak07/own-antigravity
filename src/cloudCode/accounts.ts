import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { classifyError, classifyStatus, quarantineMs } from "../errors.js";
import { geminiCompatibilityCandidates, normalizeGeminiModelName } from "../geminiModels.js";
import type { CloudCodeAccount, ProxyConfig } from "../types.js";
import { refreshCloudCodeToken } from "./oauth.js";
import { fetchCloudCodeQuota } from "./quota.js";

const CLOUD_CODE_RATE_LIMIT_QUARANTINE_MS = 24 * 60 * 60 * 1000;
const CLOUD_CODE_TIMEOUT_QUARANTINE_MS = 15 * 60 * 1000;
const CLOUD_CODE_TIMEOUT_MODEL_COOLDOWN_MS = 10 * 60 * 1000;

const AccountFileSchema = z.object({
  id: z.string().optional(),
  email: z.string().optional(),
  disabled: z.boolean().optional(),
  validation_blocked: z.boolean().optional(),
  token: z.object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    expiry_timestamp: z.number().optional(),
    oauth_client_key: z.string().optional(),
    project_id: z.string().optional(),
    email: z.string().optional()
  }),
  quota: z
    .object({
      models: z
        .array(
          z.object({
            name: z.string(),
            display_name: z.string().optional(),
            percentage: z.number().optional(),
            reset_time: z.string().optional()
          })
        )
        .optional()
    })
    .optional()
});

function isJsonFile(name: string): boolean {
  return name.toLowerCase().endsWith(".json");
}

function isTokenFresh(expiresAt: number | undefined, skewSeconds: number): boolean {
  if (!expiresAt) {
    return true;
  }
  return expiresAt > Math.floor(Date.now() / 1000) + skewSeconds;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeFailureReason(reason: ReturnType<typeof classifyStatus> | ReturnType<typeof classifyError> | string) {
  if (typeof reason === "string" && reason.startsWith("http_")) {
    const status = Number(reason.slice(5));
    if (Number.isFinite(status)) {
      return classifyStatus(status);
    }
  }
  return reason as ReturnType<typeof classifyStatus> | ReturnType<typeof classifyError>;
}

function cloudCodeQuarantineMs(
  reason: ReturnType<typeof classifyStatus> | ReturnType<typeof classifyError>,
  defaultSeconds: number,
  failureCount: number
): number {
  if (reason === "rate_limit") {
    return CLOUD_CODE_RATE_LIMIT_QUARANTINE_MS;
  }
  if (reason === "timeout") {
    const multiplier = Math.min(4, 2 ** Math.max(0, failureCount - 1));
    return Math.max(defaultSeconds * 1000, CLOUD_CODE_TIMEOUT_QUARANTINE_MS) * multiplier;
  }
  return quarantineMs(reason, defaultSeconds, failureCount);
}

function isTimeoutFailure(statusOrReason: number | string): boolean {
  return statusOrReason === 408 ||
    statusOrReason === 504 ||
    statusOrReason === "timeout" ||
    statusOrReason === "http_408" ||
    statusOrReason === "http_504";
}

function canRetry(account: CloudCodeAccount): boolean {
  return !account.health.nextRetryAt || Date.parse(account.health.nextRetryAt) <= Date.now();
}

function lastSuccessTimestamp(account: CloudCodeAccount): number {
  const value = account.health.lastSuccessAt;
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function normalizeCloudCodeModelName(model: string): string {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");
}

function requiresProjectBinding(model: string): boolean {
  const normalized = normalizeCloudCodeModelName(model);
  return Boolean(normalized);
}

function claudeCompatibilityCandidates(model: string): string[] {
  const normalized = normalizeCloudCodeModelName(model);
  const candidates = [normalized];

  if (!normalized.startsWith("claude")) {
    return candidates;
  }

  if (normalized === "claude-haiku" || normalized.startsWith("claude-haiku-")) {
    candidates.push(
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-opus-4-6-thinking",
      "claude-opus-4-7",
      "claude-opus-4-1"
    );
  } else if (normalized === "claude-sonnet" || normalized.startsWith("claude-sonnet-")) {
    candidates.push(
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-opus-4-6-thinking",
      "claude-opus-4-7",
      "claude-opus-4-1"
    );
  } else if (normalized === "claude-opus" || normalized.startsWith("claude-opus-")) {
    candidates.push(
      "claude-opus-4-7",
      "claude-opus-4-6-thinking",
      "claude-opus-4-1",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5"
    );
  }

  if (normalized === "claude-opus-4-6") {
    candidates.unshift("claude-opus-4-6-thinking");
  }

  return [...new Set(candidates.map(normalizeCloudCodeModelName).filter(Boolean))];
}

export function cloudCodeModelCandidates(model: string): string[] {
  const normalized = normalizeCloudCodeModelName(model);
  if (normalized.startsWith("claude")) {
    return claudeCompatibilityCandidates(normalized);
  }
  return geminiCompatibilityCandidates(normalized);
}

export function cloudCodeRecoveryModelCandidates(model: string): string[] {
  const normalized = normalizeCloudCodeModelName(model);
  if (normalized === "claude-sonnet" || normalized.startsWith("claude-sonnet-")) {
    return ["claude-haiku-4-5"];
  }
  if (normalized === "claude-opus" || normalized.startsWith("claude-opus-")) {
    return ["claude-sonnet-4-6", "claude-haiku-4-5"];
  }
  if (normalized === "gemini-3-flash") {
    return ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro"];
  }
  if (normalized === "gemini-3-flash-agent") {
    return ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro"];
  }
  if (normalized === "gemini-2.5-flash" || normalized === "gemini-2.5-flash-thinking" || normalized === "gemini-2.5-flash-lite") {
    return ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro"];
  }
  return [];
}

function availableQuotaModels(account: CloudCodeAccount): string[] {
  return account.quotaModels
    .filter((quota) => quota.percentage === undefined || quota.percentage > 0)
    .map((quota) => quota.name.toLowerCase());
}

export function resolveCloudCodeModelForAccount(account: CloudCodeAccount, model: string): string {
  if (account.quotaModels.length === 0) {
    return model;
  }

  const available = new Set(availableQuotaModels(account));
  for (const candidate of cloudCodeModelCandidates(model)) {
    if (available.has(candidate)) {
      return candidate;
    }
  }

  return model;
}

function modelMatchScore(account: CloudCodeAccount, model: string): number {
  if (account.quotaModels.length === 0) {
    return 10;
  }

  const candidates = cloudCodeModelCandidates(model);
  let best = 0;
  for (const quota of account.quotaModels) {
      const quotaName = normalizeGeminiModelName(quota.name);
    if (quota.percentage !== undefined && quota.percentage <= 0) {
      continue;
    }
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const exact = quotaName === candidate ? 1 : 0;
      const includes = quotaName.includes(candidate) || candidate.includes(quotaName) ? 1 : 0;
      if (!exact && !includes) {
        continue;
      }
      const percentage = Number.isFinite(Number(quota.percentage)) ? Number(quota.percentage) : 0;
      const preference = Math.max(0, candidates.length - index) * 10;
      const score = 1000 + percentage + exact * 100 + includes * 25 + preference;
      if (score > best) {
        best = score;
      }
    }
  }
  return best;
}

export function loadCloudCodeAccounts(config: ProxyConfig): CloudCodeAccount[] {
  if (!config.cloudCode.enabled || !existsSync(config.cloudCode.accountsDir)) {
    return [];
  }

  const accounts: CloudCodeAccount[] = [];
  for (const file of readdirSync(config.cloudCode.accountsDir).filter(isJsonFile)) {
    try {
      const filePath = join(config.cloudCode.accountsDir, file);
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      const parsed = AccountFileSchema.parse(raw);
      const disabled = Boolean(parsed.disabled || parsed.validation_blocked);

      accounts.push({
        id: parsed.id ?? file.replace(/\.json$/i, ""),
        filePath,
        source: "imported_json",
        email: parsed.email ?? parsed.token.email,
        accessToken: parsed.token.access_token,
        refreshToken: parsed.token.refresh_token,
        expiresAt: parsed.token.expiry_timestamp,
        oauthClientId: parsed.token.oauth_client_key,
        projectId: parsed.token.project_id,
        scopes: [],
        disabled,
        health: {
          healthy: !disabled,
          consecutiveFailures: 0,
          disabledReason: disabled ? "disabled" : undefined
        },
        quotaModels:
          parsed.quota?.models?.map((model) => ({
            name: model.name,
            displayName: model.display_name,
            percentage: model.percentage,
            resetTime: model.reset_time
          })) ?? []
      });
    } catch {
      continue;
    }
  }

  return accounts.filter((account) => !account.disabled);
}

export function accountSupportsModel(account: CloudCodeAccount, model: string): boolean {
  if (account.quotaModels.length === 0) {
    return true;
  }

  const candidates = cloudCodeModelCandidates(model);
  return account.quotaModels.some((quota) => {
    const quotaName = normalizeGeminiModelName(quota.name);
    if (quota.percentage !== undefined && quota.percentage <= 0) {
      return false;
    }
    return candidates.some((candidate) =>
      quotaName === candidate || candidate.includes(quotaName) || quotaName.includes(candidate)
    );
  });
}

export class CloudCodeAccountPool {
  private index = 0;
  private readonly modelState = new Map<string, Map<string, { successAt?: number; failureAt?: number; failureCount: number; cooldownUntil?: number }>>();

  constructor(
    private readonly accounts: CloudCodeAccount[],
    private readonly config: ProxyConfig,
    private readonly onAccountUpdated?: (account: CloudCodeAccount) => void
  ) {}

  size(): number {
    return this.accounts.length;
  }

  private modelStateFor(accountId: string): Map<string, { successAt?: number; failureAt?: number; failureCount: number; cooldownUntil?: number }> {
    let state = this.modelState.get(accountId);
    if (!state) {
      state = new Map();
      this.modelState.set(accountId, state);
    }
    return state;
  }

  private modelKey(model: string): string {
    return cloudCodeModelCandidates(model)[0] ?? model.toLowerCase();
  }

  private isModelCoolingDown(accountId: string, model: string): boolean {
    const state = this.modelState.get(accountId)?.get(this.modelKey(model));
    return Boolean(state?.cooldownUntil && state.cooldownUntil > Date.now());
  }

  private modelScoreDelta(accountId: string, model: string): number {
    const state = this.modelState.get(accountId)?.get(this.modelKey(model));
    if (!state) {
      return 0;
    }
    let score = 0;
    if (state.successAt) {
      score += 40;
    }
    if (state.failureAt) {
      score -= Math.min(60, state.failureCount * 15);
    }
    return score;
  }

  private combinedSelectionScore(account: CloudCodeAccount, model: string): number {
    return modelMatchScore(account, model) + this.modelScoreDelta(account.id, model);
  }

  list(): CloudCodeAccount[] {
    return [...this.accounts];
  }

  addOrUpdate(account: CloudCodeAccount): void {
    const existing = this.accounts.find((item) => item.id === account.id);
    if (existing) {
      Object.assign(existing, account);
      this.onAccountUpdated?.(existing);
      return;
    }
    this.accounts.push(account);
    this.onAccountUpdated?.(account);
  }

  clearProjectId(accountId: string): CloudCodeAccount | undefined {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) {
      return undefined;
    }
    if (account.projectId) {
      account.projectId = undefined;
      this.onAccountUpdated?.(account);
    }
    return account;
  }

  remove(accountId: string): boolean {
    const index = this.accounts.findIndex((account) => account.id === accountId);
    if (index === -1) {
      return false;
    }
    this.accounts.splice(index, 1);
    return true;
  }

  hasAccounts(): boolean {
    return this.accounts.length > 0;
  }

  healthyCount(): number {
    return this.accounts.filter((account) => !account.disabled && account.health.healthy && canRetry(account)).length;
  }

  unhealthyCount(): number {
    return this.accounts.length - this.healthyCount();
  }

  async select(model: string, options: { excludeIds?: string[] } = {}): Promise<CloudCodeAccount | undefined> {
    const excludeIds = new Set(options.excludeIds || []);
    const eligibleCandidates = this.accounts
      .filter((account) => !account.disabled)
      .filter((account) => !excludeIds.has(account.id))
      .filter((account) => accountSupportsModel(account, model));
    const hasProjectBoundCandidate =
      requiresProjectBinding(model) && eligibleCandidates.some((account) => Boolean(account.projectId));
    const baseCandidates = eligibleCandidates
      .filter((account) => canRetry(account));
    const projectBoundCandidates =
      hasProjectBoundCandidate
        ? baseCandidates.filter((account) => Boolean(account.projectId))
        : baseCandidates;
    const candidates = (projectBoundCandidates.some((account) => !this.isModelCoolingDown(account.id, model))
      ? projectBoundCandidates.filter((account) => !this.isModelCoolingDown(account.id, model))
      : projectBoundCandidates)
      .sort((a, b) => {
        const matchDiff = this.combinedSelectionScore(b, model) - this.combinedSelectionScore(a, model);
        if (matchDiff !== 0) return matchDiff;
        const quotaDiff = Number(b.quotaModels.length > 0) - Number(a.quotaModels.length > 0);
        if (quotaDiff !== 0) return quotaDiff;
        const projectDiff = Number(Boolean(b.projectId)) - Number(Boolean(a.projectId));
        if (projectDiff !== 0) return projectDiff;
        const healthDiff = Number(b.health.healthy) - Number(a.health.healthy);
        if (healthDiff !== 0) return healthDiff;
        const failureDiff = a.health.consecutiveFailures - b.health.consecutiveFailures;
        if (failureDiff !== 0) return failureDiff;
        return lastSuccessTimestamp(b) - lastSuccessTimestamp(a);
      });
    if (candidates.length === 0) {
      return undefined;
    }

    const topScore = this.combinedSelectionScore(candidates[0], model);
    const topCandidates = candidates.filter((account) => this.combinedSelectionScore(account, model) === topScore);
    const selected = topCandidates[this.index % topCandidates.length];
    this.index += 1;
    return this.ensureFresh(selected);
  }

  reportSuccess(accountId: string): void {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) {
      return;
    }
    account.health = {
      healthy: true,
      consecutiveFailures: 0,
      lastSuccessAt: nowIso()
    };
    this.onAccountUpdated?.(account);
  }

  noteModelSuccess(accountId: string, model: string): void {
    const state = this.modelStateFor(accountId);
    state.set(this.modelKey(model), {
      successAt: Date.now(),
      failureAt: undefined,
      failureCount: 0,
      cooldownUntil: undefined
    });
  }

  noteModelFailure(accountId: string, model: string, statusOrReason: number | string): void {
    const state = this.modelStateFor(accountId);
    const key = this.modelKey(model);
    const current = state.get(key) ?? { failureCount: 0 };
    const failureCount = current.failureCount + 1;
    let cooldownMs = 15_000;
    if (isTimeoutFailure(statusOrReason)) {
      cooldownMs = CLOUD_CODE_TIMEOUT_MODEL_COOLDOWN_MS;
    } else if (statusOrReason === 429 || statusOrReason === "rate_limit" || statusOrReason === "http_429") {
      cooldownMs = 120_000;
    } else if (statusOrReason === 401 || statusOrReason === 403 || statusOrReason === "auth_error") {
      cooldownMs = 180_000;
    } else if (statusOrReason === 500 || statusOrReason === 503 || statusOrReason === "provider_error" || statusOrReason === "http_500" || statusOrReason === "http_503") {
      cooldownMs = 30_000;
    }
    state.set(key, {
      successAt: current.successAt,
      failureAt: Date.now(),
      failureCount,
      cooldownUntil: Date.now() + cooldownMs
    });
  }

  private reportNonBlockingFailure(
    account: CloudCodeAccount,
    reason: ReturnType<typeof classifyStatus> | ReturnType<typeof classifyError> | string
  ): void {
    const failures = account.health.consecutiveFailures + 1;
    const normalizedReason = normalizeFailureReason(reason);
    account.disabled = false;
    account.health = {
      healthy: false,
      consecutiveFailures: failures,
      lastSuccessAt: account.health.lastSuccessAt,
      lastFailureAt: nowIso(),
      disabledReason: reason,
      nextRetryAt: new Date(Date.now() + cloudCodeQuarantineMs(normalizedReason, this.config.cloudCode.quarantineSeconds, failures)).toISOString()
    };
    this.onAccountUpdated?.(account);
  }

  reportFailure(accountId: string, reason: ReturnType<typeof classifyStatus> | ReturnType<typeof classifyError>): void {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) {
      return;
    }
    if (this.config.cloudCode.preserveAvailabilityOnError) {
      this.reportNonBlockingFailure(account, reason);
      return;
    }
    const failures = account.health.consecutiveFailures + 1;
    account.health = {
      healthy: false,
      consecutiveFailures: failures,
      lastSuccessAt: account.health.lastSuccessAt,
      lastFailureAt: nowIso(),
      disabledReason: reason,
      nextRetryAt: new Date(Date.now() + cloudCodeQuarantineMs(reason, this.config.cloudCode.quarantineSeconds, failures)).toISOString()
    };
    this.onAccountUpdated?.(account);
  }

  reportStatusFailure(accountId: string, status: number): void {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) {
      return;
    }
    if (status === 408 || status === 504) {
      this.reportFailure(accountId, "timeout");
      return;
    }
    if (this.config.cloudCode.preserveAvailabilityOnError) {
      this.reportNonBlockingFailure(account, `http_${status}`);
      return;
    }
    if (status === 429 || status >= 500) {
      account.disabled = true;
      account.health = {
        healthy: false,
        consecutiveFailures: account.health.consecutiveFailures + 1,
        lastSuccessAt: account.health.lastSuccessAt,
        lastFailureAt: nowIso(),
        disabledReason: `http_${status}`,
        nextRetryAt: undefined
      };
      this.onAccountUpdated?.(account);
      return;
    }
    this.reportFailure(accountId, classifyStatus(status));
  }

  setDisabled(accountId: string, disabled: boolean, reason = "disabled"): CloudCodeAccount | undefined {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) {
      return undefined;
    }
    account.disabled = disabled;
    if (disabled) {
      account.health = {
        healthy: false,
        consecutiveFailures: account.health.consecutiveFailures,
        lastSuccessAt: account.health.lastSuccessAt,
        lastFailureAt: account.health.lastFailureAt,
        disabledReason: reason,
        nextRetryAt: undefined
      };
    } else {
      account.health = {
        healthy: true,
        consecutiveFailures: 0,
        lastSuccessAt: account.health.lastSuccessAt,
        lastFailureAt: account.health.lastFailureAt,
        disabledReason: undefined,
        nextRetryAt: undefined
      };
    }
    this.onAccountUpdated?.(account);
    return account;
  }

  async refresh(account: CloudCodeAccount): Promise<CloudCodeAccount | undefined> {
    try {
      const refreshed = await refreshCloudCodeToken(this.config, account);
      Object.assign(account, refreshed);
      this.reportSuccess(account.id);
      this.onAccountUpdated?.(account);
      return account;
    } catch (error) {
      this.reportFailure(account.id, classifyError(error));
      return undefined;
    }
  }

  async refreshQuota(accountId?: string): Promise<{ total: number; success: number; failed: number; details: string[] }> {
    const candidates = this.accounts.filter((account) => !account.disabled && (!accountId || account.id === accountId));
    const details: string[] = [];
    let success = 0;
    let failed = 0;

    for (const account of candidates) {
      const fresh = await this.ensureFresh(account);
      if (!fresh) {
        failed += 1;
        details.push(`${account.email ?? account.id}: token refresh failed`);
        continue;
      }

      try {
        const updated = await fetchCloudCodeQuota(this.config, fresh);
        Object.assign(account, updated);
        this.reportSuccess(account.id);
        success += 1;
      } catch (error) {
        this.reportFailure(account.id, classifyError(error));
        failed += 1;
        details.push(`${account.email ?? account.id}: ${error instanceof Error ? error.message : "quota refresh failed"}`);
      }
    }

    return { total: candidates.length, success, failed, details };
  }

  private async ensureFresh(account: CloudCodeAccount): Promise<CloudCodeAccount | undefined> {
    if (isTokenFresh(account.expiresAt, this.config.cloudCode.refreshSkewSeconds)) {
      return account;
    }

    return this.refresh(account);
  }
}
