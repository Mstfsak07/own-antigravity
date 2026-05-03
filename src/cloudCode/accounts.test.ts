import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudCodeAccountPool, loadCloudCodeAccounts, resolveCloudCodeModelForAccount } from "./accounts.js";
import type { ProxyConfig } from "../types.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-accounts-"));
  tempDirs.push(dir);
  return dir;
}

function config(accountsDir: string, overrides: Partial<ProxyConfig["cloudCode"]> = {}): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: makeDir(),
    modelAliases: {},
    ls: {
      enabled: true,
      nativeEnabled: false,
      providerFallback: true,
      binDir: join(accountsDir, "bin"),
      provisionMode: "Auto",
      instanceTtlSeconds: 1800,
      maxInstances: 3,
      requestTimeoutMs: 30000,
      transport: "stdio",
      extraArgs: [],
      tokenServerHost: "127.0.0.1",
      tokenServerPort: 0
    },
    cloudCode: {
      enabled: true,
      accountsDir,
      baseUrls: ["https://cloudcode-pa.googleapis.com/v1internal"],
      userAgent: "test",
      sendUserProjectHeader: false,
      preserveAvailabilityOnError: true,
      refreshSkewSeconds: 120,
      quarantineSeconds: 300,
      oauthEnabled: false,
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      oauthRedirectUri: "http://127.0.0.1:8046/auth/google/callback",
      oauthScopes: ["openid", "email", "profile"],
      oauthAuthorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      oauthUserInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      tokenEncryptionKey: "test-encryption-key",
      tokenUrl: "https://oauth.example.test/token",
      ...overrides
    },
    gemini: {
      apiKeys: [],
      baseUrl: "https://generativelanguage.googleapis.com",
      defaultModel: "gemini-2.5-pro"
    },
    anthropic: {
      apiKeys: [],
      baseUrl: "https://api.anthropic.com",
      version: "2023-06-01"
    },
    zai: {
      enabled: false,
      apiKeys: [],
      baseUrl: "https://api.z.ai/api/paas/v4",
      defaultModel: "glm-4.6"
    },
    mcp: {
      enabled: false,
      exposeViaProxy: true,
      requestTimeoutMs: 45000,
      servers: []
    }
  };
}

function writeAccount(dir: string, id: string, expiresAt: number, model = "claude-sonnet-4-5"): void {
  writeFileSync(
    join(dir, `${id}.json`),
    `${JSON.stringify(
      {
        id,
        email: `${id}@example.test`,
        token: {
          access_token: `old-access-${id}`,
          refresh_token: `refresh-${id}`,
          expiry_timestamp: expiresAt,
          project_id: `project-${id}`
        },
        quota: {
          models: [{ name: model, percentage: 100 }]
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CloudCodeAccountPool", () => {
  it("refreshes expired access tokens and updates the account file", async () => {
    const dir = makeDir();
    writeAccount(dir, "acct-1", Math.floor(Date.now() / 1000) - 60);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    const selected = await pool.select("claude-sonnet-4-5");
    const updated = JSON.parse(readFileSync(join(dir, "acct-1.json"), "utf8"));

    expect(selected?.accessToken).toBe("new-access");
    expect(updated.token.access_token).toBe("new-access");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(pool.healthyCount()).toBe(1);
  });

  it("quarantines accounts after refresh failures by default without disabling them", async () => {
    const dir = makeDir();
    writeAccount(dir, "acct-1", Math.floor(Date.now() / 1000) - 60);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      })
    );

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    const selected = await pool.select("claude-sonnet-4-5");
    const account = pool.list()[0];

    expect(selected).toBeUndefined();
    expect(account.health).toMatchObject({
      healthy: false,
      consecutiveFailures: 1,
      disabledReason: "auth_error"
    });
    expect(account.health.nextRetryAt).toBeTruthy();
    expect(account.disabled).toBe(false);
  });

  it("can reselect an account after its retry window passes when availability preservation is enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "account", future);

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    pool.reportFailure("account", "auth_error");

    expect(await pool.select("claude-sonnet-4-5")).toBeUndefined();

    vi.advanceTimersByTime(30 * 60 * 1000 + 1000);
    const selected = await pool.select("claude-sonnet-4-5");

    expect(selected?.id).toBe("account");
    vi.useRealTimers();
  });

  it("ignores accounts still inside a quarantine window when preservation is disabled", async () => {
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "quarantined", future);
    writeAccount(dir, "available", future);

    const cfg = config(dir, { preserveAvailabilityOnError: false });
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    const quarantined = pool.list().find((account) => account.id === "quarantined")!;
    quarantined.health = {
      healthy: false,
      consecutiveFailures: 2,
      disabledReason: "rate_limit",
      nextRetryAt: new Date(Date.now() + 60_000).toISOString()
    };

    const selected = await pool.select("claude-sonnet-4-5");

    expect(selected?.id).toBe("available");
  });

  it("prefers the account with the strongest exact model quota match", async () => {
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "generic", future);
    writeAccount(dir, "exact", future);

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    const generic = pool.list().find((account) => account.id === "generic")!;
    const exact = pool.list().find((account) => account.id === "exact")!;

    generic.quotaModels = [{ name: "claude-sonnet", percentage: 100 }];
    exact.quotaModels = [{ name: "claude-sonnet-4-6", percentage: 80 }];

    const selected = await pool.select("claude-sonnet-4-6");

    expect(selected?.id).toBe("exact");
  });

  it("selects another suitable account when the first one is excluded for failover", async () => {
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "primary", future);
    writeAccount(dir, "secondary", future);

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    const primary = pool.list().find((account) => account.id === "primary")!;
    const secondary = pool.list().find((account) => account.id === "secondary")!;

    primary.quotaModels = [{ name: "claude-sonnet-4-6", percentage: 100 }];
    secondary.quotaModels = [{ name: "claude-sonnet-4-6", percentage: 90 }];

    const selected = await pool.select("claude-sonnet-4-6", { excludeIds: ["primary"] });

    expect(selected?.id).toBe("secondary");
  });

  it("records upstream errors by quarantining the account without disabling it by default", async () => {
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "limited", future);

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    const account = pool.list()[0]!;

    pool.reportStatusFailure(account.id, 429);

    expect(account.disabled).toBe(false);
    expect(account.health).toMatchObject({
      healthy: false,
      disabledReason: "http_429"
    });
    expect(account.health.nextRetryAt).toBeTruthy();
  });

  it("can still auto-disable an account when preservation is explicitly disabled", async () => {
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "limited", future);

    const cfg = config(dir, { preserveAvailabilityOnError: false });
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    const account = pool.list()[0]!;

    pool.reportStatusFailure(account.id, 429);

    expect(account.disabled).toBe(true);
    expect(account.health).toMatchObject({
      healthy: false,
      disabledReason: "http_429"
    });
  });

  it("resolves compatible Gemini family variants per account without affecting Claude models", async () => {
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "gemini", future, "gemini-3.1-flash-lite");
    writeAccount(dir, "claude", future, "claude-sonnet-4-6");

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    const gemini = pool.list().find((account) => account.id === "gemini")!;
    const claude = pool.list().find((account) => account.id === "claude")!;

    expect(resolveCloudCodeModelForAccount(gemini, "gemini-2.5-flash-lite")).toBe("gemini-3.1-flash-lite");
    expect(resolveCloudCodeModelForAccount(gemini, "gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(resolveCloudCodeModelForAccount(claude, "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("selects a Cloud Code account when Haiku quota is available", async () => {
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "haiku", future, "claude-haiku-4-5");

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    const selected = await pool.select("claude-haiku-4-5");

    expect(selected?.id).toBe("haiku");
    expect(resolveCloudCodeModelForAccount(selected!, "claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("falls back from Haiku to Sonnet when the account does not expose Haiku", async () => {
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "sonnet", future, "claude-sonnet-4-6");

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    const selected = await pool.select("claude-haiku-4-5");

    expect(selected?.id).toBe("sonnet");
    expect(resolveCloudCodeModelForAccount(selected!, "claude-haiku-4-5")).toBe("claude-sonnet-4-6");
  });

  it("maps Opus 4.6 to the available thinking variant", async () => {
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "opus", future, "claude-opus-4-6-thinking");

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    const selected = await pool.select("claude-opus-4-6");

    expect(selected?.id).toBe("opus");
    expect(resolveCloudCodeModelForAccount(selected!, "claude-opus-4-6")).toBe("claude-opus-4-6-thinking");
  });

  it("prefers another account for the same Gemini model after a model-specific failure", async () => {
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "first", future, "gemini-3.1-flash-lite");
    writeAccount(dir, "second", future, "gemini-3.1-flash-lite");

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    pool.noteModelFailure("first", "gemini-3.1-flash-lite", 500);

    const selected = await pool.select("gemini-3.1-flash-lite");

    expect(selected?.id).toBe("second");
  });

  it("still prefers the healthier account after cooldown expires for the same model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00.000Z"));
    const dir = makeDir();
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(dir, "first", future, "gemini-3.1-pro-high");
    writeAccount(dir, "second", future, "gemini-3.1-pro-high");

    const cfg = config(dir);
    const pool = new CloudCodeAccountPool(loadCloudCodeAccounts(cfg), cfg);
    pool.noteModelFailure("first", "gemini-3.1-pro-high", 500);

    vi.advanceTimersByTime(31_000);
    const selected = await pool.select("gemini-3.1-pro-high");

    expect(selected?.id).toBe("second");
    vi.useRealTimers();
  });
});
