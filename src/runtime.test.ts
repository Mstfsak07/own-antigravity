import { describe, expect, it } from "vitest";
import { createRuntime } from "./runtime.js";
import { baseTestConfig } from "./testConfig.js";
import { SqliteAccountRegistry } from "./accounts/sqliteRegistry.js";
import { defaultModelAliases } from "./config.js";

describe("runtime model aliases", () => {
  it("routes older Claude Sonnet and Haiku names to supported CloudCode models", () => {
    const runtime = createRuntime(baseTestConfig({
      modelAliases: defaultModelAliases
    }));

    expect(runtime.resolveModel("claude-3-5-sonnet-20241022")).toBe("claude-sonnet-4-6");
    expect(runtime.resolveModel("claude-3.5-sonnet")).toBe("claude-sonnet-4-6");
    expect(runtime.resolveModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-6");
    expect(runtime.resolveModel("claude-3-5-haiku-20241022")).toBe("claude-haiku-4-5");
    expect(runtime.resolveModel("claude-3.5-haiku")).toBe("claude-haiku-4-5");

    runtime.accountRegistry.close();
  });
});

describe("runtime cloudCode health revival", () => {
  it("revives transient persisted cloudCode failures on startup", () => {
    const config = baseTestConfig({
      cloudCode: {
        enabled: true
      }
    });
    const registry = new SqliteAccountRegistry(`${config.dataDir}/accounts.sqlite`, config.cloudCode.tokenEncryptionKey);
    registry.upsert({
      id: "acc-1",
      email: "a@example.test",
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      projectId: "project-1",
      supportedModels: ["gemini-3.1-flash-image"],
      quota: [{ name: "gemini-3.1-flash-image", percentage: 100 }],
      status: "active",
      source: "oauth_login",
      health: {
        healthy: false,
        consecutiveFailures: 1,
        disabledReason: "http_500",
        nextRetryAt: new Date(Date.now() + 300_000).toISOString()
      }
    });
    registry.close();

    const runtime = createRuntime(config);
    const account = runtime.cloudCodeAccounts.list().find((item) => item.id === "acc-1");

    expect(account?.health.healthy).toBe(true);
    expect(account?.health.disabledReason).toBeUndefined();
    expect(account?.health.nextRetryAt).toBeUndefined();
    runtime.accountRegistry.close();
  });

  it("keeps rate-limited accounts quarantined across restarts", () => {
    const config = baseTestConfig({
      cloudCode: {
        enabled: true
      }
    });
    const registry = new SqliteAccountRegistry(`${config.dataDir}/accounts.sqlite`, config.cloudCode.tokenEncryptionKey);
    registry.upsert({
      id: "acc-2",
      email: "b@example.test",
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      projectId: "project-1",
      supportedModels: ["gemini-3.1-flash-image"],
      quota: [{ name: "gemini-3.1-flash-image", percentage: 100 }],
      status: "active",
      source: "oauth_login",
      health: {
        healthy: false,
        consecutiveFailures: 1,
        disabledReason: "http_429",
        nextRetryAt: new Date(Date.now() + 300_000).toISOString()
      }
    });
    registry.close();

    const runtime = createRuntime(config);
    const account = runtime.cloudCodeAccounts.list().find((item) => item.id === "acc-2");

    expect(account?.health.healthy).toBe(false);
    expect(account?.health.disabledReason).toBe("http_429");
    expect(account?.health.nextRetryAt).toBeTruthy();
    runtime.accountRegistry.close();
  });
});
