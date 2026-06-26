import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { baseTestConfig } from "./testConfig.js";
import type { ProxyConfig } from "./types.js";

function testConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return baseTestConfig({
    modelAliases: {
      "gpt-4o": "gemini-2.5-pro"
    },
    ...overrides
  });
}

describe("server", () => {
  it("allows health without local auth", async () => {
    const app = buildServer(testConfig());
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("handles missing .env/provider keys gracefully", async () => {
    const app = buildServer(
      testConfig({
        localApiKey: undefined,
        gemini: {
          apiKeys: [],
          baseUrl: "https://generativelanguage.googleapis.com",
          defaultModel: "gemini-2.5-pro"
        },
        anthropic: {
          apiKeys: [],
          baseUrl: "https://api.anthropic.com",
          version: "2023-06-01"
        }
      })
    );
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providers: { gemini: false, anthropic: false }
    });
  });

  it("requires the local proxy key when configured", async () => {
    const app = buildServer(testConfig());
    const response = await app.inject({ method: "GET", url: "/v1/models" });

    expect(response.statusCode).toBe(401);
  });

  it("accepts bearer auth for protected routes", async () => {
    const app = buildServer(testConfig());
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ object: "list" });
  });

  it("allows chrome extension origins with local auth", async () => {
    const app = buildServer(testConfig());
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authorization: "Bearer local-test-key"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("allows any chrome extension origin with local auth", async () => {
    const app = buildServer(testConfig());
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        origin: "chrome-extension://some-nonstandard-extension-id",
        authorization: "Bearer local-test-key"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("chrome-extension://some-nonstandard-extension-id");
  });

  it("returns redacted admin status", async () => {
    const app = buildServer(testConfig());
    const response = await app.inject({
      method: "GET",
      url: "/admin/status",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      localApiKey: "loca...-key",
      providers: {
        gemini: { keyCount: 1, active: true },
        anthropic: { keyCount: 1, active: true },
        cloudCode: { accountCount: 0, active: false }
      }
    });
  });

  it("returns admin metrics", async () => {
    const app = buildServer(testConfig());
    await app.inject({ method: "GET", url: "/health" });
    const response = await app.inject({
      method: "GET",
      url: "/admin/metrics",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totalRequests: 1
    });
  });

  it("protects and serves admin shutdown", async () => {
    const app = buildServer(testConfig());
    const unauthorized = await app.inject({
      method: "POST",
      url: "/admin/shutdown",
      payload: {}
    });
    const authorized = await app.inject({
      method: "POST",
      url: "/admin/shutdown",
      headers: { authorization: "Bearer local-test-key" },
      payload: {}
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({ ok: true, shuttingDown: true });
  });

  it("does not expose admin shutdown when local auth is disabled", async () => {
    const app = buildServer(
      testConfig({
        localApiKey: undefined
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/admin/shutdown",
      payload: {}
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose provider secrets in health output", async () => {
    const app = buildServer(testConfig());
    const response = await app.inject({
      method: "GET",
      url: "/health/providers",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).not.toContain("provider-test-key");
    expect(body).not.toContain("anthropic-test-key");
    expect(response.json()).toMatchObject({
      gemini: { keys: [{ id: "key-1" }] },
      anthropic: { keys: [{ id: "key-1" }] }
    });
  });

  it("does not expose local or provider secrets in health output", async () => {
    const app = buildServer(testConfig());
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("local-test-key");
    expect(response.body).not.toContain("provider-test-key");
    expect(response.body).not.toContain("anthropic-test-key");
  });

  it("returns protocol status without secrets", async () => {
    const app = buildServer(testConfig());
    const response = await app.inject({
      method: "GET",
      url: "/v1/protocol/status",
      headers: { authorization: "Bearer local-test-key" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("provider-test-key");
    expect(response.json()).toMatchObject({
      configured: { active: "stdio" },
      instances: []
    });
  });
});
