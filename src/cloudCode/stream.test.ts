import { describe, expect, it } from "vitest";
import { cloudCodeSseToClaudeSse } from "./stream.js";

describe("cloudCodeSseToClaudeSse", () => {
  it("maps CloudCode SSE to Claude SSE", async () => {
    const upstream = new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
      { headers: { "content-type": "text/event-stream" } }
    );

    const chunks = [];
    for await (const chunk of cloudCodeSseToClaudeSse(
      upstream,
      { model: "claude-sonnet-4-6", messages: [], stream: true },
      "msg_test"
    )) {
      chunks.push(chunk);
    }

    const joined = chunks.join("");
    expect(joined).toContain("event: message_start");
    expect(joined).toContain('"text":"ok"');
    expect(joined).toContain("event: message_stop");
  });
});
