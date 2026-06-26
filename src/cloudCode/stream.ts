import { Readable } from "node:stream";
import crypto from "node:crypto";
import type { ClaudeMessagesRequest } from "./mapper.js";

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
  let index = 0;
  let textOpen = false;
  let toolUsed = false;

  const closeText = function* () {
    if (textOpen) {
      yield event("content_block_stop", { type: "content_block_stop", index });
      index += 1;
      textOpen = false;
    }
  };

  const openText = function* () {
    if (!textOpen) {
      yield event("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" }
      });
      textOpen = true;
    }
  };

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
          const parsedPayload = parsed?.response ?? parsed;
          const parts = parsedPayload?.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part?.functionCall) {
              yield* closeText();
              const call = part.functionCall;
              const name = String(call.name ?? "tool");
              const toolId =
                typeof call.id === "string" && call.id
                  ? call.id
                  : `toolu_${name}_${crypto.randomUUID().replace(/-/g, "")}`;
              yield event("content_block_start", {
                type: "content_block_start",
                index,
                content_block: {
                  type: "tool_use",
                  id: toolId,
                  name,
                  input: {}
                }
              });
              yield event("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(call.args ?? {})
                }
              });
              yield event("content_block_stop", { type: "content_block_stop", index });
              index += 1;
              toolUsed = true;
              continue;
            }
            if (typeof part?.text === "string" && part.text) {
              yield* openText();
              yield event("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: part.text }
              });
            }
          }
          if (!parts.length && typeof parsedPayload?.text === "string" && parsedPayload.text) {
            yield* openText();
            yield event("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: parsedPayload.text }
            });
          }
        }
      }
    }
  }

  yield* closeText();
  yield event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: toolUsed ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 }
  });
  yield event("message_stop", { type: "message_stop" });
}

export function readableClaudeStream(response: Response, input: ClaudeMessagesRequest, id: string): Readable {
  return Readable.from(cloudCodeSseToClaudeSse(response, input, id));
}
