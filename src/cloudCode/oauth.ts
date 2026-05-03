import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CloudCodeAccount, ProxyConfig } from "../types.js";

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  token_type?: string;
};

type OAuthClient = {
  clientId: string;
  clientSecret?: string;
};

const builtInOAuthClients: Record<string, OAuthClient> = {
  antigravity_enterprise: {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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"
  }
};

function normalizeClientKey(value: string): string {
  return value.trim().toLowerCase();
}

function configuredOAuthClients(): Record<string, OAuthClient> {
  const clients: Record<string, OAuthClient> = { ...builtInOAuthClients };
  for (const entry of (process.env.ANTIGRAVITY_OAUTH_CLIENTS ?? "").split(";")) {
    const [key, clientId, clientSecret] = entry.split("|").map((value) => value?.trim());
    if (key && clientId) {
      clients[normalizeClientKey(key)] = { clientId, clientSecret };
    }
  }
  return clients;
}

function resolveOAuthClient(config: ProxyConfig, account: CloudCodeAccount): OAuthClient | undefined {
  if (account.oauthClientId) {
    const accountClient = account.oauthClientId.trim();
    const mapped = configuredOAuthClients()[normalizeClientKey(accountClient)];
    if (mapped) {
      return mapped;
    }
    if (accountClient.includes(".apps.googleusercontent.com")) {
      return {
        clientId: accountClient,
        clientSecret: config.cloudCode.oauthClientSecret
      };
    }
  }

  if (config.cloudCode.oauthClientId) {
    return {
      clientId: config.cloudCode.oauthClientId,
      clientSecret: config.cloudCode.oauthClientSecret
    };
  }

  return undefined;
}

export function hasOAuthRefreshConfig(config: ProxyConfig): boolean {
  return Boolean(config.cloudCode.oauthClientId && config.cloudCode.oauthClientSecret);
}

export async function refreshCloudCodeToken(config: ProxyConfig, account: CloudCodeAccount): Promise<CloudCodeAccount> {
  if (!account.refreshToken) {
    throw Object.assign(new Error("Account has no refresh token"), { code: "missing_refresh_token" });
  }
  const oauthClient = resolveOAuthClient(config, account);
  if (!oauthClient) {
    throw Object.assign(new Error("Google OAuth client is not configured"), { code: "missing_oauth_client" });
  }

  const params = new URLSearchParams({
    client_id: oauthClient.clientId,
    refresh_token: account.refreshToken,
    grant_type: "refresh_token"
  });
  if (oauthClient.clientSecret) {
    params.set("client_secret", oauthClient.clientSecret);
  }

  const response = await fetch(config.cloudCode.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params
  });

  if (!response.ok) {
    throw Object.assign(new Error(`Token refresh failed with HTTP ${response.status}`), {
      statusCode: response.status
    });
  }

  const token = (await response.json()) as TokenResponse;
  const expiresAt = token.expires_in
    ? Math.floor(Date.now() / 1000) + token.expires_in
    : account.expiresAt;

  if (account.filePath) {
    updateAccountFile(account.filePath, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? account.refreshToken,
      expiresAt,
      tokenType: token.token_type ?? "Bearer"
    });
  }

  return {
    ...account,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? account.refreshToken,
    expiresAt
  };
}

function updateAccountFile(
  filePath: string,
  token: { accessToken: string; refreshToken?: string; expiresAt?: number; tokenType: string }
): void {
  const json = JSON.parse(readFileSync(filePath, "utf8"));
  json.token = {
    ...(json.token ?? {}),
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_timestamp: token.expiresAt,
    token_type: token.tokenType
  };

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}
