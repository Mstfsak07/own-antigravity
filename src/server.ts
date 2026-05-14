import Fastify from "fastify";
import { registerAccountManagementRoutes } from "./auth/accountManagement.js";
import { registerGoogleOAuthRoutes } from "./auth/googleOAuth.js";
import { dashboardHtml } from "./dashboard.js";
import { logger } from "./logger.js";
import { modelCatalog } from "./modelCatalog.js";
import { registerAnthropicRoutes } from "./providers/anthropic.js";
import { registerGeminiRoutes } from "./providers/gemini.js";
import { registerOpenAIRoutes } from "./providers/openai.js";
import { redactSecret, redactSensitiveText } from "./redact.js";
import { createRuntime } from "./runtime.js";
import type { ProxyConfig } from "./types.js";

function bearerToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/^Bearer\s+/i, "");
}

function isAllowedCorsOrigin(origin: string | undefined): boolean {
  return Boolean(
    origin &&
      (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin) ||
        /^chrome-extension:\/\/[a-p]{32}$/i.test(origin))
  );
}

export function buildServer(config: ProxyConfig) {
  const runtime = createRuntime(config);
  const app = Fastify({
    logger: false,
    bodyLimit: 30 * 1024 * 1024
  });

  app.addHook("onClose", async () => {
    runtime.accountRegistry.close();
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    const origin = request.headers.origin;
    if (origin && !isAllowedCorsOrigin(origin)) {
      return reply.status(403).send({
        error: {
          message: "CORS origin is not allowed",
          type: "authentication_error"
        }
      });
    }
    if (isAllowedCorsOrigin(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
    }
    if (request.method === "OPTIONS") {
      reply.header("access-control-allow-origin", origin ?? `http://${config.host}:${config.port}`);
      reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
      reply.header("access-control-allow-headers", "authorization,x-api-key,content-type");
      return reply.status(204).send();
    }
    if (!config.localApiKey || path === "/health" || path === "/auth/google/callback") {
      return;
    }

    const query = request.query as Record<string, string | undefined>;
    const candidate =
      bearerToken(request.headers.authorization) ??
      request.headers["x-api-key"]?.toString() ??
      request.headers["x-goog-api-key"]?.toString() ??
      query.key;

    if (candidate === config.localApiKey) {
      return;
    }

    return reply.status(401).send({
      error: {
        message: "Invalid local proxy API key",
        type: "authentication_error"
      }
    });
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    const safeMessage = redactSensitiveText(error.message);
    logger.error(safeMessage, { statusCode });
    reply.status(statusCode).send({
      error: {
        message: safeMessage,
        type: statusCode >= 500 ? "proxy_error" : "request_error"
      }
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    const origin = request.headers.origin;
    if (isAllowedCorsOrigin(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
    }
    runtime.metrics.record(request.method, request.routeOptions.url ?? request.url, reply.statusCode);
  });

  function providersHealth() {
    return {
      gemini: {
        baseUrl: config.gemini.baseUrl,
        defaultModel: config.gemini.defaultModel,
        keyCount: runtime.geminiKeys.size(),
        active: runtime.geminiKeys.hasKeys(),
        keys: runtime.geminiKeys.snapshot()
      },
      anthropic: {
        baseUrl: config.anthropic.baseUrl,
        version: config.anthropic.version,
        keyCount: runtime.anthropicKeys.size(),
        active: runtime.anthropicKeys.hasKeys(),
        keys: runtime.anthropicKeys.snapshot()
      },
      zai: {
        enabled: config.zai.enabled,
        baseUrl: config.zai.baseUrl,
        defaultModel: config.zai.defaultModel,
        keyCount: runtime.zaiKeys.size(),
        active: config.zai.enabled && runtime.zaiKeys.hasKeys(),
        keys: runtime.zaiKeys.snapshot()
      },
      cloudCode: {
        enabled: config.cloudCode.enabled,
        accountsDir: config.cloudCode.accountsDir,
        accountCount: runtime.cloudCodeAccounts.size(),
        healthyCount: runtime.cloudCodeAccounts.healthyCount(),
        unhealthyCount: runtime.cloudCodeAccounts.unhealthyCount(),
        active: runtime.cloudCodeAccounts.hasAccounts()
      }
    };
  }

  function lsHealth() {
    return {
      provision: runtime.assetProvisioner.status(),
      instances: runtime.lsOrchestrator.list(),
      protocol: {
        active: config.ls.transport,
        initMethod: config.ls.initMethod,
        requestMethod: config.ls.requestMethod,
        streamMethod: config.ls.streamMethod,
        endpoint: config.ls.endpoint,
        streamSupported: Boolean(config.ls.streamMethod)
      },
      tokenServer: runtime.tokenServer.snapshot()
    };
  }

  function accountsHealth() {
    return {
      accounts: runtime.cloudCodeAccounts.list().map((account) => ({
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        projectId: account.projectId,
        source: account.source,
        expiresAt: account.expiresAt,
        modelCount: account.quotaModels.length,
        health: account.health,
        claudeModels: account.quotaModels
          .filter((model) => model.name.toLowerCase().includes("claude"))
          .map((model) => ({
            name: model.name,
            percentage: model.percentage,
            resetTime: model.resetTime
          }))
      }))
    };
  }

  app.get("/health", async () => ({
    status: "ok",
    version: "0.1.0",
    providers: {
      gemini: runtime.geminiKeys.hasKeys(),
      anthropic: runtime.anthropicKeys.hasKeys(),
      cloudCode: runtime.cloudCodeAccounts.hasAccounts()
      ,
      zai: config.zai.enabled && runtime.zaiKeys.hasKeys()
    },
    ls: {
      enabled: config.ls.enabled,
      nativeEnabled: config.ls.nativeEnabled,
      providerFallback: config.ls.providerFallback,
      provisionReady: runtime.assetProvisioner.status().ready,
      activeInstances: runtime.lsOrchestrator.list().length
    }
  }));

  app.get("/health/providers", async () => providersHealth());

  app.get("/health/accounts", async () => accountsHealth());

  app.get("/metrics", async () =>
    runtime.metrics.snapshot({
      healthy: runtime.cloudCodeAccounts.healthyCount(),
      unhealthy: runtime.cloudCodeAccounts.unhealthyCount()
    })
  );

  app.get("/v1/instances", async () => ({
    data: runtime.lsOrchestrator.list()
  }));

  app.post<{ Body: { accountId?: string; model?: string } }>("/v1/instances", async (request, reply) => {
    const model = runtime.resolveModel(request.body?.model);
    const account =
      request.body?.accountId
        ? runtime.cloudCodeAccounts.list().find((item) => item.id === request.body?.accountId)
        : await runtime.cloudCodeAccounts.select(model);
    if (!account) {
      return reply.status(404).send({ error: { message: "No healthy account is available", type: "not_found" } });
    }
    return runtime.lsOrchestrator.startOrReuse(account, model);
  });

  app.delete<{ Params: { id: string } }>("/v1/instances/:id", async (request, reply) => {
    const stopped = runtime.lsOrchestrator.stop(request.params.id);
    if (!stopped) {
      return reply.status(404).send({ error: { message: "Instance not found", type: "not_found" } });
    }
    return { stopped: true };
  });

  app.post<{ Params: { id: string } }>("/v1/instances/:id/restart", async (request) =>
    runtime.lsOrchestrator.restart(request.params.id)
  );

  app.get("/v1/protocol/status", async () => ({
    configured: lsHealth().protocol,
    instances: await runtime.lsOrchestrator.protocolStatus()
  }));

  app.get("/v1/ls/diagnostics", async () => runtime.lsDiagnostics.status());

  app.post<{ Body: { disableFallback?: boolean; timeoutMs?: number } }>("/v1/ls/diagnostics/run", async (request) =>
    runtime.lsDiagnostics.run({
      disableFallback: Boolean(request.body?.disableFallback),
      timeoutMs: request.body?.timeoutMs
    })
  );

  app.post<{ Body: { model?: string; payload?: unknown } }>("/v1/protocol/test", async (request, reply) => {
    const model = runtime.resolveModel(request.body?.model);
    try {
      const result = await runtime.nativeLsClient.request(model, "openai", request.body?.payload ?? { ping: true });
      return { ok: true, instanceId: result.instanceId, data: result.data };
    } catch (error) {
      const message = error instanceof Error ? redactSensitiveText(error.message) : "protocol test failed";
      return reply.status(502).send({ ok: false, error: message });
    }
  });

  app.get("/v1/provision/status", async () => runtime.assetProvisioner.status());

  app.post<{ Body: { mode?: "Auto" | "LocalOnly" | "ForceRemote" } }>("/v1/provision/sync", async (request) =>
    runtime.assetProvisioner.sync(request.body?.mode)
  );

  app.get("/v1/events", async (_request, reply) => {
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    return `event: snapshot\ndata: ${JSON.stringify({
      health: {
        providers: providersHealth(),
        ls: lsHealth()
      },
      metrics: runtime.metrics.snapshot({
        healthy: runtime.cloudCodeAccounts.healthyCount(),
        unhealthy: runtime.cloudCodeAccounts.unhealthyCount()
      })
    })}\n\n`;
  });

  app.get("/", async (_request, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    return dashboardHtml();
  });

  app.get("/admin/status", async () => ({
    status: "ok",
    host: config.host,
    port: config.port,
    localApiKey: redactSecret(config.localApiKey),
    providers: providersHealth(),
    ls: lsHealth(),
    accounts: accountsHealth().accounts,
    modelAliases: config.modelAliases,
    zai: config.zai,
    mcp: config.mcp
  }));

  app.get("/admin/metrics", async () =>
    runtime.metrics.snapshot({
      healthy: runtime.cloudCodeAccounts.healthyCount(),
      unhealthy: runtime.cloudCodeAccounts.unhealthyCount()
    })
  );

  app.get("/v1/models", async () => ({
    object: "list",
    data: modelCatalog(config)
  }));

  registerGeminiRoutes(app, runtime);
  registerAnthropicRoutes(app, runtime);
  registerOpenAIRoutes(app, runtime);
  registerAccountManagementRoutes(app, runtime);
  registerGoogleOAuthRoutes(app, runtime);

  return app;
}

export async function startServer(config: ProxyConfig): Promise<void> {
  const app = buildServer(config);
  await app.listen({ host: config.host, port: config.port });
  logger.info(`Own Antigravity listening on http://${config.host}:${config.port}`);
}
