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

  it("sends the resolved Antigravity user agent in Claude Cloud Code payloads", async () => {
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
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        },
        quota: {
          models: [{ name: "claude-sonnet-4-6", percentage: 100 }]
        }
      }),
      "utf8"
    );

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            response: {
              candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const app = buildServer(
      config({
        localApiKey: "local",
        cloudCode: { enabled: true, accountsDir, userAgent: "antigravity" },
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
        metadata: {
          user_id: JSON.stringify({
            device_id: "device-test",
            account_uuid: "",
            session_id: "631bbd58-2580-4603-917c-333d3f9ddab8"
          })
        },
        messages: [{ role: "user", content: "Reply with exactly OK" }]
      }
    });

    expect(response.statusCode).toBe(200);
    const cloudCodeCall = fetchMock.mock.calls.find(([, init]) => {
      const body = init?.body;
      return typeof body === "string" && body.includes("\"userAgent\"");
    });
    expect(cloudCodeCall).toBeDefined();
    const body = JSON.parse(cloudCodeCall?.[1]?.body as string);
    expect(body.userAgent).toMatch(/^antigravity\/\d+\.\d+\.\d+ windows\/amd64$/);
    expect(body.request.sessionId).toBe("631bbd58-2580-4603-917c-333d3f9ddab8");
    expect(body.requestId).toMatch(/^agent\/antigravity\/631bbd58\/\d+$/);
  });

  it("maps Claude Code tool requests to Cloud Code function declarations", async () => {
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
          project_id: "project-a",
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        },
        quota: {
          models: [{ name: "claude-sonnet-4-6", percentage: 100 }]
        }
      }),
      "utf8"
    );

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ functionCall: { id: "toolu_Read_123", name: "Read", args: { file_path: "package.json" } } }]
                  },
                  finishReason: "STOP"
                }
              ],
              usageMetadata: {
                promptTokenCount: 12,
                candidatesTokenCount: 3,
                totalTokenCount: 15
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const app = buildServer(
      config({
        cloudCode: { enabled: true, accountsDir },
        anthropic: { apiKey: "", apiKeys: [] }
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-sonnet-4-6",
        max_tokens: 16,
        tools: [
          {
            name: "Read",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: { file_path: { type: "string" } },
              required: ["file_path"]
            }
          }
        ],
        messages: [{ role: "user", content: "Read package.json" }]
      }
    });

    expect(response.statusCode).toBe(200);
    const cloudCodeCall = fetchMock.mock.calls.find(([, init]) => {
      const body = init?.body;
      return typeof body === "string" && body.includes("\"request\"");
    });
    expect(cloudCodeCall).toBeDefined();
    const headers = new Headers(cloudCodeCall?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer token-a");
    const forwardedBody = JSON.parse(cloudCodeCall?.[1]?.body as string);
    expect(forwardedBody.request.tools[0].functionDeclarations[0]).toMatchObject({
      name: "Read",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"]
      }
    });
    expect(response.json()).toMatchObject({
      content: [
        {
          type: "tool_use",
          id: "toolu_Read_123",
          name: "Read",
          input: { file_path: "package.json" }
        }
      ],
      stop_reason: "tool_use"
    });
  });

  it("maps Claude tool results back to Cloud Code function responses", async () => {
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
          project_id: "project-a",
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        },
        quota: {
          models: [{ name: "claude-sonnet-4-6", percentage: 100 }]
        }
      }),
      "utf8"
    );

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            response: {
              candidates: [{ content: { role: "model", parts: [{ text: "Done" }] }, finishReason: "STOP" }]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const app = buildServer(
      config({
        cloudCode: { enabled: true, accountsDir },
        anthropic: { apiKey: "", apiKeys: [] }
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-sonnet-4-6",
        max_tokens: 16,
        tools: [
          {
            name: "Read",
            description: "Read a file",
            input_schema: { type: "object" }
          }
        ],
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_Read_123", name: "Read", input: { file_path: "package.json" } }]
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_Read_123", content: "package content" }]
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const cloudCodeCall = fetchMock.mock.calls.find(([, init]) => {
      const body = init?.body;
      return typeof body === "string" && body.includes("\"request\"");
    });
    expect(cloudCodeCall).toBeDefined();
    const forwardedBody = JSON.parse(cloudCodeCall?.[1]?.body as string);
    expect(forwardedBody.request.contents).toEqual([
      {
        role: "model",
        parts: [{ functionCall: { id: "toolu_Read_123", name: "Read", args: { file_path: "package.json" } } }]
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "toolu_Read_123",
              name: "Read",
              response: { result: "package content" }
            }
          }
        ]
      }
    ]);
  });
});
