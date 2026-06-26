import { join } from "node:path";
import { SqliteAccountRegistry } from "./accounts/sqliteRegistry.js";
import { AssetProvisioner } from "./assets/provisioner.js";
import { CloudCodeAccountPool, loadCloudCodeAccounts } from "./cloudCode/accounts.js";
import { canonicalGeminiModel } from "./geminiModels.js";
import { ApiKeyPool } from "./keyPool.js";
import { NativeLsClient } from "./ls/nativeClient.js";
import { LsOrchestrator } from "./ls/orchestrator.js";
import { LsDiagnostics } from "./ls/diagnostics.js";
import { InternalTokenServer } from "./ls/tokenServer.js";
import { Metrics } from "./metrics.js";
import type { CloudCodeAccount, ProxyConfig, StoredAccount } from "./types.js";

export type Runtime = {
  config: ProxyConfig;
  geminiKeys: ApiKeyPool;
  anthropicKeys: ApiKeyPool;
  openaiKeys: ApiKeyPool;
  groqKeys: ApiKeyPool;
  cerebrasKeys: ApiKeyPool;
  ollamaKeys: ApiKeyPool;
  mistralKeys: ApiKeyPool;
  zaiKeys: ApiKeyPool;
  cloudCodeAccounts: CloudCodeAccountPool;
  assetProvisioner: AssetProvisioner;
  tokenServer: InternalTokenServer;
  lsOrchestrator: LsOrchestrator;
  nativeLsClient: NativeLsClient;
  lsDiagnostics: LsDiagnostics;
  accountRegistry: SqliteAccountRegistry;
  metrics: Metrics;
  activeAccountId?: string;
  resolveModel(model?: string): string;
};

function accountToStored(account: CloudCodeAccount): StoredAccount {
  return {
    id: account.id,
    email: account.email,
    name: account.displayName,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
    oauthClientId: account.oauthClientId,
    projectId: account.projectId,
    scopes: account.scopes,
    supportedModels: account.quotaModels.map((model) => model.name),
    quota: account.quotaModels,
    status: account.disabled ? "disabled" : "active",
    source: account.source,
    health: account.health,
    lastSuccessAt: account.health.lastSuccessAt,
    lastFailureAt: account.health.lastFailureAt,
    nextRetryAt: account.health.nextRetryAt
  };
}

function storedToCloudCodeAccount(account: StoredAccount): CloudCodeAccount | undefined {
  if (!account.accessToken) {
    return undefined;
  }
  return {
    id: account.id,
    source: account.source ?? "imported_json",
    email: account.email,
    displayName: account.name,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
    oauthClientId: account.oauthClientId,
    projectId: account.projectId,
    scopes: account.scopes,
    disabled: account.status === "disabled",
    health: account.health,
    quotaModels: (account.quota as CloudCodeAccount["quotaModels"] | undefined) ?? []
  };
}

function isTransientCloudCodeHealthReason(reason: string | undefined): boolean {
  return reason === "provider_error" ||
    reason === "network_error" ||
    reason === "timeout" ||
    reason === "http_404" ||
    reason === "http_500" ||
    reason === "http_502" ||
    reason === "http_503" ||
    reason === "http_504";
}

function reviveTransientCloudCodeHealth(account: CloudCodeAccount): CloudCodeAccount {
  if (account.disabled || account.health.healthy || !isTransientCloudCodeHealthReason(account.health.disabledReason)) {
    return account;
  }
  return {
    ...account,
    health: {
      healthy: true,
      consecutiveFailures: 0,
      lastSuccessAt: account.health.lastSuccessAt,
      lastFailureAt: account.health.lastFailureAt,
      disabledReason: undefined,
      nextRetryAt: undefined
    }
  };
}

export function createRuntime(config: ProxyConfig): Runtime {
  const importedAccounts = loadCloudCodeAccounts(config);
  const assetProvisioner = new AssetProvisioner(config);
  const registry = new SqliteAccountRegistry(join(config.dataDir, "accounts.sqlite"), config.cloudCode.tokenEncryptionKey);
  for (const account of importedAccounts) {
    registry.upsert(accountToStored(account));
  }
  const registryAccounts = registry
    .list(true)
    .map(storedToCloudCodeAccount)
    .filter((account): account is CloudCodeAccount => Boolean(account))
    .map(reviveTransientCloudCodeHealth)
    .filter((account) => !account.disabled);
  const accountMap = new Map<string, CloudCodeAccount>();
  for (const account of [...registryAccounts, ...importedAccounts]) {
    accountMap.set(account.id, account);
  }
  const persistAccount = (account: CloudCodeAccount) => {
    registry.upsert(accountToStored(account));
  };
  const cloudCodeAccounts = new CloudCodeAccountPool([...accountMap.values()], config, persistAccount);
  const tokenServer = new InternalTokenServer(
    config,
    (accountId) => cloudCodeAccounts.list().find((account) => account.id === accountId),
    persistAccount
  );
  const getAccount = (accountId: string) => cloudCodeAccounts.list().find((account) => account.id === accountId);
  const lsOrchestrator = new LsOrchestrator(config, assetProvisioner, tokenServer, getAccount);

  const runtime: Runtime = {
    config,
    geminiKeys: new ApiKeyPool(config.gemini.apiKeys, config.cloudCode.quarantineSeconds),
    anthropicKeys: new ApiKeyPool(config.anthropic.apiKeys, config.cloudCode.quarantineSeconds),
    openaiKeys: new ApiKeyPool(config.openai.apiKeys, config.cloudCode.quarantineSeconds),
    groqKeys: new ApiKeyPool(config.groq.apiKeys, config.cloudCode.quarantineSeconds),
    cerebrasKeys: new ApiKeyPool(config.cerebras.apiKeys, config.cloudCode.quarantineSeconds),
    ollamaKeys: new ApiKeyPool(config.ollama.apiKeys, config.cloudCode.quarantineSeconds),
    mistralKeys: new ApiKeyPool(config.mistral.apiKeys, config.cloudCode.quarantineSeconds),
    zaiKeys: new ApiKeyPool(config.zai.apiKeys, config.cloudCode.quarantineSeconds),
    cloudCodeAccounts,
    assetProvisioner,
    tokenServer,
    lsOrchestrator,
    nativeLsClient: new NativeLsClient(
      lsOrchestrator,
      (model) => cloudCodeAccounts.select(model),
      config.ls.requestTimeoutMs
    ),
    lsDiagnostics: undefined as unknown as LsDiagnostics,
    accountRegistry: registry,
    metrics: new Metrics(config.dataDir),
    activeAccountId: undefined,
    resolveModel(model) {
      const requested = model ?? config.gemini.defaultModel;
      if (config.modelAliases[requested]) {
        return config.modelAliases[requested];
      }
      if (requested === "claude-sonnet-4-5" && runtime.cloudCodeAccounts.list().some((account) =>
        account.quotaModels.some((quota) => quota.name === "claude-sonnet-4-6")
      )) {
        return "claude-sonnet-4-6";
      }
      if (requested.toLowerCase().includes("gemini")) {
        return canonicalGeminiModel(requested);
      }
      return requested;
    }
  };
  runtime.lsDiagnostics = new LsDiagnostics(runtime);
  return runtime;
}
