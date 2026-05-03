import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import { baseTestConfig } from "../testConfig.js";
import type { ProxyConfig } from "../types.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-anthropic-"));
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
    localApiKey: undefined,
    modelAliases: {
      claude: "claude-sonnet-4-5"
    },
    gemini: {
      apiKey: "gemini",
      apiKeys: ["gemini"],
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

describe("anthropic proxy", () => {
  it("maps configured model aliases before forwarding", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_test" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const app = buildServer(config());
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).model).toBe("claude-sonnet-4-5");

    fetchMock.mockRestore();
  });

  it("maps Claude Haiku aliases before forwarding", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_test" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const app = buildServer(config({
      modelAliases: {
        claude: "claude-sonnet-4-5",
        "claude-haiku": "claude-haiku-4-5"
      }
    }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-haiku",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).model).toBe("claude-haiku-4-5");

    fetchMock.mockRestore();
  });

  it("retries Claude Cloud Code requests across multiple accounts until one succeeds", async () => {
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
          models: [{ name: "claude-sonnet-4-6", percentage: 100 }]
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
          models: [{ name: "claude-sonnet-4-6", percentage: 100 }]
        }
      }),
      "utf8"
    );
    writeFileSync(
      join(accountsDir, "account-c.json"),
      JSON.stringify({
        id: "cloud-c",
        email: "c@example.test",
        token: {
          access_token: "token-c",
          refresh_token: "refresh-c",
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        },
        quota: {
          models: [{ name: "claude-sonnet-4-6", percentage: 100 }]
        }
      }),
      "utf8"
    );

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === "Bearer token-a" || auth === "Bearer token-b") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "internal" } }), {
            status: 500,
            headers: { "content-type": "application/json" }
          })
        );
      }
      if (auth === "Bearer token-c") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              response: {
                candidates: [
                  {
                    content: { role: "model", parts: [{ text: "OK" }] },
                    finishReason: "STOP"
                  }
                ],
                usageMetadata: {
                  promptTokenCount: 11,
                  candidatesTokenCount: 4,
                  totalTokenCount: 15
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
        localApiKey: "local",
        cloudCode: { enabled: true, accountsDir },
        anthropic: { apiKey: "", apiKeys: [] }
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "local",
        "anthropic-version": "2023-06-01"
      },
      payload: {
        model: "claude-sonnet-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with exactly OK" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "OK" }]
    });
    const usedTokens = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"));
    expect(usedTokens[0]).toBe("Bearer token-a");
    expect(usedTokens.at(-1)).toBe("Bearer token-c");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
