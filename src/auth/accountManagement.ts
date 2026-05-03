import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { diagnoseAccount } from "../accountDiagnosis.js";
import type { Runtime } from "../runtime.js";
import type { CloudCodeAccount, StoredAccount } from "../types.js";

const ManualRefreshImportSchema = z.object({
  email: z.string().email().optional(),
  displayName: z.string().optional(),
  refreshToken: z.string().min(8),
  scopes: z.array(z.string()).optional()
});

const JsonImportSchema = z.object({
  id: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  token: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    expiry_timestamp: z.number().optional(),
    project_id: z.string().optional(),
    oauth_client_key: z.string().optional(),
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

function idFrom(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function cloudToStored(account: CloudCodeAccount): StoredAccount {
  return {
    id: account.id,
    email: account.email,
    name: account.displayName,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
    oauthClientId: account.oauthClientId,
    projectId: account.projectId,
    scopes: account.scopes ?? [],
    supportedModels: account.quotaModels.map((model) => model.name),
    quota: account.quotaModels,
    status: account.disabled ? "disabled" : "active",
    source: account.source,
    health: account.health
  };
}

export function publicAccount(account: StoredAccount, activeAccountId?: string) {
  const diagnosis = diagnoseAccount(account);
  return {
    accountId: account.id,
    email: account.email,
    displayName: account.name,
    expiresAt: account.expiresAt,
    scopes: account.scopes ?? [],
    source: account.source ?? "imported_json",
    active: account.id === activeAccountId,
    disabled: account.status === "disabled",
    status: account.status ?? "active",
    projectId: account.projectId,
    quota: account.quota ?? [],
    health: account.health,
    diagnosis,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function addUnique(target: string[], value: string | undefined): void {
  if (!value || target.includes(value)) {
    return;
  }
  target.push(value);
}

function setAccountDisabled(runtime: Runtime, account: StoredAccount, disabled: boolean, reason = "disabled"): StoredAccount | undefined {
  const updated = runtime.cloudCodeAccounts.setDisabled(account.id, disabled, reason);
  if (!updated) {
    runtime.accountRegistry.upsert({
      ...account,
      status: disabled ? "disabled" : "active",
      health: disabled
        ? {
            ...account.health,
            healthy: false,
            disabledReason: reason,
            nextRetryAt: undefined
          }
        : {
            ...account.health,
            healthy: true,
            consecutiveFailures: 0,
            disabledReason: undefined,
            nextRetryAt: undefined
          }
    });
  }
  if (disabled && runtime.activeAccountId === account.id) {
    runtime.activeAccountId = undefined;
  }
  return runtime.accountRegistry.list(false).find((item) => item.id === account.id);
}

function accountQuotaWarnings(account: StoredAccount): string[] {
  const warnings: string[] = [];
  const label = account.email || account.name || account.id;
  const quotas = Array.isArray(account.quota) ? (account.quota as Array<{ name: string; percentage?: number }>) : [];
  const unhealthy = account.health ? !account.health.healthy : false;
  const retrying =
    Boolean(account.health?.nextRetryAt) && account.health?.nextRetryAt
      ? Date.parse(account.health.nextRetryAt) > Date.now()
      : false;

  if (unhealthy) {
    addUnique(warnings, `${label} karantinada`);
  }
  if (retrying) {
    addUnique(warnings, `${label} yeniden deneme bekliyor`);
  }
  if (!quotas.length) {
    addUnique(warnings, `${label} için kota bilgisi yok`);
    return warnings;
  }

  const low = quotas
    .map((quota) => ({
      name: quota.name,
      percentage: Number.isFinite(Number(quota.percentage)) ? Number(quota.percentage) : 0
    }))
    .filter((quota) => quota.percentage <= 20)
    .sort((a, b) => a.percentage - b.percentage)[0];
  if (low) {
    addUnique(warnings, `${label} ${low.name} kotası ${Math.round(low.percentage)}%`);
  }
  return warnings;
}

export function accountSummary(runtime: Runtime) {
  const accounts = runtime.accountRegistry.list(false);
  const healthy = accounts.filter((account) => account.health.healthy);
  const withQuota = accounts.map((account) => ({
    accountId: account.id,
    email: account.email,
    source: account.source ?? "imported_json",
    health: account.health,
    quota: account.quota ?? "unknown"
  }));
  const best = healthy[0];
  return {
    totalAccounts: accounts.length,
    healthyAccounts: healthy.length,
    activeAccountId: runtime.activeAccountId,
    bestAccount: best
      ? {
          accountId: best.id,
          email: best.email,
          reason: "healthy account with current retry window available"
        }
      : undefined,
    geminiQuota: "unknown",
    claudeQuota: "unknown",
    lowQuotaWarnings: accounts.flatMap(accountQuotaWarnings).slice(0, 8),
    accounts: withQuota
  };
}

export function registerAccountManagementRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.get("/auth/accounts/summary", async () => accountSummary(runtime));

  app.post<{ Body: { accountId?: string } }>("/auth/accounts/refresh", async (request) =>
    runtime.cloudCodeAccounts.refreshQuota(request.body?.accountId)
  );

  app.post<{ Body: unknown }>("/auth/accounts/import/refresh-token", async (request, reply) => {
    const parsed = ManualRefreshImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: "Invalid refresh token import payload", type: "request_error" } });
    }
    const id = `manual-${idFrom(parsed.data.email ?? parsed.data.refreshToken)}`;
    const account: CloudCodeAccount = {
      id,
      source: "manual_refresh_token",
      email: parsed.data.email,
      displayName: parsed.data.displayName,
      accessToken: "pending-refresh",
      refreshToken: parsed.data.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      scopes: parsed.data.scopes ?? [],
      disabled: false,
      health: { healthy: true, consecutiveFailures: 0 },
      quotaModels: []
    };
    runtime.accountRegistry.upsert(cloudToStored(account));
    runtime.cloudCodeAccounts.addOrUpdate(account);
    runtime.activeAccountId = account.id;
    return { imported: true, account: publicAccount(cloudToStored(account), runtime.activeAccountId) };
  });

  app.post<{ Body: unknown }>("/auth/accounts/import/json", async (request, reply) => {
    const parsed = JsonImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: "Invalid account JSON import payload", type: "request_error" } });
    }
    const id = parsed.data.id ?? `json-${idFrom(parsed.data.email ?? parsed.data.token.email ?? randomUUID())}`;
    const account: CloudCodeAccount = {
      id,
      source: "imported_json",
      email: parsed.data.email ?? parsed.data.token.email,
      displayName: parsed.data.name,
      accessToken: parsed.data.token.access_token,
      refreshToken: parsed.data.token.refresh_token,
      expiresAt: parsed.data.token.expiry_timestamp,
      projectId: parsed.data.token.project_id,
      oauthClientId: parsed.data.token.oauth_client_key,
      scopes: [],
      disabled: false,
      health: { healthy: true, consecutiveFailures: 0 },
      quotaModels:
        parsed.data.quota?.models?.map((model) => ({
          name: model.name,
          displayName: model.display_name,
          percentage: model.percentage,
          resetTime: model.reset_time
        })) ?? []
    };
    runtime.accountRegistry.upsert(cloudToStored(account));
    runtime.cloudCodeAccounts.addOrUpdate(account);
    runtime.activeAccountId = account.id;
    return { imported: true, account: publicAccount(cloudToStored(account), runtime.activeAccountId) };
  });

  app.post<{ Body: { includeEncryptedSecrets?: boolean } }>("/auth/accounts/export", async (request) => {
    if (request.body?.includeEncryptedSecrets) {
      return {
        encrypted: true,
        exportedAt: new Date().toISOString(),
        accounts: runtime.accountRegistry.rawRows()
      };
    }
    return {
      encrypted: false,
      exportedAt: new Date().toISOString(),
      accounts: runtime.accountRegistry.list(false).map((account) => publicAccount(account, runtime.activeAccountId))
    };
  });

  app.post<{ Params: { accountId: string } }>("/auth/accounts/switch/:accountId", async (request, reply) => {
    const target = runtime.accountRegistry.list(false).find((account) => account.id === request.params.accountId);
    if (!target) {
      return reply.status(404).send({ error: { message: "Account not found", type: "not_found" } });
    }
    if (target.status === "disabled") {
      return reply.status(409).send({ error: { message: "Account is disabled", type: "request_error" } });
    }
    runtime.activeAccountId = request.params.accountId;
    return { activeAccountId: runtime.activeAccountId };
  });

  app.post<{ Params: { accountId: string } }>("/auth/accounts/disable/:accountId", async (request, reply) => {
    const target = runtime.accountRegistry.list(false).find((account) => account.id === request.params.accountId);
    if (!target) {
      return reply.status(404).send({ error: { message: "Account not found", type: "not_found" } });
    }
    const diagnosis = diagnoseAccount(target);
    const disabledReason = diagnosis.isProblem ? diagnosis.disableReason ?? "manual:unstable" : "disabled";
    const updated = runtime.cloudCodeAccounts.setDisabled(request.params.accountId, true, disabledReason);
    if (!updated) {
      runtime.accountRegistry.upsert({
        ...target,
        status: "disabled",
        health: {
          ...target.health,
          healthy: false,
          disabledReason: disabledReason,
          nextRetryAt: undefined
        }
      });
    }
    if (runtime.activeAccountId === request.params.accountId) {
      runtime.activeAccountId = undefined;
    }
    const account = runtime.accountRegistry.list(false).find((item) => item.id === request.params.accountId);
    return { updated: true, account: account ? publicAccount(account, runtime.activeAccountId) : undefined };
  });

  app.post("/auth/accounts/disable-broken", async () => {
    const accounts = runtime.accountRegistry.list(false);
    const updatedAccounts = [];
    for (const account of accounts) {
      const diagnosis = diagnoseAccount(account);
      if (!diagnosis.isProblem || !diagnosis.canDisable || account.status === "disabled") {
        continue;
      }
      const updated = runtime.cloudCodeAccounts.setDisabled(account.id, true, diagnosis.disableReason ?? "manual:unstable");
      if (!updated) {
        runtime.accountRegistry.upsert({
          ...account,
          status: "disabled",
          health: {
            ...account.health,
            healthy: false,
            disabledReason: diagnosis.disableReason ?? "manual:unstable",
            nextRetryAt: undefined
          }
        });
      }
      if (runtime.activeAccountId === account.id) {
        runtime.activeAccountId = undefined;
      }
      updatedAccounts.push(account.id);
    }
    return {
      updated: true,
      disabledCount: updatedAccounts.length,
      accounts: runtime.accountRegistry.list(false).map((account) => publicAccount(account, runtime.activeAccountId))
    };
  });

  app.post("/auth/accounts/check-all", async () => {
    const accounts = runtime.accountRegistry.list(false);
    const results = [];

    for (const account of accounts) {
      const enabledAccount = setAccountDisabled(runtime, account, false);
      const candidate = enabledAccount ?? account;
      const refresh = await runtime.cloudCodeAccounts.refreshQuota(candidate.id);
      const current = runtime.accountRegistry.list(false).find((item) => item.id === candidate.id) ?? candidate;
      const diagnosis = diagnoseAccount(current);
      const shouldDisable = diagnosis.isProblem && diagnosis.canDisable;
      const finalAccount = shouldDisable
        ? setAccountDisabled(runtime, current, true, diagnosis.disableReason ?? "manual:unstable") ?? current
        : current;

      results.push({
        accountId: finalAccount.id,
        email: finalAccount.email,
        checked: true,
        refresh,
        disabled: shouldDisable,
        diagnosisBeforeDisable: diagnosis,
        account: publicAccount(finalAccount, runtime.activeAccountId)
      });
    }

    return {
      updated: true,
      checkedCount: results.length,
      disabledCount: results.filter((item) => item.disabled).length,
      results,
      accounts: runtime.accountRegistry.list(false).map((account) => publicAccount(account, runtime.activeAccountId))
    };
  });

  app.post<{ Params: { accountId: string } }>("/auth/accounts/enable/:accountId", async (request, reply) => {
    const target = runtime.accountRegistry.list(false).find((account) => account.id === request.params.accountId);
    if (!target) {
      return reply.status(404).send({ error: { message: "Account not found", type: "not_found" } });
    }
    const account = setAccountDisabled(runtime, target, false);
    return { updated: true, account: account ? publicAccount(account, runtime.activeAccountId) : undefined };
  });
}
