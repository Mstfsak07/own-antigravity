import { describe, expect, it } from "vitest";
import { geminiSseToOpenAISse } from "./openaiStream.js";

describe("geminiSseToOpenAISse", () => {
  it("maps Gemini SSE chunks to OpenAI SSE chunks", async () => {
    const upstream = new Response(
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"hel"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n'
      ].join(""),
      {
        headers: { "content-type": "text/event-stream" }
      }
    );

    const chunks = [];
    for await (const chunk of geminiSseToOpenAISse(upstream, "chatcmpl_test", "gemini-test")) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toContain('"content":"hel"');
    expect(chunks.join("")).toContain('"content":"lo"');
    expect(chunks.at(-1)).toBe("data: [DONE]\n\n");
  });
});
