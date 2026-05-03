import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ProxyConfig } from "./types.js";

const ConfigSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    host: z.string().optional(),
    localApiKey: z.string().optional(),
    modelAliases: z.record(z.string()).optional(),
    dataDir: z.string().optional(),
    ls: z
      .object({
        enabled: z.boolean().optional(),
        nativeEnabled: z.boolean().optional(),
        providerFallback: z.boolean().optional(),
        binDir: z.string().optional(),
        lsCorePath: z.string().optional(),
        certPath: z.string().optional(),
        provisionMode: z.enum(["Auto", "LocalOnly", "ForceRemote"]).optional(),
        remoteManifestUrl: z.string().optional(),
        remoteExpectedSha256: z.string().optional(),
        instanceTtlSeconds: z.number().int().positive().optional(),
        maxInstances: z.number().int().positive().optional(),
        requestTimeoutMs: z.number().int().positive().optional(),
        transport: z.enum(["stdio", "grpc", "http", "websocket"]).optional(),
        initMethod: z.string().optional(),
        requestMethod: z.string().optional(),
        streamMethod: z.string().optional(),
        endpoint: z.string().optional(),
        protoPath: z.string().optional(),
        serviceName: z.string().optional(),
        methodName: z.string().optional(),
        workingDirectory: z.string().optional(),
        extraArgs: z.array(z.string()).optional(),
        tokenServerHost: z.string().optional(),
        tokenServerPort: z.number().int().min(0).max(65535).optional()
      })
      .optional(),
    cloudCode: z
      .object({
        enabled: z.boolean().optional(),
        accountsDir: z.string().optional(),
        baseUrls: z.array(z.string()).optional(),
        userAgent: z.string().optional(),
        sendUserProjectHeader: z.boolean().optional(),
        preserveAvailabilityOnError: z.boolean().optional(),
        refreshSkewSeconds: z.number().int().positive().optional(),
        quarantineSeconds: z.number().int().positive().optional(),
        oauthEnabled: z.boolean().optional(),
        oauthClientId: z.string().optional(),
        oauthClientSecret: z.string().optional(),
        oauthRedirectUri: z.string().optional(),
        oauthScopes: z.array(z.string()).optional(),
        oauthAuthorizationUrl: z.string().optional(),
        oauthUserInfoUrl: z.string().optional(),
        tokenEncryptionKey: z.string().optional(),
        tokenUrl: z.string().optional()
      })
      .optional(),
    gemini: z
      .object({
        apiKey: z.string().optional(),
        apiKeys: z.array(z.string()).optional(),
        baseUrl: z.string().optional(),
        defaultModel: z.string().optional()
      })
      .optional(),
    anthropic: z
      .object({
        apiKey: z.string().optional(),
        apiKeys: z.array(z.string()).optional(),
        baseUrl: z.string().optional(),
        version: z.string().optional()
      })
      .optional(),
    zai: z
      .object({
        enabled: z.boolean().optional(),
        apiKey: z.string().optional(),
        apiKeys: z.array(z.string()).optional(),
        baseUrl: z.string().optional(),
        defaultModel: z.string().optional()
      })
      .optional(),
    mcp: z
      .object({
        enabled: z.boolean().optional(),
        exposeViaProxy: z.boolean().optional(),
        requestTimeoutMs: z.number().int().positive().optional(),
        servers: z
          .array(
            z.object({
              id: z.string(),
              enabled: z.boolean().optional(),
              transport: z.enum(["stdio", "http", "sse"]).optional(),
              command: z.string().optional(),
              args: z.array(z.string()).optional(),
              url: z.string().optional(),
              workingDirectory: z.string().optional(),
              env: z.record(z.string()).optional()
            })
          )
          .optional()
      })
      .optional()
  })
  .optional();

export const configPath = join(homedir(), ".own-antigravity", "config.json");

export function readJsonConfig(): z.infer<typeof ConfigSchema> {
  if (!existsSync(configPath)) {
    return undefined;
  }

  const raw = readFileSync(configPath, "utf8");
  return ConfigSchema.parse(JSON.parse(raw));
}

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function envJsonList(name: string): string[] {
  const value = process.env[name];
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : envList(name);
  } catch {
    return envList(name);
  }
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envEnum<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = process.env[name];
  return values.includes(value as T) ? (value as T) : fallback;
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function loadConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  const fileConfig = readJsonConfig();
  const geminiApiKey =
    process.env.OWN_AG_GEMINI_API_KEY ??
    fileConfig?.gemini?.apiKey;
  const anthropicApiKey =
    process.env.OWN_AG_ANTHROPIC_API_KEY ??
    fileConfig?.anthropic?.apiKey;
  const zaiApiKey =
    process.env.OWN_AG_ZAI_API_KEY ??
    fileConfig?.zai?.apiKey;

  const config: ProxyConfig = {
    port: envInt("OWN_AG_PORT", fileConfig?.port ?? 8046),
    host: process.env.OWN_AG_HOST ?? fileConfig?.host ?? "127.0.0.1",
    localApiKey: process.env.OWN_AG_API_KEY ?? fileConfig?.localApiKey,
    dataDir:
      process.env.OWN_AG_DATA_DIR ??
      fileConfig?.dataDir ??
      join(homedir(), ".own-antigravity"),
    modelAliases: {
      "gpt-4o": "gemini-2.5-pro",
      "gpt-4.1": "gemini-2.5-pro",
      "gpt-5": "gemini-2.5-pro",
      "gemini-latest": "gemini-2.5-pro",
      "gemini-pro-latest": "gemini-2.5-pro",
      "gemini-flash-latest": "gemini-2.5-flash",
      "gemini-2.5-pro-latest": "gemini-2.5-pro",
      "gemini-2.5-flash-latest": "gemini-2.5-flash",
      "gemini-2.5-flash-lite-latest": "gemini-2.5-flash-lite",
      "gemini-2.5-flash-image-latest": "gemini-2.5-flash-image",
      "claude-haiku": "claude-haiku-4-5",
      "claude-haiku-4-5": "claude-haiku-4-5",
      "claude-sonnet-4-5": "claude-sonnet-4-5",
      ...(fileConfig?.modelAliases ?? {})
    },
    ls: {
      enabled: envBool("OWN_AG_LS_ENABLED", fileConfig?.ls?.enabled ?? true),
      nativeEnabled: envBool(
        "OWN_AG_NATIVE_LS_ENABLED",
        fileConfig?.ls?.nativeEnabled ?? fileConfig?.ls?.enabled ?? false
      ),
      providerFallback: envBool("OWN_AG_PROVIDER_FALLBACK", fileConfig?.ls?.providerFallback ?? true),
      binDir:
        process.env.OWN_AG_LS_BIN_DIR ??
        fileConfig?.ls?.binDir ??
        join(homedir(), ".own-antigravity", "bin"),
      lsCorePath: process.env.OWN_AG_LS_CORE_PATH ?? fileConfig?.ls?.lsCorePath,
      certPath: process.env.OWN_AG_CERT_PATH ?? process.env.OWN_AG_LS_CERT_PATH ?? fileConfig?.ls?.certPath,
      provisionMode: envEnum(
        "OWN_AG_LS_PROVISION_MODE",
        ["Auto", "LocalOnly", "ForceRemote"] as const,
        fileConfig?.ls?.provisionMode ?? "Auto"
      ),
      remoteManifestUrl: process.env.OWN_AG_LS_REMOTE_MANIFEST_URL ?? fileConfig?.ls?.remoteManifestUrl,
      remoteExpectedSha256:
        process.env.OWN_AG_LS_REMOTE_EXPECTED_SHA256 ?? fileConfig?.ls?.remoteExpectedSha256,
      instanceTtlSeconds: envInt("OWN_AG_LS_INSTANCE_TTL_SECONDS", fileConfig?.ls?.instanceTtlSeconds ?? 1800),
      maxInstances: envInt("OWN_AG_LS_MAX_INSTANCES", fileConfig?.ls?.maxInstances ?? 3),
      requestTimeoutMs: envInt("OWN_AG_LS_REQUEST_TIMEOUT_MS", fileConfig?.ls?.requestTimeoutMs ?? 30000),
      transport: envEnum("OWN_AG_LS_TRANSPORT", ["stdio", "grpc", "http", "websocket"] as const, fileConfig?.ls?.transport ?? "stdio"),
      initMethod: process.env.OWN_AG_LS_INIT_METHOD ?? fileConfig?.ls?.initMethod,
      requestMethod: process.env.OWN_AG_LS_REQUEST_METHOD ?? fileConfig?.ls?.requestMethod,
      streamMethod: process.env.OWN_AG_LS_STREAM_METHOD ?? fileConfig?.ls?.streamMethod,
      endpoint: process.env.OWN_AG_LS_ENDPOINT ?? fileConfig?.ls?.endpoint,
      protoPath: process.env.OWN_AG_LS_PROTO_PATH ?? fileConfig?.ls?.protoPath,
      serviceName: process.env.OWN_AG_LS_SERVICE_NAME ?? fileConfig?.ls?.serviceName,
      methodName: process.env.OWN_AG_LS_METHOD_NAME ?? fileConfig?.ls?.methodName,
      workingDirectory: process.env.OWN_AG_LS_WORKDIR ?? fileConfig?.ls?.workingDirectory,
      extraArgs: uniqueValues([...envJsonList("OWN_AG_LS_EXTRA_ARGS"), ...(fileConfig?.ls?.extraArgs ?? [])]),
      tokenServerHost:
        process.env.OWN_AG_LS_TOKEN_SERVER_HOST ??
        fileConfig?.ls?.tokenServerHost ??
        "127.0.0.1",
      tokenServerPort: envInt("OWN_AG_LS_TOKEN_SERVER_PORT", fileConfig?.ls?.tokenServerPort ?? 0)
    },
    cloudCode: {
      enabled: envBool("OWN_AG_CLOUDCODE_ENABLED", fileConfig?.cloudCode?.enabled ?? true),
      accountsDir:
        process.env.OWN_AG_CLOUDCODE_ACCOUNTS_DIR ??
        fileConfig?.cloudCode?.accountsDir ??
        join(homedir(), ".antigravity_tools", "accounts"),
      baseUrls: uniqueValues([
        ...envList("OWN_AG_CLOUDCODE_BASE_URLS"),
        ...(fileConfig?.cloudCode?.baseUrls ?? []),
        "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal",
        "https://daily-cloudcode-pa.googleapis.com/v1internal",
        "https://cloudcode-pa.googleapis.com/v1internal"
      ]),
      userAgent:
        process.env.OWN_AG_CLOUDCODE_USER_AGENT ??
        fileConfig?.cloudCode?.userAgent ??
        "antigravity",
      sendUserProjectHeader: envBool(
        "OWN_AG_CLOUDCODE_SEND_USER_PROJECT_HEADER",
        fileConfig?.cloudCode?.sendUserProjectHeader ?? false
      ),
      preserveAvailabilityOnError: envBool(
        "OWN_AG_CLOUDCODE_PRESERVE_AVAILABILITY_ON_ERROR",
        fileConfig?.cloudCode?.preserveAvailabilityOnError ?? true
      ),
      refreshSkewSeconds: envInt(
        "OWN_AG_CLOUDCODE_REFRESH_SKEW_SECONDS",
        fileConfig?.cloudCode?.refreshSkewSeconds ?? 120
      ),
      quarantineSeconds: envInt(
        "OWN_AG_CLOUDCODE_QUARANTINE_SECONDS",
        fileConfig?.cloudCode?.quarantineSeconds ?? 300
      ),
      oauthClientId:
        process.env.OWN_AG_GOOGLE_CLIENT_ID ??
        process.env.OWN_AG_GOOGLE_OAUTH_CLIENT_ID ??
        fileConfig?.cloudCode?.oauthClientId,
      oauthClientSecret:
        process.env.OWN_AG_GOOGLE_CLIENT_SECRET ??
        process.env.OWN_AG_GOOGLE_OAUTH_CLIENT_SECRET ??
        fileConfig?.cloudCode?.oauthClientSecret,
      oauthEnabled: envBool("OWN_AG_GOOGLE_OAUTH_ENABLED", fileConfig?.cloudCode?.oauthEnabled ?? false),
      oauthRedirectUri:
        process.env.OWN_AG_GOOGLE_REDIRECT_URI ??
        fileConfig?.cloudCode?.oauthRedirectUri ??
        `http://127.0.0.1:${envInt("OWN_AG_PORT", fileConfig?.port ?? 8046)}/auth/google/callback`,
      oauthScopes: uniqueValues([
        ...envList("OWN_AG_GOOGLE_SCOPES"),
        ...(fileConfig?.cloudCode?.oauthScopes ?? []),
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/cloud-platform"
      ]),
      oauthAuthorizationUrl:
        process.env.OWN_AG_GOOGLE_OAUTH_AUTH_URL ??
        fileConfig?.cloudCode?.oauthAuthorizationUrl ??
        "https://accounts.google.com/o/oauth2/v2/auth",
      oauthUserInfoUrl:
        process.env.OWN_AG_GOOGLE_OAUTH_USERINFO_URL ??
        fileConfig?.cloudCode?.oauthUserInfoUrl ??
        "https://openidconnect.googleapis.com/v1/userinfo",
      tokenEncryptionKey:
        process.env.OWN_AG_TOKEN_ENCRYPTION_KEY ?? fileConfig?.cloudCode?.tokenEncryptionKey,
      tokenUrl:
        process.env.OWN_AG_GOOGLE_OAUTH_TOKEN_URL ??
        fileConfig?.cloudCode?.tokenUrl ??
        "https://oauth2.googleapis.com/token"
    },
    gemini: {
      apiKey: geminiApiKey,
      apiKeys: uniqueValues([...envList("OWN_AG_GEMINI_API_KEYS"), ...(fileConfig?.gemini?.apiKeys ?? []), geminiApiKey]),
      baseUrl: cleanBaseUrl(
        process.env.GEMINI_BASE_URL ??
          fileConfig?.gemini?.baseUrl ??
          "https://generativelanguage.googleapis.com"
      ),
      defaultModel:
        process.env.GEMINI_DEFAULT_MODEL ??
        fileConfig?.gemini?.defaultModel ??
        "gemini-2.5-pro"
    },
    anthropic: {
      apiKey: anthropicApiKey,
      apiKeys: uniqueValues([
        ...envList("OWN_AG_ANTHROPIC_API_KEYS"),
        ...(fileConfig?.anthropic?.apiKeys ?? []),
        anthropicApiKey
      ]),
      baseUrl: cleanBaseUrl(
        process.env.ANTHROPIC_BASE_URL ??
          fileConfig?.anthropic?.baseUrl ??
          "https://api.anthropic.com"
      ),
      version:
        process.env.ANTHROPIC_VERSION ??
        fileConfig?.anthropic?.version ??
        "2023-06-01"
    },
    zai: {
      enabled: envBool("OWN_AG_ZAI_ENABLED", fileConfig?.zai?.enabled ?? false),
      apiKey: zaiApiKey,
      apiKeys: uniqueValues([
        ...envList("OWN_AG_ZAI_API_KEYS"),
        ...(fileConfig?.zai?.apiKeys ?? []),
        zaiApiKey
      ]),
      baseUrl: cleanBaseUrl(
        process.env.OWN_AG_ZAI_BASE_URL ??
          fileConfig?.zai?.baseUrl ??
          "https://api.z.ai/api/paas/v4"
      ),
      defaultModel:
        process.env.OWN_AG_ZAI_DEFAULT_MODEL ??
        fileConfig?.zai?.defaultModel ??
        "glm-4.6"
    },
    mcp: {
      enabled: envBool("OWN_AG_MCP_ENABLED", fileConfig?.mcp?.enabled ?? false),
      exposeViaProxy: envBool(
        "OWN_AG_MCP_EXPOSE_VIA_PROXY",
        fileConfig?.mcp?.exposeViaProxy ?? true
      ),
      requestTimeoutMs: envInt(
        "OWN_AG_MCP_REQUEST_TIMEOUT_MS",
        fileConfig?.mcp?.requestTimeoutMs ?? 45000
      ),
      servers: (fileConfig?.mcp?.servers ?? []).map((server, index) => ({
        id: server.id || `server-${index + 1}`,
        enabled: server.enabled ?? true,
        transport: server.transport ?? "stdio",
        command: server.command,
        args: server.args ?? [],
        url: server.url,
        workingDirectory: server.workingDirectory,
        env: server.env ?? {}
      }))
    }
  };

  return {
    ...config,
    ...overrides,
    ls: { ...config.ls, ...overrides.ls },
    cloudCode: { ...config.cloudCode, ...overrides.cloudCode },
    gemini: { ...config.gemini, ...overrides.gemini },
    anthropic: { ...config.anthropic, ...overrides.anthropic },
    zai: { ...config.zai, ...overrides.zai },
    mcp: { ...config.mcp, ...overrides.mcp }
  };
}

export function writeConfigPatch(patch: z.infer<typeof ConfigSchema>): void {
  const current = readJsonConfig() ?? {};
  const next = ConfigSchema.parse({
    ...current,
    ...patch,
    ls: {
      ...(current?.ls ?? {}),
      ...(patch?.ls ?? {})
    },
    cloudCode: {
      ...(current?.cloudCode ?? {}),
      ...(patch?.cloudCode ?? {})
    },
    gemini: {
      ...(current?.gemini ?? {}),
      ...(patch?.gemini ?? {})
    },
    anthropic: {
      ...(current?.anthropic ?? {}),
      ...(patch?.anthropic ?? {})
    },
    zai: {
      ...(current?.zai ?? {}),
      ...(patch?.zai ?? {})
    },
    mcp: {
      ...(current?.mcp ?? {}),
      ...(patch?.mcp ?? {})
    },
    modelAliases: {
      ...(current?.modelAliases ?? {}),
      ...(patch?.modelAliases ?? {})
    }
  });

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function writeDefaultConfig(): boolean {
  if (existsSync(configPath)) {
    return false;
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port: 8046,
        host: "127.0.0.1",
        localApiKey: "change-me",
        dataDir: join(homedir(), ".own-antigravity"),
        ls: {
          enabled: true,
          nativeEnabled: false,
          providerFallback: true,
          binDir: join(homedir(), ".own-antigravity", "bin"),
          lsCorePath: "",
          certPath: "",
          provisionMode: "Auto",
          remoteManifestUrl: "",
          remoteExpectedSha256: "",
          instanceTtlSeconds: 1800,
          maxInstances: 3,
          requestTimeoutMs: 30000,
          transport: "stdio",
          initMethod: "initialize",
          requestMethod: "request",
          streamMethod: "stream",
          endpoint: "",
          protoPath: "",
          serviceName: "",
          methodName: "",
          workingDirectory: "",
          extraArgs: [],
          tokenServerHost: "127.0.0.1",
          tokenServerPort: 0
        },
        cloudCode: {
          enabled: true,
          accountsDir: join(homedir(), ".antigravity_tools", "accounts"),
          baseUrls: [
            "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal",
            "https://daily-cloudcode-pa.googleapis.com/v1internal",
            "https://cloudcode-pa.googleapis.com/v1internal"
          ],
          userAgent: "antigravity",
          sendUserProjectHeader: false,
          preserveAvailabilityOnError: true,
          refreshSkewSeconds: 120,
          quarantineSeconds: 300,
          oauthEnabled: false,
          oauthClientId: "",
          oauthClientSecret: "",
          oauthRedirectUri: "http://127.0.0.1:8046/auth/google/callback",
          oauthScopes: [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/cloud-platform"
          ],
          oauthAuthorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          oauthUserInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
          tokenEncryptionKey: "",
          tokenUrl: "https://oauth2.googleapis.com/token"
        },
        modelAliases: {
          "gpt-4o": "gemini-2.5-pro",
          "gpt-4.1": "gemini-2.5-pro",
          "gpt-5": "gemini-2.5-pro",
          "gemini-latest": "gemini-2.5-pro",
          "gemini-pro-latest": "gemini-2.5-pro",
          "gemini-flash-latest": "gemini-2.5-flash",
          "gemini-2.5-pro-latest": "gemini-2.5-pro",
          "gemini-2.5-flash-latest": "gemini-2.5-flash",
          "gemini-2.5-flash-lite-latest": "gemini-2.5-flash-lite",
          "gemini-2.5-flash-image-latest": "gemini-2.5-flash-image"
          ,
          "claude-haiku": "claude-haiku-4-5",
          "claude-haiku-4-5": "claude-haiku-4-5"
        },
        gemini: {
          apiKey: "",
          apiKeys: [],
          baseUrl: "https://generativelanguage.googleapis.com",
          defaultModel: "gemini-2.5-pro"
        },
        anthropic: {
          apiKey: "",
          apiKeys: [],
          baseUrl: "https://api.anthropic.com",
          version: "2023-06-01"
        },
        zai: {
          enabled: false,
          apiKey: "",
          apiKeys: [],
          baseUrl: "https://api.z.ai/api/paas/v4",
          defaultModel: "glm-4.6"
        },
        mcp: {
          enabled: false,
          exposeViaProxy: true,
          requestTimeoutMs: 45000,
          servers: []
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return true;
}
