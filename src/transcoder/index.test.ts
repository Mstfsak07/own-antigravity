import { describe, expect, it } from "vitest";
import {
  normalizeLsOutput,
  toAnthropicMessage,
  toGeminiGenerateContent,
  toOpenAIChat,
  toOpenAIResponse,
  toSseEvents
} from "./index.js";

describe("transcoder", () => {
  it("normalizes LS output without exposing hidden reasoning", () => {
    const output = normalizeLsOutput(
      'hello <thinking>secret reasoning</thinking><tool_call name="search">{"q":"x"}</tool_call><source title="Doc" url="https://example.test">',
      "model-a"
    );

    expect(output.text).toContain("hello");
    expect(output.text).not.toContain("secret reasoning");
    expect(output.toolCalls[0]).toEqual({ name: "search", arguments: '{"q":"x"}' });
    expect(output.citations[0]).toEqual({ title: "Doc", url: "https://example.test" });
  });

  it("produces OpenAI, Responses, Anthropic, Gemini, and SSE shapes", () => {
    const output = normalizeLsOutput("hello", "model-a");

    expect(toOpenAIChat(output)).toMatchObject({ object: "chat.completion", model: "model-a" });
    expect(toOpenAIResponse(output)).toMatchObject({ object: "response", status: "completed" });
    expect(toAnthropicMessage(output)).toMatchObject({ type: "message", role: "assistant" });
    expect(toGeminiGenerateContent(output)).toMatchObject({ candidates: [{ finishReason: "STOP" }] });
    expect(toSseEvents(output, "openai")).toContain("event: done");
  });
});
