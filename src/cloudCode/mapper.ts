import crypto from "node:crypto";
import { resolveRequestUserAgent } from "../requestUserAgent.js";

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source?: { type?: string; media_type?: string; data?: string } }
  | { type: "tool_use"; id: string; name: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean };

type ClaudeMessage = {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
};

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { id?: string; name: string; args: unknown } }
  | { functionResponse: { id?: string; name: string; response: { result: string } } };

export type ClaudeMessagesRequest = {
  model: string;
  system?: string | Array<{ type: "text"; text: string }>;
  messages: ClaudeMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
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

function normalizeToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }

  const normalized = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  cleanSchema(normalized);
  if (typeof normalized.type !== "string") {
    normalized.type = "object";
  }
  if (
    normalized.type === "object" &&
    (!normalized.properties || typeof normalized.properties !== "object" || Array.isArray(normalized.properties))
  ) {
    normalized.properties = {};
  }
  return normalized;
}

function cleanSchema(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(cleanSchema);
    return;
  }

  const map = value as Record<string, unknown>;
  for (const item of Object.values(map)) {
    cleanSchema(item);
  }

  for (const key of [
    "$schema",
    "$defs",
    "definitions",
    "additionalProperties",
    "default",
    "examples",
    "const",
    "oneOf",
    "anyOf",
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
    "dependencies",
    "dependentSchemas",
    "dependentRequired",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contains",
    "minContains",
    "maxContains",
    "format",
    "pattern",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
    "uniqueItems",
    "cache_control"
  ]) {
    delete map[key];
  }

  const type = map.type;
  if (typeof type === "string") {
    map.type = type.toLowerCase();
  } else if (Array.isArray(type)) {
    map.type = String(type.find((item) => item && item !== "null") ?? "string").toLowerCase();
  }
}

function buildTools(tools: unknown[] | undefined) {
  if (!tools?.length) {
    return undefined;
  }

  const functionDeclarations = tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") {
        return undefined;
      }
      const item = tool as { name?: unknown; description?: unknown; input_schema?: unknown; type?: unknown };
      if (typeof item.name !== "string" || !item.name) {
        return undefined;
      }
      if (String(item.type ?? "").startsWith("web_search")) {
        return undefined;
      }
      return {
        name: item.name,
        description: typeof item.description === "string" ? item.description : "",
        parameters: normalizeToolSchema(item.input_schema)
      };
    })
    .filter(Boolean);

  return functionDeclarations.length ? [{ functionDeclarations }] : undefined;
}

function toolNameFromId(id: string | undefined, toolIdToName: Map<string, string>): string {
  if (!id) {
    return "tool";
  }
  const known = toolIdToName.get(id);
  if (known) {
    return known;
  }
  const match = id.match(/^toolu_([^_]+)_/);
  return match?.[1] ?? id;
}

function toolResultText(content: unknown, isError?: boolean): string {
  if (typeof content === "string") {
    return content || (isError ? "Tool execution failed with no output." : "Command executed successfully.");
  }
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) {
      return text;
    }
  }
  if (content !== undefined && content !== null) {
    return JSON.stringify(content);
  }
  return isError ? "Tool execution failed with no output." : "Command executed successfully.";
}

function contentToParts(content: ClaudeMessage["content"], toolIdToName: Map<string, string>): GeminiPart[] {
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

    if (block.type === "tool_use") {
      toolIdToName.set(block.id, block.name);
      parts.push({
        functionCall: {
          id: block.id,
          name: block.name,
          args: block.input ?? {}
        }
      });
      continue;
    }

    if (block.type === "tool_result") {
      const name = toolNameFromId(block.tool_use_id, toolIdToName);
      parts.push({
        functionResponse: {
          id: block.tool_use_id,
          name,
          response: { result: toolResultText(block.content, block.is_error) }
        }
      });
    }
  }
  return parts;
}

function cloudCodeSessionId(metadataUserId: string | undefined): string {
  const raw = metadataUserId?.trim();
  if (!raw) {
    return crypto.randomUUID();
  }

  try {
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
      return parsed.session_id.trim();
    }
  } catch {}

  return raw;
}

function requestIdSessionPrefix(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8) || crypto.randomUUID().slice(0, 8);
}

export function toCloudCodeRequest(input: ClaudeMessagesRequest, model: string, projectId?: string, userAgent = "antigravity") {
  const sessionId = cloudCodeSessionId(input.metadata?.user_id);
  const toolIdToName = new Map<string, string>();
  const request: Record<string, unknown> = {
    contents: input.messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: contentToParts(message.content, toolIdToName)
    })),
    sessionId,
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
  const tools = buildTools(input.tools);
  if (tools) {
    request.tools = tools;
    request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }

  const body: Record<string, unknown> = {
    requestId: `agent/antigravity/${requestIdSessionPrefix(sessionId)}/${Date.now()}`,
    request,
    model,
    userAgent: resolveRequestUserAgent(userAgent),
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

export function cloudCodeContentBlocks(response: any) {
  const payload = response?.response ?? response;
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  const content: Array<Record<string, unknown>> = [];

  for (const part of parts) {
    if (part?.functionCall) {
      const call = part.functionCall;
      const name = String(call.name ?? "tool");
      const id = typeof call.id === "string" && call.id ? call.id : `toolu_${name}_${crypto.randomUUID().replace(/-/g, "")}`;
      content.push({
        type: "tool_use",
        id,
        name,
        input: call.args ?? {}
      });
      continue;
    }
    if (typeof part?.text === "string" && part.text) {
      content.push({ type: "text", text: part.text });
    }
  }

  return content;
}

export function toClaudeResponse(input: ClaudeMessagesRequest, upstream: any) {
  const payload = upstream?.response ?? upstream;
  const content = cloudCodeContentBlocks(upstream);
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: input.model,
    content,
    stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: payload?.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: payload?.usageMetadata?.candidatesTokenCount ?? 0
    }
  };
}
