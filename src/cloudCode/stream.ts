import { Readable } from "node:stream";
import { extractTextFromCloudCodeResponse, type ClaudeMessagesRequest } from "./mapper.js";

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function claudeMessageStart(id: string, input: ClaudeMessagesRequest) {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: input.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  };
}

export async function* cloudCodeSseToClaudeSse(
  response: Response,
  input: ClaudeMessagesRequest,
  id: string
): AsyncGenerator<string> {
  yield event("message_start", claudeMessageStart(id, input));
  yield event("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" }
  });

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";

      for (const item of events) {
        for (const line of item.split(/\r?\n/)) {
          if (!line.startsWith("data:")) {
            continue;
          }
          const payload = line.slice("data:".length).trim();
          if (!payload || payload === "[DONE]") {
            continue;
          }
          const parsed = JSON.parse(payload);
          const text = extractTextFromCloudCodeResponse(parsed);
          if (text) {
            yield event("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text }
            });
          }
        }
      }
    }
  }

  yield event("content_block_stop", { type: "content_block_stop", index: 0 });
  yield event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 }
  });
  yield event("message_stop", { type: "message_stop" });
}

export function readableClaudeStream(response: Response, input: ClaudeMessagesRequest, id: string): Readable {
  return Readable.from(cloudCodeSseToClaudeSse(response, input, id));
}
