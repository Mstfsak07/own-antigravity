import { createHash } from "node:crypto";

const KEEP_RECENT_MESSAGES = 12;
const MAX_TEXT_CHARS = 8_000;
const MAX_TOOL_TEXT_CHARS = 2_000;
const MAX_OUTPUT_TOKENS = 2_048;
const MAX_CHEAP_OUTPUT_TOKENS = 1_024;
const SIMPLE_PROMPT_CHARS = 2_500;
const CACHE_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const CACHE_MAX_BODY_CHARS = 200_000;

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

const responseCache = new Map<string, CacheEntry>();

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n[own-antigravity: truncated ${value.length - limit} chars]`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(textFromContent).filter(Boolean).join("\n");
  }
  if (isObject(content)) {
    if (typeof content.text === "string") {
      return content.text;
    }
    if (typeof content.content === "string") {
      return content.content;
    }
    if (Array.isArray(content.parts)) {
      return content.parts.map(textFromContent).filter(Boolean).join("\n");
    }
  }
  return "";
}

function requestTextLength(value: unknown): number {
  if (!value || typeof value !== "object") {
    return textFromContent(value).length;
  }
  const record = value as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const contents = Array.isArray(record.contents) ? record.contents : [];
  const input = Array.isArray(record.input) || typeof record.input === "string" ? record.input : undefined;
  return [...messages, ...contents, input].filter(Boolean).map(textFromContent).join("\n").length;
}

function hasTools(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  return (
    (Array.isArray(value.tools) && value.tools.length > 0) ||
    Boolean(value.tool_choice) ||
    Boolean(value.toolConfig) ||
    Boolean(value.request && isObject(value.request) && hasTools(value.request))
  );
}

function maxOutputTokens(value: unknown): number | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const direct = Number(value.max_tokens ?? value.maxOutputTokens);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  const generationConfig = isObject(value.generationConfig) ? value.generationConfig : undefined;
  const nested = Number(generationConfig?.maxOutputTokens);
  return Number.isFinite(nested) && nested > 0 ? nested : undefined;
}

function isSimpleRequest(value: unknown): boolean {
  const output = maxOutputTokens(value);
  return !hasTools(value) && requestTextLength(value) <= SIMPLE_PROMPT_CHARS && (output === undefined || output <= MAX_CHEAP_OUTPUT_TOKENS);
}

export function economyModelForRequest(model: string, request: unknown): string {
  const normalized = model.toLowerCase();
  if (!isSimpleRequest(request)) {
    return model;
  }
  if (normalized.startsWith("claude-") && (normalized.includes("sonnet") || normalized.includes("opus") || normalized.includes("thinking"))) {
    return "claude-haiku-4-5";
  }
  if (normalized.startsWith("gemini-") && normalized.includes("-thinking")) {
    return model.replace(/-thinking\b/i, "");
  }
  return model;
}

function clampOutputTokens(value: unknown): void {
  if (!isObject(value)) {
    return;
  }
  if (typeof value.max_tokens === "number" && Number.isFinite(value.max_tokens)) {
    value.max_tokens = Math.min(Math.max(1, Math.floor(value.max_tokens)), MAX_OUTPUT_TOKENS);
  }
  if (typeof value.maxOutputTokens === "number" && Number.isFinite(value.maxOutputTokens)) {
    value.maxOutputTokens = Math.min(Math.max(1, Math.floor(value.maxOutputTokens)), MAX_OUTPUT_TOKENS);
  }
  if (isObject(value.generationConfig) && typeof value.generationConfig.maxOutputTokens === "number") {
    value.generationConfig.maxOutputTokens = Math.min(
      Math.max(1, Math.floor(value.generationConfig.maxOutputTokens)),
      MAX_OUTPUT_TOKENS
    );
  }
}

function trimMessageList<T extends Record<string, unknown>>(messages: T[] | undefined): T[] | undefined {
  if (!Array.isArray(messages) || messages.length <= KEEP_RECENT_MESSAGES) {
    return messages;
  }
  const systemMessages = messages.filter((message) => message.role === "system");
  const conversation = messages.filter((message) => message.role !== "system");
  return [...systemMessages, ...conversation.slice(-KEEP_RECENT_MESSAGES)];
}

function trimGeminiContents<T extends Record<string, unknown>>(contents: T[] | undefined): T[] | undefined {
  if (!Array.isArray(contents) || contents.length <= KEEP_RECENT_MESSAGES) {
    return contents;
  }
  return contents.slice(-KEEP_RECENT_MESSAGES);
}

function truncateContent(content: unknown, toolLike: boolean): unknown {
  const limit = toolLike ? MAX_TOOL_TEXT_CHARS : MAX_TEXT_CHARS;
  if (typeof content === "string") {
    return truncateText(content, limit);
  }
  if (Array.isArray(content)) {
    return content.map((item) => truncateContent(item, toolLike));
  }
  if (!isObject(content)) {
    return content;
  }
  const next = { ...content };
  if (typeof next.text === "string") {
    next.text = truncateText(next.text, limit);
  }
  if (typeof next.content === "string") {
    next.content = truncateText(next.content, limit);
  } else if (Array.isArray(next.content)) {
    next.content = truncateContent(next.content, toolLike);
  }
  if (Array.isArray(next.parts)) {
    next.parts = next.parts.map((part) => truncateContent(part, toolLike));
  }
  if (isObject(next.functionResponse)) {
    next.functionResponse = truncateContent(next.functionResponse, true);
  }
  return next;
}

function sanitizeMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }
  return messages.map((message) => {
    if (!isObject(message)) {
      return message;
    }
    const role = String(message.role ?? "");
    return {
      ...message,
      content: truncateContent(message.content, role === "tool")
    };
  });
}

function sanitizeGeminiContents(contents: unknown): unknown {
  if (!Array.isArray(contents)) {
    return contents;
  }
  return contents.map((content) => truncateContent(content, false));
}

export function optimizeAnthropicRequest<T extends Record<string, unknown>>(body: T, resolvedModel: string): { body: T; model: string } {
  const next = cloneJson(body) as Record<string, unknown>;
  next.messages = sanitizeMessages(trimMessageList(next.messages as Array<Record<string, unknown>> | undefined));
  clampOutputTokens(next);
  const model = economyModelForRequest(resolvedModel, next);
  next.model = model;
  return { body: next as T, model };
}

export function optimizeOpenAIRequest<T extends Record<string, unknown>>(body: T, resolvedModel: string): { body: T; model: string } {
  const next = cloneJson(body) as Record<string, unknown>;
  next.messages = sanitizeMessages(trimMessageList(next.messages as Array<Record<string, unknown>> | undefined));
  if (Array.isArray(next.input)) {
    next.input = sanitizeMessages(trimMessageList(next.input as Array<Record<string, unknown>>));
  } else if (typeof next.input === "string") {
    next.input = truncateText(next.input, MAX_TEXT_CHARS);
  }
  clampOutputTokens(next);
  const model = economyModelForRequest(resolvedModel, next);
  next.model = model;
  return { body: next as T, model };
}

export function optimizeGeminiRequest<T>(body: T, resolvedModel: string): { body: T; model: string } {
  const next = cloneJson(body ?? {}) as Record<string, unknown>;
  next.contents = sanitizeGeminiContents(trimGeminiContents(next.contents as Array<Record<string, unknown>> | undefined));
  clampOutputTokens(next);
  const model = economyModelForRequest(resolvedModel, next);
  return { body: next as T, model };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = stableValue(value[key]);
      return acc;
    }, {});
}

function cacheKey(namespace: string, model: string, body: unknown): string | undefined {
  const raw = JSON.stringify({ namespace, model, body: stableValue(body) });
  if (raw.length > CACHE_MAX_BODY_CHARS) {
    return undefined;
  }
  return createHash("sha256").update(raw).digest("hex");
}

export function readResponseCache(namespace: string, model: string, body: unknown): unknown | undefined {
  const key = cacheKey(namespace, model, body);
  if (!key) {
    return undefined;
  }
  const entry = responseCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return undefined;
  }
  return cloneJson(entry.value);
}

export function writeResponseCache(namespace: string, model: string, body: unknown, value: unknown): void {
  const key = cacheKey(namespace, model, body);
  if (!key) {
    return;
  }
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest) {
      responseCache.delete(oldest);
    }
  }
  responseCache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value: cloneJson(value)
  });
}
