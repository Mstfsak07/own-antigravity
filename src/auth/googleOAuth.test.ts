import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteAccountRegistry } from "../accounts/sqliteRegistry.js";
import { createRuntime } from "../runtime.js";
import { buildServer } from "../server.js";
import { baseTestConfig } from "../testConfig.js";
import type { ProxyConfig } from "../types.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-oauth-"));
  tempDirs.push(dir);
  return dir;
}

function oauthConfig(overrides: Partial<ProxyConfig["cloudCode"]> = {}): ProxyConfig {
  const dataDir = makeDir();
  return baseTestConfig({
    dataDir,
    localApiKey: "local-test-key",
    cloudCode: {
      enabled: true,
      accountsDir: join(dataDir, "missing-json"),
      oauthEnabled: true,
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      oauthRedirectUri: "http://127.0.0.1:8046/auth/google/callback",
      oauthScopes: ["openid", "email", "profile"],
      oauthAuthorizationUrl: "https://accounts.example.test/o/oauth2/v2/auth",
      oauthUserInfoUrl: "https://openid.example.test/userinfo",
      tokenEncryptionKey: "encryption-key",
      tokenUrl: "https://oauth.example.test/token",
      ...overrides
    }
  });
}

function stateFrom(location: string): string {
  return new URL(location).searchParams.get("state")!;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Google OAuth routes", () => {
  it("start creates state and PKCE authorization URL", async () => {
    const app = buildServer(oauthConfig());
    const response = await app.inject({
      method: "GET",
      url: "/auth/google/start",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers.location as string;
    const url = new URL(location);
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    await app.close();
  });

  it("callback rejects invalid state", async () => {
    const app = buildServer(oauthConfig());
    const response = await app.inject({
      method: "GET",
      url: "/auth/google/callback?code=abc&state=invalid"
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Invalid or expired OAuth state");
    await app.close();
  });

  it("callback exchanges code, encrypts tokens, saves userinfo, and never returns tokens", async () => {
    const config = oauthConfig();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input) === "https://oauth.example.test/token") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "access-secret",
              refresh_token: "refresh-secret",
              expires_in: 3600,
              scope: "openid email profile"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
      if (String(input) === "https://openid.example.test/userinfo") {
        return Promise.resolve(
          new Response(JSON.stringify({ email: "person@example.test", name: "Person Example", sub: "sub-1" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }
      if (String(input) === "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist") {
        return Promise.resolve(
          new Response(JSON.stringify({ cloudaicompanionProject: "project-1" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }
      if (String(input).includes("fetchAvailableModels")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              models: {
                "gemini-2.5-pro": {
                  displayName: "Gemini 2.5 Pro",
                  quotaInfo: { remainingFraction: 0.82, resetTime: "2026-04-27T00:00:00Z" }
                }
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
    });
    const app = buildServer(config);
    const start = await app.inject({
      method: "GET",
      url: "/auth/google/start",
      headers: { authorization: "Bearer local-test-key" }
    });
    const state = stateFrom(start.headers.location as string);
    const callback = await app.inject({
      method: "GET",
      url: `/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`
    });
    const accounts = await app.inject({
      method: "GET",
      url: "/auth/accounts",
      headers: { authorization: "Bearer local-test-key" }
    });
    const registry = new SqliteAccountRegistry(join(config.dataDir, "accounts.sqlite"), config.cloudCode.tokenEncryptionKey);
    const rows = registry.rawRows();

    expect(callback.statusCode).toBe(200);
    expect(accounts.json().accounts[0]).toMatchObject({
      email: "person@example.test",
      displayName: "Person Example",
      source: "oauth_login",
      scopes: ["openid", "email", "profile"],
      active: true,
      quota: [
        expect.objectContaining({
          name: "gemini-2.5-pro",
          percentage: 82
        })
      ]
    });
    expect(callback.body).toContain("Account active");
    expect(accounts.body).not.toContain("access-secret");
    expect(accounts.body).not.toContain("refresh-secret");
    expect(JSON.stringify(rows)).not.toContain("access-secret");
    expect(JSON.stringify(rows)).not.toContain("refresh-secret");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    registry.close();
    await app.close();
  });

  it("rejects callback when Google omits refresh token", async () => {
    const app = buildServer(oauthConfig());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-secret", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const start = await app.inject({
      method: "GET",
      url: "/auth/google/start",
      headers: { authorization: "Bearer local-test-key" }
    });
    const response = await app.inject({
      method: "GET",
      url: `/auth/google/callback?code=auth-code&state=${stateFrom(start.headers.location as string)}`
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("refresh token");
    await app.close();
  });

  it("refreshes encrypted OAuth registry accounts", async () => {
    const config = oauthConfig();
    const registry = new SqliteAccountRegistry(join(config.dataDir, "accounts.sqlite"), config.cloudCode.tokenEncryptionKey);
    registry.upsert({
      id: "oauth-test",
      email: "person@example.test",
      accessToken: "old-access",
      refreshToken: "encrypted-refresh",
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      supportedModels: [],
      scopes: ["openid"],
      source: "oauth_login",
      health: { healthy: true, consecutiveFailures: 0 }
    });
    registry.close();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const runtime = createRuntime(config);
    const selected = await runtime.cloudCodeAccounts.select("gemini-2.5-pro");
    const updatedRegistry = new SqliteAccountRegistry(join(config.dataDir, "accounts.sqlite"), config.cloudCode.tokenEncryptionKey);
    const rows = updatedRegistry.rawRows();

    expect(selected?.accessToken).toBe("new-access");
    expect(JSON.stringify(rows)).not.toContain("new-access");
    expect(runtime.accountRegistry.list(true)[0].accessToken).toBe("new-access");
    updatedRegistry.close();
    runtime.accountRegistry.close();
  });

  it("logout removes account", async () => {
    const config = oauthConfig();
    const registry = new SqliteAccountRegistry(join(config.dataDir, "accounts.sqlite"), config.cloudCode.tokenEncryptionKey);
    registry.upsert({
      id: "oauth-test",
      email: "person@example.test",
      accessToken: "access",
      refreshToken: "refresh",
      supportedModels: [],
      source: "oauth_login",
      health: { healthy: true, consecutiveFailures: 0 }
    });
    registry.close();
    const app = buildServer(config);
    const response = await app.inject({
      method: "POST",
      url: "/auth/google/logout/oauth-test",
      headers: { authorization: "Bearer local-test-key" }
    });
    const accounts = await app.inject({
      method: "GET",
      url: "/auth/accounts",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(response.statusCode).toBe(200);
    expect(accounts.json().accounts).toHaveLength(0);
    await app.close();
  });

  it("keeps imported JSON accounts available with source metadata", async () => {
    const dataDir = makeDir();
    const accountsDir = join(dataDir, "json-accounts");
    rmSync(accountsDir, { recursive: true, force: true });
    writeFileSync(
      join(dataDir, "placeholder"),
      "",
      "utf8"
    );
    rmSync(join(dataDir, "placeholder"), { force: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(
      join(accountsDir, "legacy.json"),
      JSON.stringify({
        id: "legacy",
        email: "legacy@example.test",
        token: {
          access_token: "legacy-access",
          refresh_token: "legacy-refresh",
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        }
      }),
      "utf8"
    );
    const app = buildServer(
      oauthConfig({
        accountsDir
      })
    );
    const response = await app.inject({
      method: "GET",
      url: "/auth/accounts",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(response.json().accounts[0]).toMatchObject({
      accountId: "legacy",
      email: "legacy@example.test",
      source: "imported_json"
    });
    expect(response.body).not.toContain("legacy-access");
    expect(response.body).not.toContain("legacy-refresh");
    await app.close();
  });
});
