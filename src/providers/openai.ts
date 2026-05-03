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

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string }>;
};

type OpenAIChatRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  input?: string | OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
};

type RoutedOpenAIProvider = "gemini" | "zai" | "anthropic";

function bearerToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/^Bearer\s+/i, "");
}

function textContent(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

function providerForModel(model: string): RoutedOpenAIProvider {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("glm")) {
    return "zai";
  }
  if (normalized.startsWith("claude")) {
    return "anthropic";
  }
  return "gemini";
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
    input: Number(data?.usage?.prompt_tokens ?? 0),
    output: Number(data?.usage?.completion_tokens ?? 0),
    total: Number(data?.usage?.total_tokens ?? 0)
  };
}

export function toGeminiRequest(input: OpenAIChatRequest) {
  const systemParts: Array<{ text: string }> = [];
  const contents = (input.messages ?? [])
    .map((message) => {
      const text = textContent(message.content);
      if (!text) {
        return undefined;
      }

      if (message.role === "system") {
        systemParts.push({ text });
        return undefined;
      }

      return {
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text }]
      };
    })
    .filter((message): message is { role: "user" | "model"; parts: Array<{ text: string }> } => Boolean(message));

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

async function tryCloudCodeOpenAI(
  request: FastifyRequest<{ Body: OpenAIChatRequest }>,
  reply: FastifyReply,
  runtime: Runtime,
  model: string,
  route: "chat" | "responses"
): Promise<boolean> {
  if (!isLocalOpenAIRequest(runtime, request) || !runtime.cloudCodeAccounts.hasAccounts()) {
    return false;
  }

  const startedAt = Date.now();
  const relay = await callCloudCodeWithFailover({
    runtime,
    model,
    method: "generateContent",
    maxAttempts: 4,
    buildBody: (account) =>
      cloudCodeRequestBody(
        request.body ?? {},
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
  const body = relay.requestBody;
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
    requestBody: body,
    responseBody: data,
    errorBody: upstream.ok ? undefined : data
  });

  if (!upstream.ok) {
    reply.status(upstream.status).send(data);
    return true;
  }

  if (route === "chat" && request.body?.stream) {
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
    reply.send(openAIChatResponse(geminiData, model));
    return true;
  }

  reply.send(openAIResponsesResponse(geminiData, model));
  return true;
}

export function registerOpenAIRoutes(app: FastifyInstance, runtime: Runtime): void {
  const { config } = runtime;

  app.post<{ Body: OpenAIChatRequest }>("/v1/chat/completions", async (request, reply) => {
    const requestedModel = request.body?.model ?? config.gemini.defaultModel;
    const model = runtime.resolveModel(requestedModel);
    const provider = providerForModel(model);
    const handled = await tryNativeLs(runtime, reply, request, model, "openai", request.body, Boolean(request.body?.stream));
    if (handled) {
      return;
    }
    if (provider === "zai") {
      await proxyZaiOpenAI(request, reply, runtime, model, request.body ?? {}, "chat");
      return;
    }
    if (await tryCloudCodeOpenAI(request, reply, runtime, model, "chat")) {
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
    const action = request.body?.stream ? "streamGenerateContent" : "generateContent";
    const url = new URL(`${config.gemini.baseUrl}/v1beta/models/${model}:${action}`);
    const lease = runtime.geminiKeys.next();
    url.searchParams.set("key", requireKey(lease?.value, "Gemini"));
    if (request.body?.stream) {
      url.searchParams.set("alt", "sse");
    }
    const startedAt = Date.now();

    let upstream: Response;
    try {
      runtime.metrics.setActiveProvider("gemini");
      upstream = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toGeminiRequest(request.body ?? {}))
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

    if (request.body?.stream) {
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
          requestBody: request.body,
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
        tokens: estimateTrafficTokens(request.body, { stream: true, model, status: upstream.status }),
        requestBody: request.body,
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
        requestBody: request.body,
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
      requestBody: request.body,
      responseBody: data
    });
    return openAIChatResponse(data, model);
  });

  app.post<{ Body: OpenAIChatRequest }>("/v1/responses", async (request, reply) => {
    const messages = Array.isArray(request.body?.input)
      ? request.body.input
      : [{ role: "user" as const, content: String(request.body?.input ?? "") }];
    const chatRequest = { ...request.body, messages };
    const requestedModel = chatRequest.model ?? config.gemini.defaultModel;
    const model = runtime.resolveModel(requestedModel);
    const provider = providerForModel(model);
    const handled = await tryNativeLs(runtime, reply, request, model, "responses", chatRequest, Boolean(request.body?.stream));
    if (handled) {
      return;
    }
    if (provider === "zai") {
      await proxyZaiOpenAI(request, reply, runtime, model, chatRequest, "responses");
      return;
    }
    if (await tryCloudCodeOpenAI(request, reply, runtime, model, "responses")) {
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

    let upstream: Response;
    try {
      runtime.metrics.setActiveProvider("gemini");
      upstream = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toGeminiRequest(chatRequest))
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
        requestBody: request.body,
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
      tokens: estimateTrafficTokens(request.body, {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model,
        status: "completed"
      }),
      requestBody: request.body,
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
    return openAIResponsesResponse(data, model);
  });
}
