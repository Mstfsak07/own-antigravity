import { describe, expect, it, vi } from "vitest";
import {
  GeminiOfficialAdapter,
  OpenAICompatibleAdapter,
  mapProviderError,
  mapProviderStatus,
  providerErrorPayload,
  type ProviderAdapter
} from "./adapter.js";

function ok(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

async function expectAdapter(adapter: ProviderAdapter): Promise<void> {
  expect(await adapter.listModels()).toHaveLength(1);
  expect(await adapter.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })).toBeTruthy();
  const stream = await adapter.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] });
  const first = await stream[Symbol.asyncIterator]().next();
  expect(first.done).toBe(false);
  expect(await adapter.healthCheck()).toMatchObject({ ok: true });
}

describe("provider adapters", () => {
  it("implements a common interface for Gemini", async () => {
    const fetcher = vi.fn(async (input: string) => input.includes("/models")
      ? ok({ models: [{ name: "gemini-2.5-pro" }] })
      : ok({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })
    ) as any;

    await expectAdapter(new GeminiOfficialAdapter("https://gemini.example.test", "secret-key", fetcher));
    expect(fetcher).toHaveBeenCalled();
  });

  it("implements a common interface for OpenAI-compatible providers", async () => {
    const fetcher = vi.fn(async (input: string) => input.endsWith("/v1/models")
      ? ok({ data: [{ id: "gpt-test" }] })
      : ok({ choices: [{ message: { content: "ok" } }] })
    ) as any;

    await expectAdapter(new OpenAICompatibleAdapter("https://openai.example.test", "secret-key", fetcher));
  });

  it("redacts provider secrets in health errors", async () => {
    const adapter = new OpenAICompatibleAdapter(
      "https://openai.example.test",
      "secret-key",
      vi.fn(async () => new Response("bad", { status: 401 })) as any
    );

    const health = await adapter.healthCheck();

    expect(health.ok).toBe(false);
    expect(JSON.stringify(health)).not.toContain("secret-key");
  });

  it("maps provider errors into stable gateway classes", () => {
    expect(mapProviderStatus(401)).toBe("auth_error");
    expect(mapProviderStatus(429)).toBe("rate_limit");
    expect(mapProviderError(new TypeError("fetch failed"))).toBe("network_error");
    expect(mapProviderError(new Error("request timeout"))).toBe("timeout");
    expect(providerErrorPayload("gemini", new Error("request timeout")).statusCode).toBe(504);
  });
});
