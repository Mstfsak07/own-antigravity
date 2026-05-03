import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyConfig } from "./types.js";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function baseTestConfig(overrides: DeepPartial<ProxyConfig> = {}): ProxyConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "own-ag-test-"));
  const config: ProxyConfig = {
    host: "127.0.0.1",
    port: 0,
    localApiKey: "local-test-key",
    dataDir,
    modelAliases: {},
    ls: {
      enabled: true,
      nativeEnabled: false,
      providerFallback: true,
      binDir: join(dataDir, "bin"),
      provisionMode: "Auto",
      instanceTtlSeconds: 1800,
      maxInstances: 3,
      requestTimeoutMs: 30000,
      transport: "stdio",
      initMethod: "initialize",
      requestMethod: "request",
      streamMethod: "stream",
      extraArgs: [],
      tokenServerHost: "127.0.0.1",
      tokenServerPort: 0
    },
    cloudCode: {
      enabled: false,
      accountsDir: "missing",
      baseUrls: ["https://cloudcode-pa.googleapis.com/v1internal"],
      userAgent: "test",
      sendUserProjectHeader: false,
      preserveAvailabilityOnError: true,
      refreshSkewSeconds: 120,
      quarantineSeconds: 300,
      oauthEnabled: false,
      oauthRedirectUri: "http://127.0.0.1:8046/auth/google/callback",
      oauthScopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/cloud-platform"],
      oauthAuthorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      oauthUserInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      tokenEncryptionKey: "test-encryption-key",
      tokenUrl: "https://oauth2.googleapis.com/token"
    },
    gemini: {
      apiKey: "provider-test-key",
      apiKeys: ["provider-test-key"],
      baseUrl: "https://generativelanguage.googleapis.com",
      defaultModel: "gemini-2.5-pro"
    },
    anthropic: {
      apiKey: "anthropic-test-key",
      apiKeys: ["anthropic-test-key"],
      baseUrl: "https://api.anthropic.com",
      version: "2023-06-01"
    },
    zai: {
      enabled: false,
      apiKey: "zai-test-key",
      apiKeys: ["zai-test-key"],
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

  return {
    ...config,
    ...overrides,
    ls: { ...config.ls, ...overrides.ls },
    cloudCode: { ...config.cloudCode, ...overrides.cloudCode },
    gemini: { ...config.gemini, ...overrides.gemini },
    anthropic: { ...config.anthropic, ...overrides.anthropic },
    zai: { ...config.zai, ...overrides.zai },
    mcp: { ...config.mcp, ...overrides.mcp }
  } as ProxyConfig;
}
