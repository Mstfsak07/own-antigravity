export const TRAFFIC_COLUMNS = [
  { key: "status", label: "Durum" },
  { key: "method", label: "Metot" },
  { key: "model", label: "Model" },
  { key: "provider", label: "Protokol" },
  { key: "account", label: "Hesap" },
  { key: "route", label: "Yol" },
  { key: "tokens", label: "Token'lar" },
  { key: "duration", label: "Süre" },
  { key: "time", label: "Zaman" }
];

export function defaultTrafficColumns() {
  return {
    status: true,
    method: true,
    model: true,
    provider: true,
    account: true,
    route: true,
    tokens: true,
    duration: true,
    time: true
  };
}

export function mergeTrafficColumns(snapshot) {
  return {
    ...defaultTrafficColumns(),
    ...(snapshot && typeof snapshot === "object" ? snapshot : {})
  };
}

export function statusTone(status) {
  const code = Number(status);
  if (code >= 200 && code < 300) return "success";
  if (code >= 400 && code < 500) return "error";
  return "warning";
}

export function protocolTone(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (!value || value === "-") return "unknown";
  if (value.includes("gemini")) return "gemini";
  if (value.includes("claude") || value.includes("anthropic")) return "claude";
  if (value.includes("openai")) return "openai";
  if (value.includes("groq")) return "groq";
  if (value.includes("cerebras")) return "cerebras";
  if (value.includes("ollama")) return "ollama";
  if (value.includes("mistral")) return "mistral";
  if (value.includes("cloudcode") || value.includes("cloud code")) return "cloudcode";
  if (value.includes("native")) return "native";
  if (value.includes("zai") || value.includes("z.ai")) return "zai";
  return "unknown";
}

function protocolFromRoute(route) {
  if (route.includes("/v1/messages")) return "Claude";
  if (route.includes("/v1/chat")) return "OpenAI";
  if (route.includes("/v1beta/models") || route.includes("/v1/models")) return "Gemini";
  return "-";
}

function modelFromRoute(route) {
  const match = route.match(/models\/([^:?\s]+)/);
  if (match) return match[1];
  if (route.includes("/v1/messages")) return "claude-sonnet-4-6";
  if (route.includes("/v1/chat")) return "gemini-2.5-pro";
  return "-";
}

function tokenTotal(tokens) {
  if (!tokens) return 0;
  const input = Number(tokens.input ?? 0);
  const output = Number(tokens.output ?? 0);
  const total = Number(tokens.total ?? input + output);
  return Number.isFinite(total) ? total : input + output;
}

function textFromContent(content) {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          return part.text || part.content || part.input || "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    return content.text || content.value || "";
  }
  return String(content);
}

function summarizeTrafficResponse(response, formatTrafficPayload) {
  if (response === undefined || response === null) return "-";
  if (typeof response === "string") {
    return response.length > 800 ? `${response.slice(0, 800)}…` : response;
  }
  if (Array.isArray(response)) {
    return formatTrafficPayload(response);
  }
  if (typeof response === "object") {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const output = Array.isArray(response.output) ? response.output : [];
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    const text =
      choices.map((choice) => textFromContent(choice?.message?.content)).filter(Boolean).join("\n") ||
      output.map((item) => textFromContent(item?.content)).filter(Boolean).join("\n") ||
      candidates.map((candidate) => textFromContent(candidate?.content?.parts || candidate?.content)).filter(Boolean).join("\n");
    if (text) {
      return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
    }
  }
  return formatTrafficPayload(response);
}

export function normalizeTrafficRecord(record, formatTrafficPayload) {
  const request = record?.requestBody;
  if (!request || typeof request !== "object") {
    return {
      system: "-",
      prompt: "-",
      tools: "-",
      thinking: "-",
      responseSummary: "-"
    };
  }

  const messages = Array.isArray(request.messages) ? request.messages : [];
  const contents = Array.isArray(request.contents) ? request.contents : [];
  const inputMessages = Array.isArray(request.input) ? request.input : [];
  const systemParts = [];
  const promptParts = [];

  for (const message of messages) {
    const text = textFromContent(message?.content);
    if (!text) continue;
    if (message.role === "system") {
      systemParts.push(text);
      continue;
    }
    if (message.role === "user") {
      promptParts.push(text);
    }
  }

  for (const content of contents) {
    if (!content || typeof content !== "object") continue;
    if (content.role === "system") {
      const text = textFromContent(content.parts);
      if (text) systemParts.push(text);
      continue;
    }
    if (content.role === "user" || content.role === "model") {
      const text = textFromContent(content.parts);
      if (text && content.role === "user") {
        promptParts.push(text);
      }
    }
  }

  for (const item of inputMessages) {
    const text = textFromContent(item?.content);
    if (text && item?.role === "user") {
      promptParts.push(text);
    }
  }

  const system = request.systemInstruction
    ? textFromContent(request.systemInstruction.parts || request.systemInstruction)
    : request.system
      ? textFromContent(request.system)
      : systemParts.join("\n\n");
  const prompt = request.prompt
    ? textFromContent(request.prompt)
    : promptParts.join("\n\n") || textFromContent(request.input);
  const tools = request.tools ? formatTrafficPayload(request.tools) : request.toolChoice ? formatTrafficPayload(request.toolChoice) : "-";
  const thinking = request.thinkingConfig || request.thinking || request.reasoning || request.generationConfig?.thinkingConfig
    ? formatTrafficPayload(
        request.thinkingConfig ||
          request.thinking ||
          request.reasoning ||
          request.generationConfig?.thinkingConfig
      )
    : "-";

  return {
    system: system || "-",
    prompt: prompt || "-",
    tools,
    thinking,
    responseSummary: summarizeTrafficResponse(record?.responseBody, formatTrafficPayload)
  };
}

export function selectTrafficRows(metrics) {
  return (metrics?.recentRequests || []).length
    ? [...metrics.recentRequests]
    : (metrics?.recentErrors || []).map((item) => ({
        at: item.at,
        method: item.route?.split(" ")[0] || "POST",
        route: item.route || "-",
        provider: protocolFromRoute(item.route || ""),
        model: modelFromRoute(item.route || ""),
        account: "-",
        statusCode: item.statusCode,
        durationMs: 0,
        tokens: undefined
      }));
}

export function selectTrafficView(metrics, options = {}) {
  const visibleColumns = mergeTrafficColumns(options.visibleColumns);
  const filter = String(options.filter || "").toLowerCase();
  const statusFilter = String(options.statusFilter || "all");
  const minTokens = Number(options.minTokens ?? 0);
  const startAt = options.startAt ? new Date(options.startAt).getTime() : undefined;
  const endAt = options.endAt ? new Date(options.endAt).getTime() : undefined;
  const rows = selectTrafficRows(metrics);

  const filteredRows = rows.filter((row) => {
    const status = Number(row.statusCode);
    const rowTime = row.at ? new Date(row.at).getTime() : undefined;
    const totalTokens = tokenTotal(row.tokens);
    if (statusFilter === "success" && status >= 400) return false;
    if (statusFilter === "error" && status < 400) return false;
    if (Number.isFinite(minTokens) && totalTokens < minTokens) return false;
    if (startAt !== undefined && rowTime !== undefined && rowTime < startAt) return false;
    if (endAt !== undefined && rowTime !== undefined && rowTime > endAt) return false;
    if (!filter) return true;
    return `${row.statusCode} ${row.method} ${row.model} ${row.provider} ${row.account || ""} ${row.route}`.toLowerCase().includes(filter);
  });

  const visible = TRAFFIC_COLUMNS.filter((column) => visibleColumns[column.key] !== false);
  const total = filteredRows.length;
  const failed = filteredRows.filter((row) => Number(row.statusCode) >= 400).length;

  return {
    rows,
    filteredRows,
    visibleColumns,
    visible,
    total,
    failed,
    success: Math.max(0, total - failed)
  };
}
