import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import type { CloudCodeAccount, StoredAccount } from "../types.js";
import { accountSummary, publicAccount } from "./accountManagement.js";

type OAuthState = {
  state: string;
  verifier: string;
  createdAt: number;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type UserInfoResponse = {
  email?: string;
  name?: string;
  sub?: string;
};

const states = new Map<string, OAuthState>();
const stateTtlMs = 10 * 60 * 1000;
const BUILT_IN_OAUTH_CLIENT = {
  key: "antigravity_enterprise",
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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"
};
const requiredScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs"
];

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function pruneStates(): void {
  const cutoff = Date.now() - stateTtlMs;
  for (const [state, entry] of states.entries()) {
    if (entry.createdAt < cutoff) {
      states.delete(state);
    }
  }
}

function requireOAuthConfig(runtime: Runtime): string | undefined {
  const config = runtime.config.cloudCode;
  if (!config.oauthEnabled) {
    return "Google OAuth login is disabled";
  }
  if (!config.tokenEncryptionKey) {
    return "OWN_AG_TOKEN_ENCRYPTION_KEY is required for OAuth login";
  }
  const redirect = new URL(config.oauthRedirectUri);
  if (redirect.hostname !== "127.0.0.1") {
    return "Google OAuth redirect URI must use 127.0.0.1 loopback";
  }
  return undefined;
}

function oauthScopes(runtime: Runtime): string[] {
  return [...new Set([...requiredScopes, ...runtime.config.cloudCode.oauthScopes])];
}

function html(message: string): string {
  const escaped = message.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]!);
  return `<!doctype html><meta charset="utf-8"><title>Own Antigravity</title><body><p>${escaped}</p></body>`;
}

function accountId(email: string | undefined, sub: string | undefined): string {
  return `oauth-${createHash("sha256").update(email ?? sub ?? randomBytes(16)).digest("hex").slice(0, 20)}`;
}

function toStored(account: CloudCodeAccount): StoredAccount {
  return {
    id: account.id,
    email: account.email,
    name: account.displayName,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
    oauthClientId: account.oauthClientId,
    projectId: account.projectId,
    supportedModels: [],
    scopes: account.scopes ?? [],
    quota: [],
    status: "active",
    source: "oauth_login",
    health: account.health
  };
}

export function registerGoogleOAuthRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.get("/auth/google/start", async (_request, reply) => {
    const configError = requireOAuthConfig(runtime);
    if (configError) {
      return reply.status(400).send({ error: { message: configError, type: "invalid_config" } });
    }

    pruneStates();
    const state = base64Url(randomBytes(24));
    const { verifier, challenge } = createPkcePair();
    states.set(state, { state, verifier, createdAt: Date.now() });

    const url = new URL(runtime.config.cloudCode.oauthAuthorizationUrl);
    url.searchParams.set("client_id", BUILT_IN_OAUTH_CLIENT.clientId);
    url.searchParams.set("redirect_uri", runtime.config.cloudCode.oauthRedirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", oauthScopes(runtime).join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/google/callback",
    async (request, reply) => {
      const remote = request.socket.remoteAddress;
      if (remote && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
        reply.header("content-type", "text/html; charset=utf-8");
        return reply.status(403).send(html("OAuth callback only accepts loopback requests"));
      }
      const configError = requireOAuthConfig(runtime);
      if (configError) {
        reply.header("content-type", "text/html; charset=utf-8");
        return reply.status(400).send(html(configError));
      }
      if (request.query.error) {
        reply.header("content-type", "text/html; charset=utf-8");
        return reply.status(400).send(html(`Google OAuth error: ${request.query.error}`));
      }
      if (!request.query.code || !request.query.state) {
        reply.header("content-type", "text/html; charset=utf-8");
        return reply.status(400).send(html("Missing OAuth code or state"));
      }

      pruneStates();
      const state = states.get(request.query.state);
      states.delete(request.query.state);
      if (!state) {
        reply.header("content-type", "text/html; charset=utf-8");
        return reply.status(400).send(html("Invalid or expired OAuth state"));
      }

      const params = new URLSearchParams({
        client_id: BUILT_IN_OAUTH_CLIENT.clientId,
        client_secret: BUILT_IN_OAUTH_CLIENT.clientSecret,
        code: request.query.code,
        code_verifier: state.verifier,
        grant_type: "authorization_code",
        redirect_uri: runtime.config.cloudCode.oauthRedirectUri
      });
      const tokenResponse = await fetch(runtime.config.cloudCode.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params
      });
      if (!tokenResponse.ok) {
        reply.header("content-type", "text/html; charset=utf-8");
        return reply.status(502).send(html(`Token exchange failed with HTTP ${tokenResponse.status}`));
      }
      const token = (await tokenResponse.json()) as TokenResponse;
      if (!token.access_token) {
        reply.header("content-type", "text/html; charset=utf-8");
        return reply.status(502).send(html("Token exchange did not return an access token"));
      }
      if (!token.refresh_token) {
        reply.header("content-type", "text/html; charset=utf-8");
        return reply.status(400).send(html("Google did not return a refresh token. Revoke prior app consent and try again with prompt=consent."));
      }

      const userInfoResponse = await fetch(runtime.config.cloudCode.oauthUserInfoUrl, {
        headers: { authorization: `Bearer ${token.access_token}` }
      });
      if (!userInfoResponse.ok) {
        reply.header("content-type", "text/html; charset=utf-8");
        return reply.status(502).send(html(`Google userinfo failed with HTTP ${userInfoResponse.status}`));
      }
      const userInfo = (await userInfoResponse.json()) as UserInfoResponse;
      const expiresAt = token.expires_in ? Math.floor(Date.now() / 1000) + token.expires_in : undefined;
      const scopes = token.scope ? token.scope.split(/\s+/).filter(Boolean) : runtime.config.cloudCode.oauthScopes;
      const account: CloudCodeAccount = {
        id: accountId(userInfo.email, userInfo.sub),
        source: "oauth_login",
        email: userInfo.email,
        displayName: userInfo.name,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt,
        oauthClientId: BUILT_IN_OAUTH_CLIENT.key,
        scopes,
        disabled: false,
        health: { healthy: true, consecutiveFailures: 0 },
        quotaModels: []
      };
      runtime.accountRegistry.upsert(toStored(account));
      runtime.cloudCodeAccounts.addOrUpdate(account);
      runtime.activeAccountId = account.id;
      const quotaRefresh = await runtime.cloudCodeAccounts.refreshQuota(account.id);
      const quotaReady = quotaRefresh.success > 0;

      reply.header("content-type", "text/html; charset=utf-8");
      return reply.send(
        html(
          quotaReady
            ? "Google account connected. Account active and quotas loaded. You can close this tab."
            : "Google account connected. Account active. Quota refresh could not complete yet, the app will retry."
        )
      );
    }
  );

  app.post<{ Params: { accountId: string } }>("/auth/google/logout/:accountId", async (request, reply) => {
    const removed = runtime.accountRegistry.remove(request.params.accountId);
    runtime.cloudCodeAccounts.remove(request.params.accountId);
    runtime.tokenServer.deleteToken(request.params.accountId);
    if (!removed) {
      return reply.status(404).send({ error: { message: "Account not found", type: "not_found" } });
    }
    return { removed: true };
  });

  app.get("/auth/accounts", async () => ({
    accounts: runtime.accountRegistry.list(false).map((account) => publicAccount(account, runtime.activeAccountId))
  }));

  app.get("/auth/accounts/dashboard", async () => accountSummary(runtime));
}
