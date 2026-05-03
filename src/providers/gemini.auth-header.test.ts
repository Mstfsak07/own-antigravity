import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import { baseTestConfig } from "../testConfig.js";
import type { ProxyConfig } from "../types.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-gemini-auth-"));
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
    gemini: {
      apiKey: "",
      apiKeys: [],
      baseUrl: "https://generativelanguage.googleapis.com",
      defaultModel: "gemini-2.5-pro"
    },
    ...overrides
  });
}

describe("gemini proxy auth header routing", () => {
  it("treats Authorization bearer local key as a local Gemini request and uses Cloud Code fallback", async () => {
    const dir = makeDir();
    const accountsDir = join(dir, "accounts");
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(
      join(accountsDir, "account.json"),
      JSON.stringify({
        id: "cloud-a",
        email: "a@example.test",
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

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") === "Bearer token-a") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              response: {
                candidates: [
                  {
                    content: { role: "model", parts: [{ text: "cloud code ok" }] },
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
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
        );
      }
      return Promise.reject(new Error(`unexpected request headers: ${JSON.stringify([...headers.entries()])}`));
    });

    const app = buildServer(
      config({
        cloudCode: { enabled: true, accountsDir }
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.5-pro:generateContent",
      headers: {
        authorization: "Bearer local"
      },
      payload: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().candidates[0].content.parts[0].text).toBe("cloud code ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
