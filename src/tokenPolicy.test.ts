import { describe, expect, it } from "vitest";
import {
  economyModelForRequest,
  optimizeAnthropicRequest,
  optimizeGeminiRequest,
  optimizeOpenAIRequest,
  readResponseCache,
  writeResponseCache
} from "./tokenPolicy.js";

describe("token policy", () => {
  it("trims old chat history while preserving system messages", () => {
    const messages = [
      { role: "system", content: "rules" },
      ...Array.from({ length: 20 }, (_, index) => ({ role: "user", content: `m-${index}` }))
    ];

    const optimized = optimizeOpenAIRequest({ model: "gemini-2.5-pro", messages }, "gemini-2.5-pro");

    expect(optimized.body.messages).toHaveLength(13);
    expect(optimized.body.messages?.[0]).toMatchObject({ role: "system", content: "rules" });
    expect(optimized.body.messages?.[1]).toMatchObject({ role: "user", content: "m-8" });
  });

  it("clamps high output token limits", () => {
    const anthropic = optimizeAnthropicRequest(
      { model: "claude-sonnet-4-6", max_tokens: 99_999, messages: [{ role: "user", content: "write a short note" }] },
      "claude-sonnet-4-6"
    );
    const gemini = optimizeGeminiRequest(
      { generationConfig: { maxOutputTokens: 99_999 }, contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      "gemini-2.5-pro"
    );

    expect(anthropic.body.max_tokens).toBe(2048);
    expect((gemini.body as any).generationConfig.maxOutputTokens).toBe(2048);
  });

  it("routes simple Claude Sonnet requests to Haiku", () => {
    const model = economyModelForRequest("claude-sonnet-4-6-thinking", {
      max_tokens: 128,
      messages: [{ role: "user", content: "summarize this" }]
    });

    expect(model).toBe("claude-haiku-4-5");
  });

  it("turns off Gemini thinking for simple requests", () => {
    const optimized = optimizeGeminiRequest(
      { generationConfig: { maxOutputTokens: 128 }, contents: [{ role: "user", parts: [{ text: "ping" }] }] },
      "gemini-2.5-flash-thinking"
    );

    expect(optimized.model).toBe("gemini-2.5-flash");
  });

  it("keeps a short-lived response cache by stable request key", () => {
    const body = { b: 2, a: 1 };
    writeResponseCache("test", "model", body, { ok: true });

    expect(readResponseCache("test", "model", { a: 1, b: 2 })).toEqual({ ok: true });
  });
});
