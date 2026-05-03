import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { baseTestConfig } from "../testConfig.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-native-e2e-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("native LS bridge e2e", () => {
  it("handles mock JSON-RPC LS chat completion", async () => {
    const dir = makeDir();
    const accountsDir = join(dir, "accounts");
    const mockServer = join(dir, "mock-ls.js");
    writeFileSync(
      mockServer,
      `
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n');
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const result = msg.method === 'initialize' ? { ok: true } : 'mock native response';
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`,
      "utf8"
    );
    const accountDir = accountsDir;
    mkdirSync(accountDir, { recursive: true });
    writeFileSync(
      join(accountDir, "a.json"),
      JSON.stringify({
        id: "a",
        token: {
          access_token: "access-token",
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        },
        quota: { models: [{ name: "gemini-2.5-pro", percentage: 100 }] }
      }),
      "utf8"
    );
    const app = buildServer(
      baseTestConfig({
        localApiKey: "local",
        cloudCode: { enabled: true, accountsDir: accountDir },
        ls: {
          nativeEnabled: true,
          providerFallback: false,
          lsCorePath: process.execPath,
          extraArgs: [mockServer],
          initMethod: "initialize",
          requestMethod: "request",
          streamMethod: ""
        }
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer local" },
      payload: { model: "gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("mock native response");
  });
});
