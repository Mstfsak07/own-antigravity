import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { accountSupportsModel, resolveCloudCodeModelForAccount } from "../cloudCode/accounts.js";
import { toClaudeResponse, toCloudCodeRequest, type ClaudeMessagesRequest } from "../cloudCode/mapper.js";
import { readableClaudeStream } from "../cloudCode/stream.js";
import { classifyError, classifyStatus } from "../errors.js";
import { filteredRequestHeaders, jsonBody, pipeUpstream, requireKey } from "../http.js";
import { estimateTrafficTokens } from "../metrics.js";
import type { Runtime } from "../runtime.js";
import { optimizeAnthropicRequest, readResponseCache, writeResponseCache } from "../tokenPolicy.js";
import { providerErrorPayload } from "./adapter.js";
import { callCloudCodeWithFailover } from "./cloudCodeFailover.js";
import { tryNativeLs } from "./native.js";

type AnthropicBody = {
  model?: string;
  [key: string]: unknown;
};

function anthropicHeaders(request: FastifyRequest, runtime: Runtime, key: string): Headers {
  const { config } = runtime;
  return filteredRequestHeaders(request.headers, {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": config.anthropic.version
  });
}

function accountLabel(account?: { email?: string; displayName?: string; id?: string }): string | undefined {
  return account?.email || account?.displayName || account?.id;
}

function usageFromClaudeResponse(data: any) {
  const payload = data?.response ?? data;
  return {
    input: Number(payload?.usageMetadata?.promptTokenCount ?? 0),
    output: Number(payload?.usageMetadata?.candidatesTokenCount ?? 0),
    total: Number(payload?.usageMetadata?.totalTokenCount ?? 0)
  };
}

async function proxyAnthropic(path: string, request: FastifyRequest, reply: FastifyReply, runtime: Runtime) {
  const body = request.body as AnthropicBody | undefined;
  const mappedBody =
    body && typeof body === "object" && body.model
      ? { ...body, model: runtime.resolveModel(body.model) }
      : body;

  const lease = runtime.anthropicKeys.next();
  const key = requireKey(lease?.value, "Anthropic");
  const startedAt = Date.now();
  let response: Response;
  try {
    runtime.metrics.setActiveProvider("anthropic");
    response = await fetch(`${runtime.config.anthropic.baseUrl}${path}`, {
      method: "POST",
      headers: anthropicHeaders(request, runtime, key),
      body: jsonBody(mappedBody)
    });
  } catch (error) {
    if (lease) {
      runtime.anthropicKeys.reportFailure(lease.id, classifyError(error));
    }
    runtime.metrics.recordProviderRequest("anthropic", false);
    const mapped = providerErrorPayload("anthropic", error);
    return reply.status(mapped.statusCode).send(mapped.body);
  }

  runtime.metrics.recordProviderRequest("anthropic", response.ok);
  if (lease) {
    if (response.ok) {
      runtime.anthropicKeys.reportSuccess(lease.id);
    } else {
      runtime.anthropicKeys.reportFailure(lease.id, classifyStatus(response.status));
    }
  }

  const responseData = await response.clone().json().catch(() => undefined);
  runtime.metrics.recordProviderTraffic({
    actor: lease ? "Anthropic API key" : undefined,
    method: request.method,
    route: request.url,
    provider: "anthropic",
    model: String(mappedBody && typeof mappedBody === "object" && "model" in mappedBody ? (mappedBody as AnthropicBody).model ?? "-" : "-"),
    account: lease ? "Anthropic API key" : undefined,
    statusCode: response.status,
    startedAt,
    tokens: responseData ? usageFromClaudeResponse(responseData) : estimateTrafficTokens(mappedBody, responseData),
    requestBody: mappedBody,
    responseBody: responseData,
    errorBody: response.ok ? undefined : responseData
  });

  await pipeUpstream(reply, response);
}

export function registerAnthropicRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.post<{ Body: ClaudeMessagesRequest }>("/v1/messages", async (request, reply) => {
    const body = request.body;
    const requestedModel = body?.model;
    const initialModel = runtime.resolveModel(requestedModel);
    const policy = optimizeAnthropicRequest(body, initialModel);
    const effectiveBody = policy.body;
    const resolvedModel = policy.model;
    if (requestedModel) {
      const handled = await tryNativeLs(runtime, reply, request, resolvedModel, "anthropic", effectiveBody, Boolean(effectiveBody.stream));
      if (handled) {
        return;
      }
    }
    const activeAccount = runtime.activeAccountId
      ? runtime.cloudCodeAccounts.list().find((account) =>
          account.id === runtime.activeAccountId &&
          !account.disabled &&
          account.health.healthy &&
          accountSupportsModel(account, resolvedModel)
        )
      : undefined;
    const cloudCodeAccount = requestedModel
      ? activeAccount ??
        await runtime.cloudCodeAccounts.select(resolvedModel) ??
        runtime.cloudCodeAccounts.list()
          .filter((account) => !account.disabled)
          .filter((account) => account.health.healthy)
          .find((account) => account.quotaModels.some((model) => model.name.startsWith("claude-")))
      : undefined;

    if (cloudCodeAccount) {
      const method = effectiveBody.stream ? "streamGenerateContent" : "generateContent";
      const startedAt = Date.now();
      if (!effectiveBody.stream) {
        const cached = readResponseCache(`anthropic:messages:${runtime.config.dataDir}`, resolvedModel, effectiveBody);
        if (cached) {
          return reply.send(cached);
        }
      }
      const relay = await callCloudCodeWithFailover({
        runtime,
        model: resolvedModel,
        method,
        search: effectiveBody.stream ? "alt=sse" : undefined,
        maxAttempts: activeAccount ? 4 : 5,
        buildBody: (account, candidateModel) => toCloudCodeRequest(effectiveBody, resolveCloudCodeModelForAccount(account, candidateModel), account.projectId, runtime.config.cloudCode.userAgent),
        initialAccount: cloudCodeAccount
      });

      if (!relay.ok && relay.error) {
        const mapped = providerErrorPayload("cloudCode", relay.error);
        runtime.metrics.recordProviderTraffic({
          actor: accountLabel(relay.account),
          method: request.method,
          route: request.url,
          provider: "cloudCode",
          model: resolvedModel,
          account: accountLabel(relay.account),
          statusCode: mapped.statusCode,
          startedAt,
          tokens: estimateTrafficTokens(relay.requestBody, mapped.body),
          requestBody: relay.requestBody,
          errorBody: mapped.body
        });
        return reply.status(mapped.statusCode).send(mapped.body);
      }
      if (!relay.response || !relay.account || !relay.requestBody) {
        return reply.status(503).send({
          error: {
            message: "Cloud Code account is not available",
            type: "invalid_config"
          }
        });
      }

      const selectedAccount = relay.account;
      const cloudCodeBody = relay.requestBody;
      const upstream = relay.response;

      const upstreamData = await upstream.clone().json().catch(() => undefined);
      runtime.metrics.recordProviderTraffic({
        actor: accountLabel(selectedAccount),
        method: request.method,
        route: request.url,
        provider: "cloudCode",
        model: resolvedModel,
        account: accountLabel(selectedAccount),
        statusCode: upstream.status,
        startedAt,
        tokens: upstreamData ? usageFromClaudeResponse(upstreamData) : estimateTrafficTokens(cloudCodeBody, upstreamData),
        requestBody: cloudCodeBody,
        responseBody: upstreamData,
        errorBody: upstream.ok ? undefined : upstreamData
      });

      if (effectiveBody.stream) {
        if (!upstream.ok) {
          const data = await upstream.json().catch(async () => ({ error: await upstream.text() }));
          return reply.status(upstream.status).send(data);
        }

        reply.header("content-type", "text/event-stream; charset=utf-8");
        reply.header("cache-control", "no-cache");
        return reply.send(readableClaudeStream(upstream, effectiveBody, `msg_${crypto.randomUUID().replace(/-/g, "")}`));
      }

      const data = await upstream.json().catch(async () => ({ error: await upstream.text() }));
      if (!upstream.ok) {
        return reply.status(upstream.status).send(data);
      }

      const responseBody = toClaudeResponse({ ...effectiveBody, model: initialModel }, data);
      writeResponseCache(`anthropic:messages:${runtime.config.dataDir}`, resolvedModel, effectiveBody, responseBody);
      return reply.send(responseBody);
    }

    await proxyAnthropic("/v1/messages", request, reply, runtime);
  });

  app.post("/v1/messages/count_tokens", async (request, reply) => {
    await proxyAnthropic("/v1/messages/count_tokens", request, reply, runtime);
  });
}
