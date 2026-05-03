import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseTestConfig } from "../testConfig.js";
import type { CloudCodeAccount } from "../types.js";
import { InternalTokenServer } from "./tokenServer.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-token-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("InternalTokenServer", () => {
  it("requires bearer secret", async () => {
    const config = baseTestConfig();
    const account: CloudCodeAccount = {
      id: "a",
      filePath: "",
      source: "imported_json",
      accessToken: "access",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      disabled: false,
      health: { healthy: true, consecutiveFailures: 0 },
      quotaModels: []
    };
    const server = new InternalTokenServer(config, () => account);
    const url = await server.start();

    const response = await fetch(`${url}/internal/token/a`);

    expect(response.status).toBe(401);
    await server.stop();
  });

  it("refreshes expired account tokens", async () => {
    const dir = makeDir();
    const filePath = join(dir, "a.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        id: "a",
        token: {
          access_token: "old-access",
          refresh_token: "refresh-token",
          expiry_timestamp: Math.floor(Date.now() / 1000) - 60
        }
      }),
      "utf8"
    );
    const account: CloudCodeAccount = {
      id: "a",
      filePath,
      source: "imported_json",
      accessToken: "old-access",
      refreshToken: "refresh-token",
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      disabled: false,
      health: { healthy: true, consecutiveFailures: 0 },
      quotaModels: []
    };
    const config = baseTestConfig({
      cloudCode: {
        oauthClientId: "client",
        oauthClientSecret: "secret",
        tokenUrl: "https://oauth.example.test/token"
      }
    });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).startsWith("https://oauth.example.test/token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }
      return realFetch(input, init);
    });
    const server = new InternalTokenServer(config, () => account);
    const url = await server.start();

    const response = await fetch(`${url}/internal/token/a`, { headers: { authorization: `Bearer ${server.secret}` } });
    const body = await response.json();
    const updated = JSON.parse(readFileSync(filePath, "utf8"));

    expect(body.accessToken).toBe("new-access");
    expect(updated.token.access_token).toBe("new-access");
    await server.stop();
  });
});
