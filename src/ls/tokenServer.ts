import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { refreshCloudCodeToken } from "../cloudCode/oauth.js";
import { redactSecret } from "../redact.js";
import type { CloudCodeAccount, ProxyConfig } from "../types.js";
import { LsAuthError } from "./errors.js";

type TokenEntry = {
  accessToken: string;
  expiresAt?: number;
  updatedAt: string;
};

function tokenExpired(expiresAt: number | undefined): boolean {
  return expiresAt !== undefined && expiresAt <= Math.floor(Date.now() / 1000) + 30;
}

function bearer(request: IncomingMessage): string | undefined {
  return request.headers.authorization?.replace(/^Bearer\s+/i, "");
}

export class InternalTokenServer {
  private server: Server | undefined;
  private readonly tokens = new Map<string, TokenEntry>();
  private boundUrl: string | undefined;
  readonly secret = randomBytes(24).toString("base64url");

  constructor(
    private readonly config: ProxyConfig,
    private readonly getAccount: (accountId: string) => CloudCodeAccount | undefined,
    private readonly onAccountUpdated?: (account: CloudCodeAccount) => void
  ) {}

  async start(): Promise<string> {
    if (this.boundUrl) {
      return this.boundUrl;
    }
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        const status = error instanceof LsAuthError ? 401 : 500;
        response
          .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify({ error: error.message }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.ls.tokenServerPort, this.config.ls.tokenServerHost, resolve);
    });
    const address = this.server.address() as AddressInfo;
    this.boundUrl = `http://${address.address}:${address.port}`;
    return this.boundUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    this.boundUrl = undefined;
    this.tokens.clear();
  }

  setAccount(account: CloudCodeAccount): void {
    this.tokens.set(account.id, {
      accessToken: account.accessToken,
      expiresAt: account.expiresAt,
      updatedAt: new Date().toISOString()
    });
  }

  deleteToken(accountId: string): void {
    this.tokens.delete(accountId);
  }

  url(): string | undefined {
    return this.boundUrl;
  }

  snapshot() {
    return {
      running: Boolean(this.boundUrl),
      url: this.boundUrl,
      secret: redactSecret(this.secret),
      tokens: [...this.tokens.entries()].map(([accountId, token]) => ({
        accountId,
        accessToken: redactSecret(token.accessToken),
        expiresAt: token.expiresAt,
        updatedAt: token.updatedAt
      }))
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponseLike): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.socket.remoteAddress && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) {
      throw new LsAuthError("Internal token endpoint only accepts loopback requests");
    }
    if (request.method !== "GET" || !url.pathname.startsWith("/internal/token/")) {
      response.writeHead(404).end();
      return;
    }
    if (bearer(request) !== this.secret) {
      throw new LsAuthError("Invalid internal token secret");
    }
    const accountId = decodeURIComponent(url.pathname.slice("/internal/token/".length));
    const token = await this.resolveToken(accountId);
    response
      .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify({ accessToken: token.accessToken, expiresAt: token.expiresAt }));
  }

  private async resolveToken(accountId: string): Promise<TokenEntry> {
    const current = this.tokens.get(accountId);
    if (current && !tokenExpired(current.expiresAt)) {
      return current;
    }
    const account = this.getAccount(accountId);
    if (!account) {
      throw new LsAuthError("Account token is unavailable");
    }
    if (tokenExpired(account.expiresAt)) {
      const refreshed = await refreshCloudCodeToken(this.config, account);
      Object.assign(account, refreshed);
      this.onAccountUpdated?.(account);
    }
    this.setAccount(account);
    return this.tokens.get(accountId)!;
  }
}

type ServerResponseLike = {
  writeHead(statusCode: number, headers?: Record<string, string>): ServerResponseLike;
  end(chunk?: string): void;
};
