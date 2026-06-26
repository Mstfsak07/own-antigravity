import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { classifyError, classifyStatus } from "../errors.js";
import { filteredRequestHeaders, jsonBody, pipeUpstream, requireKey } from "../http.js";
import { estimateTrafficTokens } from "../metrics.js";
import type { Runtime } from "../runtime.js";
import { providerErrorPayload } from "./adapter.js";
import { callCloudCodeWithFailover } from "./cloudCodeFailover.js";
import { resolveCloudCodeModelForAccount } from "../cloudCode/accounts.js";
import { tryNativeLs } from "./native.js";
import { openAIStreamChunk, openAIStreamDoneChunk, readableFromOpenAIStream } from "./openaiStream.js";
import { resolveRequestUserAgent } from "../requestUserAgent.js";
import { optimizeOpenAIRequest, readResponseCache, writeResponseCache } from "../tokenPolicy.js";

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: string | { url?: string } }>;
};

type OpenAIChatRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  input?: string | OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
};

type RoutedOpenAIProvider =
  | "gemini"
  | "zai"
  | "anthropic"
  | "openai"
  | "groq"
  | "cerebras"
  | "ollama"
  | "mistral";

type CompatibleProviderName = "groq" | "cerebras" | "ollama" | "mistral";

function bearerToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/^Bearer\s+/i, "");
}

type GeminiTextPart = { text: string };
type GeminiInlineImagePart = { inlineData: { mimeType: string; data: string } };
type GeminiRequestPart = GeminiTextPart | GeminiInlineImagePart;

function dataUrlImagePart(value: string): GeminiInlineImagePart | undefined {
  const match = value.match(/^data:(.+?);base64,(.+)$/i);
  if (!match) {
    return undefined;
  }
  return {
    inlineData: {
      mimeType: match[1] ?? "image/png",
      data: match[2] ?? ""
    }
  };
}

function contentParts(content: OpenAIMessage["content"]): GeminiRequestPart[] {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }

  const parts: GeminiRequestPart[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      parts.push({ text: part.text });
      continue;
    }

    if (part.type === "image_url") {
      const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (imageUrl) {
        const imagePart = dataUrlImagePart(imageUrl);
        if (imagePart) {
          parts.push(imagePart);
        }
      }
    }
  }
  return parts;
}

function providerForModel(model: string): RoutedOpenAIProvider {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("groq/")) {
    return "groq";
  }
  if (normalized.startsWith("cerebras/")) {
    return "cerebras";
  }
  if (normalized.startsWith("ollama/")) {
    return "ollama";
  }
  if (normalized.startsWith("mistral/")) {
    return "mistral";
  }
  if (isOfficialOpenAIModel(normalized)) {
    return "openai";
  }
  if (normalized.startsWith("glm")) {
    return "zai";
  }
  if (normalized.startsWith("claude")) {
    return "anthropic";
  }
  return "gemini";
}

function upstreamModelForProvider(model: string): string {
  return model.replace(/^(groq|cerebras|ollama|mistral)\//i, "");
}

function isOfficialOpenAIModel(model: string): boolean {
  return model.startsWith("gpt-") || model.startsWith("chatgpt-") || /^o\d/.test(model);
}

function resolveOpenAIModel(runtime: Runtime, requestedModel: string | undefined): string {
  if (!requestedModel) {
    return runtime.openaiKeys.hasKeys() ? runtime.config.openai.defaultModel : runtime.resolveModel(runtime.config.gemini.defaultModel);
  }

  if (runtime.config.modelAliases[requestedModel]) {
    return runtime.resolveModel(requestedModel);
  }

  if (runtime.openaiKeys.hasKeys() && isOfficialOpenAIModel(requestedModel.toLowerCase())) {
    return requestedModel;
  }

  return runtime.resolveModel(requestedModel);
}

function compatibleProviderConfig(runtime: Runtime, provider: CompatibleProviderName) {
  switch (provider) {
    case "groq":
      return {
        enabled: runtime.config.groq.enabled,
        baseUrl: runtime.config.groq.baseUrl,
        apiKey: runtime.config.groq.apiKey,
        keyPool: runtime.groqKeys,
        label: "Groq",
        requiresAuth: true
      };
    case "cerebras":
      return {
        enabled: runtime.config.cerebras.enabled,
        baseUrl: runtime.config.cerebras.baseUrl,
        apiKey: runtime.config.cerebras.apiKey,
        keyPool: runtime.cerebrasKeys,
        label: "Cerebras",
        requiresAuth: true
      };
    case "ollama":
      return {
        enabled: runtime.config.ollama.enabled,
        baseUrl: runtime.config.ollama.baseUrl,
        apiKey: runtime.config.ollama.apiKey,
        keyPool: runtime.ollamaKeys,
        label: "Ollama",
        requiresAuth: false
      };
    case "mistral":
      return {
        enabled: runtime.config.mistral.enabled,
        baseUrl: runtime.config.mistral.baseUrl,
        apiKey: runtime.config.mistral.apiKey,
        keyPool: runtime.mistralKeys,
        label: "Mistral",
        requiresAuth: true
      };
  }
}

function openAIText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (!item || typeof item !== "object") {
          return "";
        }
        const record = item as { type?: string; text?: string };
        return record.type?.includes("text") ? (record.text ?? "") : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function usageFromOpenAIResponse(data: any) {
  return {
    input: Number(data?.usage?.prompt_tokens ?? data?.usage?.input_tokens ?? 0),
    output: Number(data?.usage?.completion_tokens ?? data?.usage?.output_tokens ?? 0),
    total: Number(data?.usage?.total_tokens ?? 0)
  };
}

export function toGeminiRequest(input: OpenAIChatRequest) {
  const systemParts: Array<{ text: string }> = [];
  const contents = (input.messages ?? [])
    .map((message) => {
      const parts = contentParts(message.content);
      if (parts.length === 0) {
        return undefined;
      }

      if (message.role === "system") {
        systemParts.push(
          ...parts
            .filter((part): part is GeminiTextPart => "text" in part)
            .map((part) => ({ text: part.text }))
        );
        return undefined;
      }

      return {
        role: message.role === "assistant" ? "model" : "user",
        parts
      };
    })
    .filter((message): message is { role: "user" | "model"; parts: GeminiRequestPart[] } => Boolean(message));

  return {
    contents,
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
    generationConfig: {
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.max_tokens !== undefined ? { maxOutputTokens: input.max_tokens } : {})
    }
  };
}

function extractGeminiText(response: any): string {
  return (
    response?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text ?? "")
      .join("") ?? ""
  );
}

function usageFromGeminiResponse(data: any) {
  return {
    input: Number(data?.usageMetadata?.promptTokenCount ?? 0),
    output: Number(data?.usageMetadata?.candidatesTokenCount ?? 0),
    total: Number(data?.usageMetadata?.totalTokenCount ?? 0)
  };
}

function openAIActorLabel(hasLease: boolean): string | undefined {
  return hasLease ? "Gemini API key" : undefined;
}

function cloudCodeActorLabel(account?: { email?: string; displayName?: string; id?: string }): string | undefined {
  return account?.email || account?.displayName || account?.id;
}

function isLocalOpenAIRequest(runtime: Runtime, request: FastifyRequest): boolean {
  const candidate =
    bearerToken(request.headers.authorization) ??
    request.headers["x-api-key"]?.toString() ??
    request.headers["x-goog-api-key"]?.toString();
  return Boolean(runtime.config.localApiKey && candidate === runtime.config.localApiKey);
}

function cloudCodeRequestBody(body: OpenAIChatRequest, model: string, projectId: string | undefined, userAgent: string) {
  const wrapped: Record<string, unknown> = {
    requestId: `agent-${crypto.randomUUID()}`,
    request: toGeminiRequest(body),
    model,
    userAgent: resolveRequestUserAgent(userAgent),
    requestType: "generate-content"
  };

  if (projectId?.trim()) {
    wrapped.project = projectId.trim();
  }

  return wrapped;
}

function extractGeminiPayload(data: any) {
  return data?.response ?? data;
}

function openAIChatResponse(data: any, model: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: now,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: extractGeminiText(data)
        },
        finish_reason: data?.candidates?.[0]?.finishReason ?? "stop"
      }
    ],
    usage: {
      prompt_tokens: data?.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data?.usageMetadata?.totalTokenCount ?? 0
    }
  };
}

function openAIResponsesResponse(data: any, model: string) {
  return {
    id: `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: [
      {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: extractGeminiText(data) }]
      }
    ],
    usage: {
      input_tokens: data?.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data?.usageMetadata?.totalTokenCount ?? 0
    }
  };
}

function openAIResponsesFromChatResponse(data: any, model: string) {
  return {
    id: `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: [
      {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: openAIText(data?.choices?.[0]?.message?.content) }]
      }
    ],
    usage: {
      input_tokens: data?.usage?.prompt_tokens ?? 0,
      output_tokens: data?.usage?.completion_tokens ?? 0,
      total_tokens: data?.usage?.total_tokens ?? 0
    }
  };
}

async function proxyCompatibleProvider(
  request: FastifyRequest<{ Body: OpenAIChatRequest }>,
  reply: FastifyReply,
  runtime: Runtime,
  provider: CompatibleProviderName,
  model: string,
  body: OpenAIChatRequest,
  route: "chat" | "responses"
): Promise<void> {
  const config = compatibleProviderConfig(runtime, provider);
  if (!config.enabled) {
    reply.status(503).send({
      error: {
        message: `${config.label} provider is disabled`,
        type: "invalid_config",
        provider
      }
    });
    return;
  }

  const upstreamModel = upstreamModelForProvider(model);
  const lease = config.keyPool.next();
  const key = config.requiresAuth ? requireKey(lease?.value ?? config.apiKey, config.label) : (lease?.value ?? config.apiKey ?? "ollama");
  const startedAt = Date.now();
  const upstreamBody =
    route === "responses"
      ? {
          model: upstreamModel,
          messages: Array.isArray(body.messages)
            ? body.messages
            : Array.isArray(body.input)
              ? body.input
              : [{ role: "user", content: String(body.input ?? "") }],
          temperature: body.temperature,
          max_tokens: body.max_tokens
        }
      : { ...body, model: upstreamModel };

  let upstream: Response;
  try {
    runtime.metrics.setActiveProvider(provider);
    const headers = filteredRequestHeaders(request.headers, {
      "content-type": "application/json",
      ...(config.requiresAuth ? { authorization: `Bearer ${key}` } : {})
    });
    if (!config.requiresAuth) {
      headers.delete("authorization");
    }
    upstream = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: jsonBody(upstreamBody)
    });
  } catch (error) {
    if (lease) {
      config.keyPool.reportFailure(lease.id, classifyError(error));
    }
    runtime.metrics.recordProviderRequest(provider, false);
    const mapped = providerErrorPayload(provider, error);
    reply.status(mapped.statusCode).send(mapped.body);
    return;
  }

  runtime.metrics.recordProviderRequest(provider, upstream.ok);
  if (lease) {
    if (upstream.ok) {
      config.keyPool.reportSuccess(lease.id);
    } else {
      config.keyPool.reportFailure(lease.id, classifyStatus(upstream.status));
    }
  }

  if (route === "chat" && body.stream) {
    runtime.metrics.recordProviderTraffic({
      actor: config.requiresAuth ? `${config.label} API key` : config.label,
      method: request.method,
      route: request.url,
      provider,
      model,
      resolvedModel: upstreamModel,
      account: config.requiresAuth ? `${config.label} API key` : config.label,
      statusCode: upstream.status,
      startedAt,
      tokens: estimateTrafficTokens(upstreamBody, { stream: true, model: upstreamModel, status: upstream.status }),
      requestBody: upstreamBody,
      responseBody: { stream: true, model: upstreamModel, status: upstream.status }
    });
    await pipeUpstream(reply, upstream);
    return;
  }

  const data = await upstream.json().catch(async () => ({ error: await upstream.text() }));
  runtime.metrics.recordProviderTraffic({
    actor: config.requiresAuth ? `${config.label} API key` : config.label,
    method: request.method,
    route: request.url,
    provider,
    model,
    resolvedModel: upstreamModel,
    account: config.requiresAuth ? `${config.label} API key` : config.label,
    statusCode: upstream.status,
    startedAt,
    tokens: usageFromOpenAIResponse(data),
    requestBody: upstreamBody,
    responseBody: data,
    errorBody: upstream.ok ? undefined : data
  });

  if (!upstream.ok) {
    reply.status(upstream.status).send(data);
    return;
  }

  if (route === "responses") {
    reply.send(openAIResponsesFromChatResponse(data, upstreamModel));
    return;
  }

  reply.send(data);
}

async function proxyZaiOpenAI(
  request: FastifyRequest<{ Body: OpenAIChatRequest }>,
  reply: FastifyReply,
  runtime: Runtime,
  model: string,
  body: OpenAIChatRequest,
  route: "chat" | "responses"
): Promise<void> {
  if (!runtime.config.zai.enabled) {
    reply.status(503).send({
      error: {
        message: "z.ai provider is disabled",
        type: "invalid_config",
        provider: "zai"
      }
    });
    return;
  }

  const lease = runtime.zaiKeys.next();
  const key = requireKey(lease?.value ?? runtime.config.zai.apiKey, "z.ai");
  const startedAt = Date.now();
  const upstreamUrl = `${runtime.config.zai.baseUrl}/chat/completions`;
  const upstreamBody =
    route === "responses"
      ? {
          model,
          messages: Array.isArray(body.messages)
            ? body.messages
            : Array.isArray(body.input)
              ? body.input
              : [{ role: "user", content: String(body.input ?? "") }],
          temperature: body.temperature,
          max_tokens: body.max_tokens
        }
      : { ...body, model };

  let upstream: Response;
  try {
    runtime.metrics.setActiveProvider("zai");
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: filteredRequestHeaders(request.headers, {
        "content-type": "application/json",
        authorization: `Bearer ${key}`
      }),
      body: jsonBody(upstreamBody)
    });
  } catch (error) {
    if (lease) {
      runtime.zaiKeys.reportFailure(lease.id, classifyError(error));
    }
    runtime.metrics.recordProviderRequest("zai", false);
    const mapped = providerErrorPayload("zai", error);
    reply.status(mapped.statusCode).send(mapped.body);
    return;
  }

  runtime.metrics.recordProviderRequest("zai", upstream.ok);
  if (lease) {
    if (upstream.ok) {
      runtime.zaiKeys.reportSuccess(lease.id);
    } else {
      runtime.zaiKeys.reportFailure(lease.id, classifyStatus(upstream.status));
    }
  }

  if (route === "chat" && body.stream) {
    runtime.metrics.recordProviderTraffic({
      actor: lease ? "z.ai API key" : undefined,
      method: request.method,
      route: request.url,
      provider: "zai",
      model,
      resolvedModel: model,
      account: lease ? "z.ai API key" : undefined,
      statusCode: upstream.status,
      startedAt,
      tokens: estimateTrafficTokens(upstreamBody, { stream: true, model, status: upstream.status }),
      requestBody: upstreamBody,
      responseBody: { stream: true, model, status: upstream.status }
    });
    await pipeUpstream(reply, upstream);
    return;
  }

  const data = await upstream.json().catch(async () => ({ error: await upstream.text() }));
  runtime.metrics.recordProviderTraffic({
    actor: lease ? "z.ai API key" : undefined,
    method: request.method,
    route: request.url,
    provider: "zai",
    model,
    resolvedModel: model,
    account: lease ? "z.ai API key" : undefined,
    statusCode: upstream.status,
    startedAt,
    tokens: usageFromOpenAIResponse(data),
    requestBody: upstreamBody,
    responseBody: data,
    errorBody: upstream.ok ? undefined : data
  });

  if (!upstream.ok) {
    reply.status(upstream.status).send(data);
    return;
  }

  if (route === "responses") {
    reply.send(openAIResponsesFromChatResponse(data, model));
    return;
  }

  reply.send(data);
}

async function proxyOfficialOpenAI(
  request: FastifyRequest<{ Body: OpenAIChatRequest }>,
  reply: FastifyReply,
  runtime: Runtime,
  model: string,
  body: OpenAIChatRequest,
  route: "chat" | "responses"
): Promise<void> {
  const lease = runtime.openaiKeys.next();
  const key = requireKey(lease?.value ?? runtime.config.openai.apiKey, "OpenAI");
  const startedAt = Date.now();
  const upstreamPath = route === "chat" ? "/v1/chat/completions" : "/v1/responses";
  const upstreamBody = { ...body, model };

  let upstream: Response;
  try {
    runtime.metrics.setActiveProvider("openai");
    upstream = await fetch(`${runtime.config.openai.baseUrl}${upstreamPath}`, {
      method: "POST",
      headers: filteredRequestHeaders(request.headers, {
        "content-type": "application/json",
        authorization: `Bearer ${key}`
      }),
      body: jsonBody(upstreamBody)
    });
  } catch (error) {
    if (lease) {
      runtime.openaiKeys.reportFailure(lease.id, classifyError(error));
    }
    runtime.metrics.recordProviderRequest("openai", false);
    const mapped = providerErrorPayload("openai", error);
    reply.status(mapped.statusCode).send(mapped.body);
    return;
  }

  runtime.metrics.recordProviderRequest("openai", upstream.ok);
  if (lease) {
    if (upstream.ok) {
      runtime.openaiKeys.reportSuccess(lease.id);
    } else {
      runtime.openaiKeys.reportFailure(lease.id, classifyStatus(upstream.status));
    }
  }

  if (route === "chat" && body.stream) {
    runtime.metrics.recordProviderTraffic({
      actor: lease ? "OpenAI API key" : undefined,
      method: request.method,
      route: request.url,
      provider: "openai",
      model,
      resolvedModel: model,
      account: lease ? "OpenAI API key" : undefined,
      statusCode: upstream.status,
      startedAt,
      tokens: estimateTrafficTokens(upstreamBody, { stream: true, model, status: upstream.status }),
      requestBody: upstreamBody,
      responseBody: { stream: true, model, status: upstream.status }
    });
    await pipeUpstream(reply, upstream);
    return;
  }

  const data = await upstream.json().catch(async () => ({ error: await upstream.text() }));
  runtime.metrics.recordProviderTraffic({
    actor: lease ? "OpenAI API key" : undefined,
    method: request.method,
    route: request.url,
    provider: "openai",
    model,
    resolvedModel: model,
    account: lease ? "OpenAI API key" : undefined,
    statusCode: upstream.status,
    startedAt,
    tokens: usageFromOpenAIResponse(data),
    requestBody: upstreamBody,
    responseBody: data,
    errorBody: upstream.ok ? undefined : data
  });

  reply.status(upstream.status).send(data);
}

async function tryCloudCodeOpenAI(
  request: FastifyRequest<{ Body: OpenAIChatRequest }>,
  reply: FastifyReply,
  runtime: Runtime,
  model: string,
  requestBody: OpenAIChatRequest,
  route: "chat" | "responses"
): Promise<boolean> {
  if (!isLocalOpenAIRequest(runtime, request) || !runtime.cloudCodeAccounts.hasAccounts()) {
    return false;
  }

  const startedAt = Date.now();
  if (!requestBody.stream) {
    const cached = readResponseCache(`openai:${route}:cloudcode:${runtime.config.dataDir}`, model, requestBody);
    if (cached) {
      reply.send(cached);
      return true;
    }
  }
  const relay = await callCloudCodeWithFailover({
    runtime,
    model,
    method: "generateContent",
    maxAttempts: 4,
    buildBody: (account) =>
      cloudCodeRequestBody(
        requestBody,
        resolveCloudCodeModelForAccount(account, model),
        account.projectId,
        runtime.config.cloudCode.userAgent
      )
  });

  if (!relay.ok && !relay.response && !relay.error) {
    return false;
  }

  if (!relay.ok && relay.error) {
    const mapped = providerErrorPayload("cloudCode", relay.error);
    reply.status(mapped.statusCode).send(mapped.body);
    return true;
  }
  if (!relay.response || !relay.account || !relay.requestBody) {
    return false;
  }

  const account = relay.account;
  const cloudCodeBody = relay.requestBody;
  const upstream = relay.response;

  const data = await upstream.json().catch(async () => ({ error: await upstream.text() }));
  const geminiData = extractGeminiPayload(data);
  runtime.metrics.recordProviderTraffic({
    actor: cloudCodeActorLabel(account),
    method: request.method,
    route: request.url,
    provider: "cloudCode",
    model,
    resolvedModel: model,
    account: cloudCodeActorLabel(account),
    statusCode: upstream.status,
    startedAt,
    tokens: usageFromGeminiResponse(data),
    requestBody: cloudCodeBody,
    responseBody: data,
    errorBody: upstream.ok ? undefined : data
  });

  if (!upstream.ok) {
    reply.status(upstream.status).send(data);
    return true;
  }

  if (route === "chat" && requestBody.stream) {
    const id = `chatcmpl_${crypto.randomUUID()}`;
    const text = extractGeminiText(geminiData);
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
    return reply.send(
      Readable.from([
        `data: ${JSON.stringify(openAIStreamChunk(id, model, text))}\n\n`,
        `data: ${JSON.stringify(openAIStreamDoneChunk(id, model))}\n\n`,
        "data: [DONE]\n\n"
      ])
    );
  }

  if (route === "chat") {
    const responseBody = openAIChatResponse(geminiData, model);
    writeResponseCache(`openai:chat:cloudcode:${runtime.config.dataDir}`, model, requestBody, responseBody);
    reply.send(responseBody);
    return true;
  }

  const responseBody = openAIResponsesResponse(geminiData, model);
  writeResponseCache(`openai:responses:cloudcode:${runtime.config.dataDir}`, model, requestBody, responseBody);
  reply.send(responseBody);
  return true;
}

export function registerOpenAIRoutes(app: FastifyInstance, runtime: Runtime): void {
  const { config } = runtime;

  app.post<{ Body: OpenAIChatRequest }>("/v1/chat/completions", async (request, reply) => {
    const requestedModel = request.body?.model;
    const initialModel = resolveOpenAIModel(runtime, requestedModel);
    const policy = optimizeOpenAIRequest(request.body ?? {}, initialModel);
    const model = policy.model;
    const body = policy.body;
    const provider = providerForModel(model);
    const handled = await tryNativeLs(runtime, reply, request, model, "openai", body, Boolean(body.stream));
    if (handled) {
      return;
    }
    if (provider === "zai") {
      await proxyZaiOpenAI(request, reply, runtime, model, body, "chat");
      return;
    }
    if (provider === "openai") {
      await proxyOfficialOpenAI(request, reply, runtime, model, body, "chat");
      return;
    }
    if (provider === "groq" || provider === "cerebras" || provider === "ollama" || provider === "mistral") {
      await proxyCompatibleProvider(request, reply, runtime, provider, model, body, "chat");
      return;
    }
    if (await tryCloudCodeOpenAI(request, reply, runtime, model, body, "chat")) {
      return;
    }
    if (provider === "anthropic") {
      return reply.status(400).send({
        error: {
          message: "Claude targets on the OpenAI route require CloudCode or the Anthropic endpoint",
          type: "invalid_config",
          provider: "anthropic"
        }
      });
    }
    const action = body.stream ? "streamGenerateContent" : "generateContent";
    const url = new URL(`${config.gemini.baseUrl}/v1beta/models/${model}:${action}`);
    const lease = runtime.geminiKeys.next();
    url.searchParams.set("key", requireKey(lease?.value, "Gemini"));
    if (body.stream) {
      url.searchParams.set("alt", "sse");
    }
    const startedAt = Date.now();
    if (!body.stream) {
      const cached = readResponseCache(`openai:chat:gemini:${runtime.config.dataDir}:${runtime.config.gemini.baseUrl}`, model, body);
      if (cached) {
        return reply.send(cached);
      }
    }

    let upstream: Response;
    try {
      runtime.metrics.setActiveProvider("gemini");
      upstream = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toGeminiRequest(body))
      });
    } catch (error) {
      if (lease) {
        runtime.geminiKeys.reportFailure(lease.id, classifyError(error));
      }
      runtime.metrics.recordProviderRequest("gemini", false);
      const mapped = providerErrorPayload("gemini", error);
      return reply.status(mapped.statusCode).send(mapped.body);
    }

    runtime.metrics.recordProviderRequest("gemini", upstream.ok);
    if (lease) {
      if (upstream.ok) {
        runtime.geminiKeys.reportSuccess(lease.id);
      } else {
        runtime.geminiKeys.reportFailure(lease.id, classifyStatus(upstream.status));
      }
    }

    if (body.stream) {
      if (!upstream.ok) {
        const data = await upstream.json();
        runtime.metrics.recordProviderTraffic({
          actor: openAIActorLabel(Boolean(lease)),
          method: request.method,
          route: request.url,
          provider: "gemini",
          model,
          resolvedModel: model,
          account: openAIActorLabel(Boolean(lease)),
          statusCode: upstream.status,
          startedAt,
          tokens: usageFromGeminiResponse(data),
          requestBody: body,
          responseBody: data,
          errorBody: data
        });
        return reply.status(upstream.status).send(data);
      }

      const id = `chatcmpl_${crypto.randomUUID()}`;
      runtime.metrics.recordProviderTraffic({
        actor: openAIActorLabel(Boolean(lease)),
        method: request.method,
        route: request.url,
        provider: "gemini",
        model,
        resolvedModel: model,
        account: openAIActorLabel(Boolean(lease)),
        statusCode: upstream.status,
        startedAt,
        tokens: estimateTrafficTokens(body, { stream: true, model, status: upstream.status }),
        requestBody: body,
        responseBody: { stream: true, model, status: upstream.status }
      });
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      reply.header("connection", "keep-alive");
      return reply.send(readableFromOpenAIStream(upstream, id, model));
    }

    const data = await upstream.json();
    if (!upstream.ok) {
      runtime.metrics.recordProviderTraffic({
        actor: openAIActorLabel(Boolean(lease)),
        method: request.method,
        route: request.url,
        provider: "gemini",
        model,
        resolvedModel: model,
        account: openAIActorLabel(Boolean(lease)),
        statusCode: upstream.status,
        startedAt,
        tokens: usageFromGeminiResponse(data),
        requestBody: body,
        responseBody: data,
        errorBody: data
      });
      return reply.status(upstream.status).send(data);
    }

    runtime.metrics.recordProviderTraffic({
      actor: openAIActorLabel(Boolean(lease)),
      method: request.method,
      route: request.url,
      provider: "gemini",
      model,
      resolvedModel: model,
      account: openAIActorLabel(Boolean(lease)),
      statusCode: upstream.status,
      startedAt,
      tokens: usageFromGeminiResponse(data),
      requestBody: body,
      responseBody: data
    });
    const responseBody = openAIChatResponse(data, model);
    writeResponseCache(`openai:chat:gemini:${runtime.config.dataDir}:${runtime.config.gemini.baseUrl}`, model, body, responseBody);
    return responseBody;
  });

  app.post<{ Body: OpenAIChatRequest }>("/v1/responses", async (request, reply) => {
    const messages = Array.isArray(request.body?.input)
      ? request.body.input
      : [{ role: "user" as const, content: String(request.body?.input ?? "") }];
    const chatRequest = { ...request.body, messages };
    const requestedModel = chatRequest.model;
    const initialModel = resolveOpenAIModel(runtime, requestedModel);
    const policy = optimizeOpenAIRequest(chatRequest, initialModel);
    const model = policy.model;
    const body = policy.body;
    const provider = providerForModel(model);
    const handled = await tryNativeLs(runtime, reply, request, model, "responses", body, Boolean(body.stream));
    if (handled) {
      return;
    }
    if (provider === "zai") {
      await proxyZaiOpenAI(request, reply, runtime, model, body, "responses");
      return;
    }
    if (provider === "openai") {
      await proxyOfficialOpenAI(request, reply, runtime, model, request.body ?? {}, "responses");
      return;
    }
    if (provider === "groq" || provider === "cerebras" || provider === "ollama" || provider === "mistral") {
      await proxyCompatibleProvider(request, reply, runtime, provider, body.model || model, body, "responses");
      return;
    }
    if (await tryCloudCodeOpenAI(request, reply, runtime, model, body, "responses")) {
      return;
    }
    if (provider === "anthropic") {
      return reply.status(400).send({
        error: {
          message: "Claude targets on the OpenAI route require CloudCode or the Anthropic endpoint",
          type: "invalid_config",
          provider: "anthropic"
        }
      });
    }
    const url = new URL(`${config.gemini.baseUrl}/v1beta/models/${model}:generateContent`);
    const lease = runtime.geminiKeys.next();
    url.searchParams.set("key", requireKey(lease?.value, "Gemini"));
    const startedAt = Date.now();
    const cached = readResponseCache(`openai:responses:gemini:${runtime.config.dataDir}:${runtime.config.gemini.baseUrl}`, model, body);
    if (cached) {
      return reply.send(cached);
    }

    let upstream: Response;
    try {
      runtime.metrics.setActiveProvider("gemini");
      upstream = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toGeminiRequest(body))
      });
    } catch (error) {
      if (lease) {
        runtime.geminiKeys.reportFailure(lease.id, classifyError(error));
      }
      runtime.metrics.recordProviderRequest("gemini", false);
      const mapped = providerErrorPayload("gemini", error);
      return reply.status(mapped.statusCode).send(mapped.body);
    }

    runtime.metrics.recordProviderRequest("gemini", upstream.ok);
    if (lease) {
      if (upstream.ok) {
        runtime.geminiKeys.reportSuccess(lease.id);
      } else {
        runtime.geminiKeys.reportFailure(lease.id, classifyStatus(upstream.status));
      }
    }

    const data = await upstream.json();
    if (!upstream.ok) {
      runtime.metrics.recordProviderTraffic({
        actor: openAIActorLabel(Boolean(lease)),
        method: request.method,
        route: request.url,
        provider: "gemini",
        model,
        resolvedModel: model,
        account: openAIActorLabel(Boolean(lease)),
        statusCode: upstream.status,
        startedAt,
        tokens: usageFromGeminiResponse(data),
        requestBody: body,
        responseBody: data,
        errorBody: data
      });
      return reply.status(upstream.status).send(data);
    }

    const id = `resp_${crypto.randomUUID()}`;
    runtime.metrics.recordProviderTraffic({
      actor: openAIActorLabel(Boolean(lease)),
      method: request.method,
      route: request.url,
      provider: "gemini",
      model,
      resolvedModel: model,
      account: openAIActorLabel(Boolean(lease)),
      statusCode: upstream.status,
      startedAt,
      tokens: estimateTrafficTokens(body, {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model,
        status: "completed"
      }),
      requestBody: body,
      responseBody: {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model,
        status: "completed",
        usage: {
          input_tokens: data?.usageMetadata?.promptTokenCount ?? 0,
          output_tokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
          total_tokens: data?.usageMetadata?.totalTokenCount ?? 0
        }
      }
    });
    const responseBody = openAIResponsesResponse(data, model);
    writeResponseCache(`openai:responses:gemini:${runtime.config.dataDir}:${runtime.config.gemini.baseUrl}`, model, body, responseBody);
    return responseBody;
  });
}
