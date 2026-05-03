import { randomUUID } from "node:crypto";

export type NormalizedLsOutput = {
  id: string;
  model: string;
  text: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  citations: Array<{ title?: string; url?: string }>;
  images: Array<{ mimeType?: string; placeholder: string }>;
};

function stripHiddenReasoning(input: string): string {
  return input
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<chain_of_thought>[\s\S]*?<\/chain_of_thought>/gi, "");
}

export function normalizeLsOutput(raw: unknown, model: string): NormalizedLsOutput {
  const source = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  const withoutReasoning = stripHiddenReasoning(source);
  const toolCalls = [...withoutReasoning.matchAll(/<tool_call\s+name="([^"]+)">([\s\S]*?)<\/tool_call>/gi)].map(
    (match) => ({ name: match[1], arguments: match[2].trim() })
  );
  const citations = [...withoutReasoning.matchAll(/<source(?:\s+title="([^"]*)")?\s+url="([^"]+)">/gi)].map(
    (match) => ({ title: match[1] || undefined, url: match[2] })
  );
  const images = [...withoutReasoning.matchAll(/<image(?:\s+mime="([^"]*)")?\s*\/>/gi)].map((match, index) => ({
    mimeType: match[1] || undefined,
    placeholder: `[image:${index + 1}]`
  }));
  const text = withoutReasoning
    .replace(/<tool_call\s+name="[^"]+">[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<source(?:\s+title="[^"]*")?\s+url="[^"]+">\s*/gi, "")
    .replace(/<image(?:\s+mime="[^"]*")?\s*\/>/gi, (match) => images.shift()?.placeholder ?? match)
    .trim();

  return {
    id: `ls_${randomUUID().replace(/-/g, "")}`,
    model,
    text,
    toolCalls,
    citations,
    images: [...withoutReasoning.matchAll(/<image(?:\s+mime="([^"]*)")?\s*\/>/gi)].map((match, index) => ({
      mimeType: match[1] || undefined,
      placeholder: `[image:${index + 1}]`
    }))
  };
}

export function toOpenAIChat(output: NormalizedLsOutput) {
  return {
    id: `chatcmpl_${output.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: output.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: output.text,
          ...(output.toolCalls.length > 0
            ? {
                tool_calls: output.toolCalls.map((call, index) => ({
                  id: `call_${index + 1}`,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments }
                }))
              }
            : {})
        },
        finish_reason: "stop"
      }
    ],
    citations: output.citations,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

export function toOpenAIResponse(output: NormalizedLsOutput) {
  return {
    id: `resp_${output.id}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: output.model,
    output: [
      {
        id: `msg_${output.id}`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: output.text }]
      }
    ],
    citations: output.citations,
    status: "completed"
  };
}

export function toAnthropicMessage(output: NormalizedLsOutput) {
  return {
    id: `msg_${output.id}`,
    type: "message",
    role: "assistant",
    model: output.model,
    content: [{ type: "text", text: output.text }],
    citations: output.citations,
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 }
  };
}

export function toGeminiGenerateContent(output: NormalizedLsOutput) {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: output.text }]
        },
        finishReason: "STOP"
      }
    ],
    citations: output.citations,
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
  };
}

export function toSseEvents(output: NormalizedLsOutput, target: "openai" | "anthropic" | "gemini"): string {
  const data =
    target === "anthropic"
      ? toAnthropicMessage(output)
      : target === "gemini"
        ? toGeminiGenerateContent(output)
        : toOpenAIChat(output);
  return `event: message\ndata: ${JSON.stringify(data)}\n\nevent: done\ndata: [DONE]\n\n`;
}
