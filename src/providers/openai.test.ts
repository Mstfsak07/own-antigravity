import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import { toGeminiRequest } from "./openai.js";
import { createRuntime } from "../runtime.js";
import { baseTestConfig } from "../testConfig.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-openai-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("toGeminiRequest", () => {
  it("maps OpenAI chat messages to Gemini contents", () => {
    const mapped = toGeminiRequest({
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" }
      ],
      temperature: 0.2,
      max_tokens: 128
    });

    expect(mapped).toEqual({
      systemInstruction: {
        parts: [{ text: "Be concise." }]
      },
      contents: [
        { role: "user", parts: [{ text: "Hello" }] },
        { role: "model", parts: [{ text: "Hi" }] }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 128
      }
    });
  });

  it("keeps base64 image_url parts as Gemini inlineData", () => {
    const mapped = toGeminiRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this panel." },
            { type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } }
          ]
        }
      ]
    });

    expect(mapped).toEqual({
      contents: [
        {
          role: "user",
          parts: [
            { text: "Describe this panel." },
            { inlineData: { mimeType: "image/png", data: "ZmFrZQ==" } }
          ]
        }
      ],
      generationConfig: {}
    });
  });
});

describe("runtime model aliases", () => {
  it("maps OpenAI model aliases to configured provider models", () => {
    const runtime = createRuntime(baseTestConfig({
      localApiKey: "local",
      modelAliases: {
        "gpt-4o": "gemini-2.5-flash"
      },
      gemini: {
        apiKey: "key",
        apiKeys: ["key"],
        baseUrl: "https://generativelanguage.googleapis.com",
        defaultModel: "gemini-2.5-pro"
      },
      anthropic: {
        apiKey: "key",
        apiKeys: ["key"],
        baseUrl: "https://api.anthropic.com",
        version: "2023-06-01"
      }
    }));

    expect(runtime.resolveModel("gpt-4o")).toBe("gemini-2.5-flash");
    expect(runtime.resolveModel(undefined)).toBe("gemini-2.5-pro");
  });
});

describe("openai-compatible Gemini routing", () => {
  it("uses cloud code accounts for local OpenAI requests when provider keys are absent", async () => {
    const dir = makeDir();
    const accountsDir = join(dir, "accounts");
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(
      join(accountsDir, "account.json"),
      JSON.stringify({
        id: "cloud-1",
        email: "person@example.test",
        token: {
          access_token: "cloud-access-token",
          refresh_token: "cloud-refresh-token",
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
          project_id: "project-1"
        },
        quota: {
          models: [{ name: "gemini-2.5-pro", percentage: 100 }]
        }
      }),
      "utf8"
    );

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).includes(":generateContent")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              response: {
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [{ text: "cloud code response" }]
                    },
                    finishReason: "STOP"
                  }
                ],
                usageMetadata: {
                  promptTokenCount: 3,
                  candidatesTokenCount: 4,
                  totalTokenCount: 7
                }
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
    });

    const app = buildServer(
      baseTestConfig({
        localApiKey: "local",
        cloudCode: { enabled: true, accountsDir },
        gemini: { apiKey: "", apiKeys: [] }
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer local" },
      payload: {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      model: "gemini-2.5-pro",
      choices: [{ message: { content: "cloud code response" } }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 4,
        total_tokens: 7
      }
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://cloudcode-pa.googleapis.com/v1internal:generateContent");

    await app.close();
  });

  it("rotates to another cloud code account after a retryable upstream failure", async () => {
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
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
          project_id: "project-a"
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
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
          project_id: "project-b"
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
                    content: { role: "model", parts: [{ text: "rotated ok" }] },
                    finishReason: "STOP"
                  }
                ],
                usageMetadata: {
                  promptTokenCount: 2,
                  candidatesTokenCount: 2,
                  totalTokenCount: 4
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
      baseTestConfig({
        localApiKey: "local",
        cloudCode: { enabled: true, accountsDir },
        gemini: { apiKey: "", apiKeys: [] }
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer local" },
      payload: {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("rotated ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("routes glm targets to the configured z.ai provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      expect(String(input)).toBe("https://api.z.ai/api/paas/v4/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer zai-test-key");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl-zai",
            object: "chat.completion",
            model: "glm-4.6",
            choices: [{ index: 0, message: { role: "assistant", content: "glm ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });

    const app = buildServer(
      baseTestConfig({
        localApiKey: "local",
        modelAliases: {
          "gpt-5": "glm-4.6"
        },
        zai: {
          enabled: true,
          apiKey: "zai-test-key",
          apiKeys: ["zai-test-key"],
          baseUrl: "https://api.z.ai/api/paas/v4",
          defaultModel: "glm-4.6"
        }
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer local" },
      payload: {
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      model: "glm-4.6",
      choices: [{ message: { content: "glm ok" } }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it.each([
    {
      provider: "groq",
      model: "groq/openai/gpt-oss-20b",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      config: {
        groq: {
          enabled: true,
          apiKey: "groq-test-key",
          apiKeys: ["groq-test-key"],
          baseUrl: "https://api.groq.com/openai",
          defaultModel: "groq/openai/gpt-oss-20b"
        }
      }
    },
    {
      provider: "cerebras",
      model: "cerebras/gpt-oss-120b",
      endpoint: "https://api.cerebras.ai/v1/chat/completions",
      config: {
        cerebras: {
          enabled: true,
          apiKey: "cerebras-test-key",
          apiKeys: ["cerebras-test-key"],
          baseUrl: "https://api.cerebras.ai",
          defaultModel: "cerebras/gpt-oss-120b"
        }
      }
    },
    {
      provider: "ollama",
      model: "ollama/llama3.2",
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      config: {
        ollama: {
          enabled: true,
          apiKey: "ollama",
          apiKeys: ["ollama"],
          baseUrl: "http://127.0.0.1:11434",
          defaultModel: "ollama/llama3.2"
        }
      }
    },
    {
      provider: "mistral",
      model: "mistral/mistral-small-latest",
      endpoint: "https://api.mistral.ai/v1/chat/completions",
      config: {
        mistral: {
          enabled: true,
          apiKey: "mistral-test-key",
          apiKeys: ["mistral-test-key"],
          baseUrl: "https://api.mistral.ai",
          defaultModel: "mistral/mistral-small-latest"
        }
      }
    }
  ])("routes $provider targets to the configured provider", async ({ model, endpoint, config, provider }) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      expect(String(input)).toBe(endpoint);
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.model).not.toContain(`${provider}/`);
      const headers = new Headers(init?.headers);
      if (provider === "ollama") {
        expect(headers.get("authorization")).toBeNull();
      } else {
        expect(headers.get("authorization")).toContain("Bearer ");
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: `chatcmpl-${provider}`,
            object: "chat.completion",
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: `${provider} ok` }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });

    const app = buildServer(
      baseTestConfig({
        localApiKey: "local",
        modelAliases: {
          "gpt-5": model
        },
        ...config
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer local" },
      payload: {
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [{ message: { content: `${provider} ok` } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("converts prefixed provider chat output to responses format on /v1/responses", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      expect(String(input)).toBe("https://api.groq.com/openai/v1/chat/completions");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.model).toBe("openai/gpt-oss-20b");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl-groq",
            object: "chat.completion",
            model: "openai/gpt-oss-20b",
            choices: [{ index: 0, message: { role: "assistant", content: "groq response" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });

    const app = buildServer(
      baseTestConfig({
        localApiKey: "local",
        groq: {
          enabled: true,
          apiKey: "groq-test-key",
          apiKeys: ["groq-test-key"],
          baseUrl: "https://api.groq.com/openai",
          defaultModel: "groq/openai/gpt-oss-20b"
        }
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer local" },
      payload: {
        model: "groq/openai/gpt-oss-20b",
        input: "hello"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "response",
      model: "openai/gpt-oss-20b",
      output: [{ content: [{ text: "groq response" }] }],
      usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 }
    });

    await app.close();
  });
});
