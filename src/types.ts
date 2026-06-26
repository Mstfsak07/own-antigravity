export type ProxyConfig = {
  port: number;
  host: string;
  localApiKey?: string;
  modelAliases: Record<string, string>;
  dataDir: string;
  ls: {
    enabled: boolean;
    nativeEnabled: boolean;
    providerFallback: boolean;
    binDir: string;
    lsCorePath?: string;
    certPath?: string;
    provisionMode: "Auto" | "LocalOnly" | "ForceRemote";
    remoteManifestUrl?: string;
    remoteExpectedSha256?: string;
    instanceTtlSeconds: number;
    maxInstances: number;
    requestTimeoutMs: number;
    transport: "stdio" | "grpc" | "http" | "websocket";
    initMethod?: string;
    requestMethod?: string;
    streamMethod?: string;
    endpoint?: string;
    protoPath?: string;
    serviceName?: string;
    methodName?: string;
    workingDirectory?: string;
    extraArgs: string[];
    tokenServerHost: string;
    tokenServerPort: number;
  };
  cloudCode: {
    enabled: boolean;
    accountsDir: string;
    baseUrls: string[];
    userAgent: string;
    sendUserProjectHeader: boolean;
    preserveAvailabilityOnError: boolean;
    refreshSkewSeconds: number;
    quarantineSeconds: number;
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthEnabled: boolean;
    oauthRedirectUri: string;
    oauthScopes: string[];
    oauthAuthorizationUrl: string;
    oauthUserInfoUrl: string;
    tokenEncryptionKey?: string;
    tokenUrl: string;
  };
  gemini: {
    apiKey?: string;
    apiKeys: string[];
    baseUrl: string;
    defaultModel: string;
  };
  anthropic: {
    apiKey?: string;
    apiKeys: string[];
    baseUrl: string;
    version: string;
  };
  openai: {
    apiKey?: string;
    apiKeys: string[];
    baseUrl: string;
    defaultModel: string;
  };
  groq: {
    enabled: boolean;
    apiKey?: string;
    apiKeys: string[];
    baseUrl: string;
    defaultModel: string;
  };
  cerebras: {
    enabled: boolean;
    apiKey?: string;
    apiKeys: string[];
    baseUrl: string;
    defaultModel: string;
  };
  ollama: {
    enabled: boolean;
    apiKey?: string;
    apiKeys: string[];
    baseUrl: string;
    defaultModel: string;
  };
  mistral: {
    enabled: boolean;
    apiKey?: string;
    apiKeys: string[];
    baseUrl: string;
    defaultModel: string;
  };
  zai: {
    enabled: boolean;
    apiKey?: string;
    apiKeys: string[];
    baseUrl: string;
    defaultModel: string;
  };
  mcp: {
    enabled: boolean;
    exposeViaProxy: boolean;
    requestTimeoutMs: number;
    servers: Array<{
      id: string;
      enabled: boolean;
      transport: "stdio" | "http" | "sse";
      command?: string;
      args: string[];
      url?: string;
      workingDirectory?: string;
      env: Record<string, string>;
    }>;
  };
};

export type ProviderName =
  | "gemini"
  | "anthropic"
  | "openai"
  | "groq"
  | "cerebras"
  | "ollama"
  | "mistral"
  | "zai";

export type ErrorClass =
  | "auth_error"
  | "rate_limit"
  | "network_error"
  | "provider_error"
  | "invalid_config"
  | "timeout";

export type HealthState = {
  healthy: boolean;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  consecutiveFailures: number;
  disabledReason?: ErrorClass | string;
  nextRetryAt?: string;
};

export type StoredAccount = {
  id: string;
  email?: string;
  name?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  oauthClientId?: string;
  projectId?: string;
  supportedModels: string[];
  scopes?: string[];
  quota?: unknown;
  status?: string;
  source?: "imported_json" | "oauth_login" | "manual_refresh_token";
  health: HealthState;
  createdAt?: string;
  updatedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  nextRetryAt?: string;
};

export type CloudCodeAccount = {
  id: string;
  filePath?: string;
  source: "imported_json" | "oauth_login" | "manual_refresh_token";
  email?: string;
  displayName?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  oauthClientId?: string;
  projectId?: string;
  scopes?: string[];
  disabled: boolean;
  health: HealthState;
  quotaModels: Array<{
    name: string;
    displayName?: string;
    percentage?: number;
    resetTime?: string;
  }>;
};
