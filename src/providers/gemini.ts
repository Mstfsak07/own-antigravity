import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { classifyError, classifyStatus } from "../errors.js";
import { filteredRequestHeaders, jsonBody, pipeUpstream, requireKey } from "../http.js";
import { estimateTrafficTokens } from "../metrics.js";
import { geminiModelList } from "../modelCatalog.js";
import type { Runtime } from "../runtime.js";
import { providerErrorPayload } from "./adapter.js";
import { callCloudCodeWithFailover } from "./cloudCodeFailover.js";
import { resolveCloudCodeModelForAccount } from "../cloudCode/accounts.js";
import { tryNativeLs } from "./native.js";
import { resolveRequestUserAgent } from "../requestUserAgent.js";
import { optimizeGeminiRequest, readResponseCache, writeResponseCache } from "../tokenPolicy.js";

type GeminiRouteParams = {
  modelAndAction: string;
};

function bearerToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/^Bearer\s+/i, "");
}

function isAllowedLocalOrigin(origin: string | undefined): boolean {
  return Boolean(
    origin &&
      (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin) ||
        /^chrome-extension:\/\/[a-p]{32}$/i.test(origin))
  );
}

function providerKeyFromRequest(runtime: Runtime, request: FastifyRequest): string | undefined {
  const query = request.query as Record<string, string | undefined>;
  const headerKey = request.headers["x-goog-api-key"]?.toString();
  const authKey = bearerToken(request.headers.authorization);
  const candidate = query.key ?? headerKey ?? authKey;
  if (runtime.config.localApiKey && candidate === runtime.config.localApiKey) {
    return undefined;
  }
  return candidate;
}

function isLocalGeminiRequest(runtime: Runtime, request: FastifyRequest): boolean {
  const query = request.query as Record<string, string | undefined>;
  const headerKey = request.headers["x-goog-api-key"]?.toString();
  const authKey = bearerToken(request.headers.authorization);
  if (!runtime.config.localApiKey) {
    return isAllowedLocalOrigin(request.headers.origin?.toString());
  }
  return Boolean(
    runtime.config.localApiKey &&
      (query.key === runtime.config.localApiKey ||
        headerKey === runtime.config.localApiKey ||
        authKey === runtime.config.localApiKey)
  );
}

function resolveModelAndAction(runtime: Runtime, modelAndAction: string): string {
  const separatorIndex = modelAndAction.lastIndexOf(":");
  if (separatorIndex === -1) {
    return runtime.resolveModel(modelAndAction);
  }

  const model = modelAndAction.slice(0, separatorIndex);
  const action = modelAndAction.slice(separatorIndex);
  return `${runtime.resolveModel(model)}${action}`;
}

function buildGeminiUrl(runtime: Runtime, version: "v1" | "v1beta", modelAndAction: string, request: FastifyRequest, key: string): URL {
  const config = runtime.config;
  const resolvedModelAndAction = resolveModelAndAction(runtime, modelAndAction);
  const url = new URL(`${config.gemini.baseUrl}/${version}/models/${resolvedModelAndAction}`);
  const query = request.query as Record<string, string | string[] | undefined>;

  for (const [key, value] of Object.entries(query)) {
    if (key === "key" || value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
    } else {
      url.searchParams.set(key, value);
    }
  }

  url.searchParams.set("key", key);
  return url;
}

function buildGeminiUrlFromResolved(runtime: Runtime, version: "v1" | "v1beta", modelAndAction: string, request: FastifyRequest, key: string): URL {
  const url = new URL(`${runtime.config.gemini.baseUrl}/${version}/models/${modelAndAction}`);
  const query = request.query as Record<string, string | string[] | undefined>;

  for (const [queryKey, value] of Object.entries(query)) {
    if (queryKey === "key" || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(queryKey, item);
      }
    } else {
      url.searchParams.set(queryKey, value);
    }
  }

  url.searchParams.set("key", key);
  return url;
}

function cloudCodeGeminiBody(body: unknown, model: string, projectId: string | undefined, userAgent: string): Record<string, unknown> {
  const requestBody = body && typeof body === "object" ? body : {};
  const wrapped: Record<string, unknown> = {
    requestId: `agent-${crypto.randomUUID()}`,
    request: requestBody,
    model,
    userAgent: resolveRequestUserAgent(userAgent),
    requestType: "generate-content"
  };

  if (projectId?.trim()) {
    wrapped.project = projectId.trim();
  }

  return wrapped;
}

function usageFromGeminiResponse(data: any) {
  const payload = data?.response ?? data;
  return {
    input: Number(payload?.usageMetadata?.promptTokenCount ?? 0),
    output: Number(payload?.usageMetadata?.candidatesTokenCount ?? 0),
    total: Number(payload?.usageMetadata?.totalTokenCount ?? 0)
  };
}

function accountLabel(account?: { email?: string; displayName?: string; id?: string }): string | undefined {
  return account?.email || account?.displayName || account?.id;
}

async function* streamJsonArrayItems(response: Response): AsyncGenerator<unknown> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let scanIndex = 0;
  let inArray = false;
  let itemStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  const tryEmitItems = function* (): Generator<unknown> {
    while (scanIndex < buffer.length) {
      const char = buffer[scanIndex];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        scanIndex += 1;
        continue;
      }

      if (char === "\"") {
        inString = true;
        scanIndex += 1;
        continue;
      }

      if (!inArray) {
        if (/\s/.test(char)) {
          scanIndex += 1;
          continue;
        }
        if (char === "[") {
          inArray = true;
        }
        scanIndex += 1;
        continue;
      }

      if (itemStart === -1) {
        if (/\s|,/.test(char)) {
          scanIndex += 1;
          continue;
        }
        if (char === "]") {
          scanIndex += 1;
          continue;
        }
        itemStart = scanIndex;
        depth = 1;
        scanIndex += 1;
        continue;
      }

      if (char === "{" || char === "[") {
        depth += 1;
      } else if (char === "}" || char === "]") {
        depth -= 1;
      }
      scanIndex += 1;

      if (depth === 0) {
        const rawItem = buffer.slice(itemStart, scanIndex);
        yield JSON.parse(rawItem);
        buffer = buffer.slice(scanIndex);
        scanIndex = 0;
        itemStart = -1;
        depth = 0;
        inString = false;
        escaped = false;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      yield* tryEmitItems();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    yield* tryEmitItems();
  }
}

function sanitizeGeminiStreamPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const record = structuredClone(payload as Record<string, unknown>);
  if (!Array.isArray(record.candidates)) {
    return record;
  }

  record.candidates = record.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return candidate;
    }
    const nextCandidate = { ...(candidate as Record<string, unknown>) };
    const content = nextCandidate.content;
    if (!content || typeof content !== "object" || !Array.isArray((content as { parts?: unknown[] }).parts)) {
      return nextCandidate;
    }
    const nextContent = { ...(content as Record<string, unknown>) };
    nextContent.parts = (content as { parts: unknown[] }).parts
      .map((part) => {
        if (!part || typeof part !== "object") {
          return part;
        }
        const nextPart = { ...(part as Record<string, unknown>) };
        if (typeof nextPart.text === "string" && nextPart.text.length === 0) {
          delete nextPart.text;
        }
        delete nextPart.thoughtSignature;
        return Object.keys(nextPart).length > 0 ? nextPart : undefined;
      })
      .filter((part) => part !== undefined);
    nextCandidate.content = nextContent;
    return nextCandidate;
  });

  return record;
}

function cloudCodeStreamFrames(data: unknown): string[] {
  const chunks = Array.isArray(data) ? data : [data];
  return chunks
    .map((chunk) => {
      if (!chunk || typeof chunk !== "object") {
        return undefined;
      }
      const payload = sanitizeGeminiStreamPayload((chunk as { response?: unknown }).response ?? chunk);
      return `data: ${JSON.stringify(payload)}\n\n`;
    })
    .filter((frame): frame is string => Boolean(frame));
}

async function* cloudCodeStreamToGeminiSse(response: Response): AsyncGenerator<string> {
  for await (const item of streamJsonArrayItems(response)) {
    const payload = sanitizeGeminiStreamPayload((item as { response?: unknown })?.response ?? item);
    yield `data: ${JSON.stringify(payload)}\n\n`;
  }
}

async function tryCloudCodeGemini(
  request: FastifyRequest<{ Params: GeminiRouteParams }>,
  reply: FastifyReply,
  runtime: Runtime,
  model: string,
  requestBody: unknown
): Promise<boolean> {
  if (!isLocalGeminiRequest(runtime, request) || !runtime.cloudCodeAccounts.hasAccounts()) {
    return false;
  }

  const isStream = request.params.modelAndAction.includes("streamGenerateContent");
  const method = isStream ? "streamGenerateContent" : "generateContent";
  const startedAt = Date.now();
  if (!isStream) {
    const cached = readResponseCache(`gemini:cloudcode:${runtime.config.dataDir}`, model, requestBody);
    if (cached) {
      reply.send(cached);
      return true;
    }
  }
  const relay = await callCloudCodeWithFailover({
    runtime,
    model,
    method,
    maxAttempts: 4,
    buildBody: (account, candidateModel) =>
      cloudCodeGeminiBody(
        requestBody,
        resolveCloudCodeModelForAccount(account, candidateModel),
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

  if (!upstream.ok) {
    const data = await upstream.json().catch(async () => ({ error: await upstream.text() }));
    runtime.metrics.recordProviderTraffic({
      actor: accountLabel(account),
      method: request.method,
      route: request.url,
      provider: "cloudCode",
      model,
      account: accountLabel(account),
      statusCode: upstream.status,
      startedAt,
      tokens: usageFromGeminiResponse(data),
      requestBody: cloudCodeBody,
      responseBody: data,
      errorBody: upstream.ok ? undefined : data
    });
    reply.status(upstream.status).send(data);
    return true;
  }

  if (isStream) {
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
    return reply.send(Readable.from(cloudCodeStreamToGeminiSse(upstream)));
  }

  const data = await upstream.json().catch(async () => ({ error: await upstream.text() }));
  const geminiData = data?.response ?? data;
  runtime.metrics.recordProviderTraffic({
    actor: accountLabel(account),
    method: request.method,
    route: request.url,
    provider: "cloudCode",
    model,
    account: accountLabel(account),
    statusCode: upstream.status,
    startedAt,
    tokens: usageFromGeminiResponse(data),
    requestBody: cloudCodeBody,
    responseBody: data,
    errorBody: upstream.ok ? undefined : data
  });

  writeResponseCache(`gemini:cloudcode:${runtime.config.dataDir}`, model, requestBody, geminiData);
  reply.send(geminiData);
  return true;
}

async function proxyGemini(
  request: FastifyRequest<{ Params: GeminiRouteParams }>,
  reply: FastifyReply,
  runtime: Runtime,
  version: "v1" | "v1beta"
) {
  const separatorIndex = request.params.modelAndAction.lastIndexOf(":");
  const requestedModel =
    separatorIndex === -1 ? request.params.modelAndAction : request.params.modelAndAction.slice(0, separatorIndex);
  const action = separatorIndex === -1 ? "" : request.params.modelAndAction.slice(separatorIndex);
  const policy = optimizeGeminiRequest(request.body, runtime.resolveModel(requestedModel));
  const resolvedModel = policy.model;
  const requestBody = policy.body;
  const handled = await tryNativeLs(
    runtime,
    reply,
    request,
    resolvedModel,
    "gemini",
    requestBody,
    request.params.modelAndAction.includes("stream")
  );
  if (handled) {
    return;
  }
  if (await tryCloudCodeGemini(request, reply, runtime, resolvedModel, requestBody)) {
    return;
  }
  const lease = runtime.geminiKeys.next();
  const key = lease?.value ?? requireKey(providerKeyFromRequest(runtime, request), "Gemini");
  const upstreamUrl = buildGeminiUrlFromResolved(runtime, version, `${resolvedModel}${action}`, request, key);
  const startedAt = Date.now();
  if (!request.params.modelAndAction.includes("stream")) {
    const cached = readResponseCache(`gemini:official:${runtime.config.dataDir}:${runtime.config.gemini.baseUrl}`, resolvedModel, requestBody);
    if (cached) {
      return reply.send(cached);
    }
  }
  let response: Response;
  try {
    runtime.metrics.setActiveProvider("gemini");
    response = await fetch(upstreamUrl, {
      method: "POST",
      headers: filteredRequestHeaders(request.headers, {
        "content-type": "application/json"
      }),
      body: jsonBody(requestBody)
    });
  } catch (error) {
    if (lease) {
      runtime.geminiKeys.reportFailure(lease.id, classifyError(error));
    }
    runtime.metrics.recordProviderRequest("gemini", false);
    const mapped = providerErrorPayload("gemini", error);
    return reply.status(mapped.statusCode).send(mapped.body);
  }

  runtime.metrics.recordProviderRequest("gemini", response.ok);
  if (lease) {
    if (response.ok) {
      runtime.geminiKeys.reportSuccess(lease.id);
    } else {
      runtime.geminiKeys.reportFailure(lease.id, classifyStatus(response.status));
    }
  }

  const responseData = await response.clone().json().catch(() => undefined);
  runtime.metrics.recordProviderTraffic({
    actor: lease ? "Gemini API key" : undefined,
    method: request.method,
    route: request.url,
    provider: "gemini",
    model: resolvedModel,
    account: lease ? "Gemini API key" : undefined,
    statusCode: response.status,
    startedAt,
    tokens: responseData ? usageFromGeminiResponse(responseData) : estimateTrafficTokens(requestBody, responseData),
    requestBody,
    responseBody: responseData,
    errorBody: response.ok ? undefined : responseData
  });

  if (response.ok && responseData && !request.params.modelAndAction.includes("stream")) {
    writeResponseCache(`gemini:official:${runtime.config.dataDir}:${runtime.config.gemini.baseUrl}`, resolvedModel, requestBody, responseData);
  }
  await pipeUpstream(reply, response);
}

export function registerGeminiRoutes(app: FastifyInstance, runtime: Runtime): void {
  const { config } = runtime;

  app.get("/v1beta/models", async () => geminiModelList(config));

  app.post<{ Params: GeminiRouteParams }>("/v1beta/models/:modelAndAction", async (request, reply) => {
    await proxyGemini(request, reply, runtime, "v1beta");
  });

  app.post<{ Params: GeminiRouteParams }>("/v1/models/:modelAndAction", async (request, reply) => {
    await proxyGemini(request, reply, runtime, "v1");
  });
}
