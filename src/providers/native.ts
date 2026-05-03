import type { FastifyReply, FastifyRequest } from "fastify";
import { estimateTrafficTokens } from "../metrics.js";
import type { Runtime } from "../runtime.js";
import type { NativeFormat } from "../ls/nativeClient.js";

export async function tryNativeLs(
  runtime: Runtime,
  reply: FastifyReply,
  request: FastifyRequest,
  model: string,
  format: NativeFormat,
  body: unknown,
  stream = false
): Promise<boolean> {
  if (!runtime.config.ls.nativeEnabled) {
    return false;
  }
  const startedAt = Date.now();
  try {
    const result = await runtime.nativeLsClient.request(
      model,
      format,
      body,
      stream,
      (request.raw as { signal?: AbortSignal }).signal
    );
    reply.header("x-own-ag-native-ls", "true");
    if (result.sse) {
      runtime.metrics.recordProviderTraffic({
        actor: result.accountLabel,
        method: request.method,
        route: request.url,
        provider: "native",
        model,
        resolvedModel: model,
        account: result.accountLabel,
        statusCode: 200,
        startedAt,
        tokens: { input: 0, output: 0, total: 0 },
        requestBody: body,
        responseBody: { stream: true },
        errorBody: undefined
      });
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      await reply.send(result.sse);
      return true;
    }
    const maybeUsage = typeof result.data === "object" && result.data && "usage" in (result.data as Record<string, unknown>)
      ? (result.data as Record<string, any>).usage
      : undefined;
    runtime.metrics.recordProviderTraffic({
      actor: result.accountLabel,
      method: request.method,
      route: request.url,
      provider: "native",
      model,
      resolvedModel: model,
      account: result.accountLabel,
      statusCode: 200,
      startedAt,
      tokens: maybeUsage
        ? {
            input: Number(maybeUsage.input_tokens ?? maybeUsage.prompt_tokens ?? 0),
            output: Number(maybeUsage.output_tokens ?? maybeUsage.completion_tokens ?? 0),
            total: Number(maybeUsage.total_tokens ?? 0)
          }
        : estimateTrafficTokens(body, result.data),
      requestBody: body,
      responseBody: result.data,
      errorBody: undefined
    });
    await reply.send(result.data);
    return true;
  } catch (error) {
    runtime.metrics.recordProviderTraffic({
      actor: "native-fallback",
      event: "fallback",
      method: request.method,
      route: request.url,
      provider: "native",
      model,
      resolvedModel: model,
      statusCode: 500,
      startedAt,
      tokens: estimateTrafficTokens(body, error instanceof Error ? { message: error.message } : String(error)),
      requestBody: body,
      errorBody: error instanceof Error ? { message: error.message } : String(error)
    });
    if (!runtime.config.ls.providerFallback) {
      throw error;
    }
    runtime.metrics.recordFallback();
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "native_error";
    reply.header("x-own-ag-fallback", "provider");
    reply.header("x-own-ag-native-error", code.replace(/[^A-Za-z0-9_-]/g, "_"));
    return false;
  }
}
