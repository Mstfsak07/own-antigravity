import crypto from "node:crypto";

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source?: { type?: string; media_type?: string; data?: string } }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown };

type ClaudeMessage = {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
};

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export type ClaudeMessagesRequest = {
  model: string;
  system?: string | Array<{ type: "text"; text: string }>;
  messages: ClaudeMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
};

export function buildSystemInstruction(system: ClaudeMessagesRequest["system"]) {
  if (!system) {
    return undefined;
  }

  const text =
    typeof system === "string"
      ? system
      : system
          .map((part) => (part.type === "text" ? part.text : ""))
          .filter(Boolean)
          .join("\n");

  return text ? { parts: [{ text }] } : undefined;
}

function contentToParts(content: ClaudeMessage["content"]): GeminiPart[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  const parts: GeminiPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text) {
        parts.push({ text: block.text });
      }
      continue;
    }

    if (block.type === "image" && block.source?.type === "base64" && block.source.data) {
      parts.push({
        inlineData: {
          mimeType: block.source.media_type ?? "image/png",
          data: block.source.data
        }
      });
      continue;
    }

    if (block.type === "tool_result") {
      const value = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      parts.push({ text: `Tool result ${block.tool_use_id ?? ""}:\n${value}` });
    }
  }
  return parts;
}

export function toCloudCodeRequest(input: ClaudeMessagesRequest, model: string, projectId?: string, userAgent = "antigravity") {
  const request: Record<string, unknown> = {
    contents: input.messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: contentToParts(message.content)
    })),
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
    ],
    generationConfig: {
      ...(input.max_tokens !== undefined ? { maxOutputTokens: input.max_tokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.top_p !== undefined ? { topP: input.top_p } : {}),
      ...(input.stop_sequences?.length ? { stopSequences: input.stop_sequences } : {})
    }
  };

  const systemInstruction = buildSystemInstruction(input.system);
  if (systemInstruction) {
    request.systemInstruction = systemInstruction;
  }

  const body: Record<string, unknown> = {
    requestId: `agent-${crypto.randomUUID()}`,
    request,
    model,
    userAgent,
    requestType: "agent"
  };

  if (projectId?.trim()) {
    body.project = projectId.trim();
  }

  return body;
}

export function extractTextFromCloudCodeResponse(response: any): string {
  const payload = response?.response ?? response;
  return (
    payload?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text ?? "")
      .join("") ?? ""
  );
}

export function toClaudeResponse(input: ClaudeMessagesRequest, upstream: any) {
  const text = extractTextFromCloudCodeResponse(upstream);
  const payload = upstream?.response ?? upstream;
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: input.model,
    content: text ? [{ type: "text", text }] : [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: payload?.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: payload?.usageMetadata?.candidatesTokenCount ?? 0
    }
  };
}
