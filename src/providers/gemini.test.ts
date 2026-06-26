import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import { baseTestConfig } from "../testConfig.js";
import type { ProxyConfig } from "../types.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-gemini-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function config(overrides: Parameters<typeof baseTestConfig>[0] = {}): ProxyConfig {
  return baseTestConfig({
    localApiKey: "local",
    modelAliases: {
      "gpt-4o": "gemini-2.5-flash"
    },
    gemini: {
      apiKey: "provider",
      apiKeys: ["provider"],
      baseUrl: "https://generativelanguage.googleapis.com",
      defaultModel: "gemini-2.5-pro"
    },
    anthropic: {
      apiKey: "anthropic",
      apiKeys: ["anthropic"],
      baseUrl: "https://api.anthropic.com",
      version: "2023-06-01"
    },
    ...overrides
  });
}

describe("gemini proxy", () => {
  it("maps model aliases and replaces local auth key with provider key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const app = buildServer(config());
    const response = await app.inject({
      method: "POST",
      url: "/v1beta/models/gpt-4o:generateContent?key=local",
      payload: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }]
      }
    });

    expect(response.statusCode).toBe(200);
    const upstreamUrl = fetchMock.mock.calls[0][0] as URL;
    expect(upstreamUrl.toString()).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(upstreamUrl.searchParams.get("key")).toBe("provider");
  });

  it("normalizes latest Gemini alias requests to stable upstream ids", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const app = buildServer(config());
    const response = await app.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.5-flash-latest:generateContent?key=local",
      payload: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }]
      }
    });

    expect(response.statusCode).toBe(200);
    const upstreamUrl = fetchMock.mock.calls[0][0] as URL;
    expect(upstreamUrl.toString()).toContain("/v1beta/models/gemini-3-flash:generateContent");
  });

  it("quarantines failed provider keys", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad key" } }), {
        status: 401,
        headers: { "content-type": "application/json" }
      })
    );

    const app = buildServer(config());
    const response = await app.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.5-pro:generateContent?key=local",
      payload: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }]
      }
    });
    const health = await app.inject({
      method: "GET",
      url: "/health/providers",
      headers: { authorization: "Bearer local" }
    });

    expect(response.statusCode).toBe(401);
    expect(health.json().gemini.keys[0]).toMatchObject({
      healthy: false,
      consecutiveFailures: 1,
      disabledReason: "auth_error"
    });
  });

  it("sets fallback header when native LS fails and provider fallback is enabled", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const app = buildServer(
      config({
        ls: { nativeEnabled: true, providerFallback: true, lsCorePath: "missing-ls-core" }
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.5-pro:generateContent?key=local",
      payload: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-own-ag-fallback"]).toBe("provider");
    expect(response.headers["x-own-ag-native-error"]).toBe("LsCoreMissing");
  });

  it("records provider adapter metrics for routed requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const app = buildServer(config());

    await app.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.5-pro:generateContent?key=local",
      payload: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }]
      }
    });
    const metrics = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer local" }
    });

    expect(metrics.json()).toMatchObject({
      activeProvider: "gemini",
      providerRequests: { gemini: 1 },
      providerErrors: { gemini: 0 }
    });
  });

  it("rotates cloud code Gemini requests to another account after a retryable upstream failure", async () => {
    const dir = makeDir();
    const accountsDir = join(dir, "accounts");
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(
      join(accountsDir, "account-a.json"),
      JSON.stringify({
        id: "cloud-a",
        email: "a@example.test",
        projectId: "proj-test",
        token: {
          access_token: "token-a",
          refresh_token: "refresh-a",
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        },
        quota: {
          models: [{ name: "gemini-2.5-pro", percentage: 100 }]
        }
      }),
      "utf8"
    );
    writeFileSync(
      join(accountsDir, "account-b.json"),
      JSON.stringify({
        id: "cloud-b",
        email: "b@example.test",
        token: {
          access_token: "token-b",
          refresh_token: "refresh-b",
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        },
        quota: {
          models: [{ name: "gemini-2.5-pro", percentage: 100 }]
        }
      }),
      "utf8"
    );

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization");
      if (auth === "Bearer token-a") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "internal" } }), {
            status: 500,
            headers: { "content-type": "application/json" }
          })
        );
      }
      if (auth === "Bearer token-b") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              response: {
                candidates: [
                  {
                    content: { role: "model", parts: [{ text: "rotated gemini" }] },
                    finishReason: "STOP"
                  }
                ],
                usageMetadata: {
                  promptTokenCount: 1,
                  candidatesTokenCount: 2,
                  totalTokenCount: 3
                }
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.reject(new Error(`unexpected auth ${auth}`));
    });

    const app = buildServer(
      config({
        cloudCode: { enabled: true, accountsDir },
        gemini: { apiKey: "", apiKeys: [] }
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.5-pro:generateContent?key=local",
      payload: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().candidates[0].content.parts[0].text).toBe("rotated gemini");
  });

  it.skip("re-emits Cloud Code Gemini stream chunks as SSE frames", async () => {
    const dir = makeDir();
    const accountsDir = join(dir, "accounts");
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(
      join(accountsDir, "account-a.json"),
      JSON.stringify({
        id: "cloud-a",
        email: "a@example.test",
        token: {
          access_token: "token-a",
          refresh_token: "refresh-a",
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        },
        quota: {
          models: [{ name: "gemini-3.1-pro-high", percentage: 100 }]
        }
      }),
      "utf8"
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            response: {
              candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] } }]
            }
          },
          {
            response: {
              candidates: [{ content: { role: "model", parts: [{ text: " world" }] } }]
            }
          },
          {
            response: {
              candidates: [{ content: { role: "model", parts: [{ thoughtSignature: "sig", text: "" }] }, finishReason: "STOP" }]
            }
          }
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const app = buildServer(
      config({
        cloudCode: { enabled: true, accountsDir },
        gemini: { apiKey: "", apiKeys: [] }
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1beta/models/gemini-3.1-pro-high:streamGenerateContent?alt=sse",
      headers: {
        authorization: "Bearer local"
      },
      payload: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"text":"Hello"');
    expect(response.body).toContain('"text":" world"');
    expect(response.body).not.toContain('"text":""');
  });
});
