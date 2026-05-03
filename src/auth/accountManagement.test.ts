import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { baseTestConfig } from "../testConfig.js";

const tempDirs: string[] = [];

function config() {
  const dataDir = mkdtempSync(join(tmpdir(), "own-ag-account-mgmt-"));
  tempDirs.push(dataDir);
  return baseTestConfig({
    dataDir,
    localApiKey: "local-test-key",
    cloudCode: {
      enabled: true,
      accountsDir: join(dataDir, "missing"),
      tokenEncryptionKey: "test-encryption-key",
      oauthClientId: "client",
      oauthClientSecret: "secret"
    }
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("account management routes", () => {
  it("imports manual refresh tokens without exposing them", async () => {
    const app = buildServer(config());
    const response = await app.inject({
      method: "POST",
      url: "/auth/accounts/import/refresh-token",
      headers: { authorization: "Bearer local-test-key" },
      payload: { email: "person@example.test", refreshToken: "refresh-secret-token" }
    });
    const accounts = await app.inject({
      method: "GET",
      url: "/auth/accounts",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(response.statusCode).toBe(200);
    expect(accounts.body).not.toContain("refresh-secret-token");
    expect(accounts.json().accounts[0]).toMatchObject({ source: "manual_refresh_token", active: true });
    await app.close();
  });

  it("imports JSON accounts, switches active account, and exports encrypted rows", async () => {
    const app = buildServer(config());
    const imported = await app.inject({
      method: "POST",
      url: "/auth/accounts/import/json",
      headers: { authorization: "Bearer local-test-key" },
      payload: {
        id: "json-account",
        email: "json@example.test",
        token: {
          access_token: "access-secret-token",
          refresh_token: "refresh-secret-token",
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        }
      }
    });
    const switched = await app.inject({
      method: "POST",
      url: "/auth/accounts/switch/json-account",
      headers: { authorization: "Bearer local-test-key" }
    });
    const exported = await app.inject({
      method: "POST",
      url: "/auth/accounts/export",
      headers: { authorization: "Bearer local-test-key" },
      payload: { includeEncryptedSecrets: true }
    });

    expect(imported.statusCode).toBe(200);
    expect(imported.json().account).toMatchObject({ active: true });
    expect(switched.json()).toMatchObject({ activeAccountId: "json-account" });
    expect(exported.json()).toMatchObject({ encrypted: true });
    expect(exported.body).not.toContain("access-secret-token");
    expect(exported.body).not.toContain("refresh-secret-token");
    await app.close();
  });

  it("disables and re-enables accounts", async () => {
    const app = buildServer(config());
    await app.inject({
      method: "POST",
      url: "/auth/accounts/import/json",
      headers: { authorization: "Bearer local-test-key" },
      payload: {
        id: "json-account",
        email: "json@example.test",
        token: {
          access_token: "access-secret-token",
          refresh_token: "refresh-secret-token",
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        }
      }
    });

    const disabled = await app.inject({
      method: "POST",
      url: "/auth/accounts/disable/json-account",
      headers: { authorization: "Bearer local-test-key" }
    });
    const switchBlocked = await app.inject({
      method: "POST",
      url: "/auth/accounts/switch/json-account",
      headers: { authorization: "Bearer local-test-key" }
    });
    const enabled = await app.inject({
      method: "POST",
      url: "/auth/accounts/enable/json-account",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().account).toMatchObject({ disabled: true, status: "disabled" });
    expect(switchBlocked.statusCode).toBe(409);
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().account).toMatchObject({ disabled: false, status: "active" });
    await app.close();
  });

  it("includes diagnosis data in public account payloads", async () => {
    const app = buildServer(config());
    await app.inject({
      method: "POST",
      url: "/auth/accounts/import/json",
      headers: { authorization: "Bearer local-test-key" },
      payload: {
        id: "expired-json-account",
        email: "expired@example.test",
        token: {
          access_token: "access-secret-token",
          refresh_token: "refresh-secret-token",
          expiry_timestamp: Math.floor(Date.now() / 1000) - 3600
        }
      }
    });

    const accounts = await app.inject({
      method: "GET",
      url: "/auth/accounts",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(accounts.statusCode).toBe(200);
    expect(accounts.json().accounts[0].diagnosis).toMatchObject({
      isProblem: true,
      kind: "auth_expired"
    });
    await app.close();
  });

  it("can disable broken accounts in batch while preserving their root cause", async () => {
    const app = buildServer(config());
    await app.inject({
      method: "POST",
      url: "/auth/accounts/import/json",
      headers: { authorization: "Bearer local-test-key" },
      payload: {
        id: "broken-json-account",
        email: "broken@example.test",
        token: {
          access_token: "access-secret-token",
          refresh_token: "refresh-secret-token",
          expiry_timestamp: Math.floor(Date.now() / 1000) - 3600
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/accounts/disable-broken",
      headers: { authorization: "Bearer local-test-key" }
    });
    const accounts = await app.inject({
      method: "GET",
      url: "/auth/accounts",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ disabledCount: 1 });
    expect(accounts.json().accounts[0]).toMatchObject({
      disabled: true,
      diagnosis: {
        kind: "manual_disabled"
      }
    });
    expect(accounts.json().accounts[0].health.disabledReason).toBe("manual:auth_error");
    await app.close();
  });

  it("enables all accounts, checks them, and re-disables only broken ones with diagnosis", async () => {
    const app = buildServer(config());
    await app.inject({
      method: "POST",
      url: "/auth/accounts/import/json",
      headers: { authorization: "Bearer local-test-key" },
      payload: {
        id: "broken-json-account",
        email: "broken@example.test",
        token: {
          access_token: "access-secret-token",
          refresh_token: "refresh-secret-token",
          expiry_timestamp: Math.floor(Date.now() / 1000) - 3600
        }
      }
    });
    await app.inject({
      method: "POST",
      url: "/auth/accounts/disable/broken-json-account",
      headers: { authorization: "Bearer local-test-key" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/accounts/check-all",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      checkedCount: 1,
      disabledCount: 1,
      results: [
        {
          accountId: "broken-json-account",
          disabled: true,
          diagnosisBeforeDisable: {
            kind: "auth_expired",
            recommendation: "Bu hesabı devre dışı bırak ve yeniden yetkilendir."
          },
          account: {
            disabled: true,
            diagnosis: {
              kind: "manual_disabled"
            }
          }
        }
      ]
    });
    expect(response.json().results[0].account.diagnosis.reason).toContain("Access token süresi geçmiş");
    await app.close();
  });

  it("rejects non-loopback CORS origins", async () => {
    const app = buildServer(config());
    const response = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { origin: "https://evil.example.test", authorization: "Bearer local-test-key" }
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
