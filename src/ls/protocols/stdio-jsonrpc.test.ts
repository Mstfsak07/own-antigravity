import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { baseTestConfig } from "../../testConfig.js";
import { StdioJsonRpcProtocol } from "./stdio-jsonrpc.js";

class MockStdin extends Writable {
  constructor(private readonly onLine: (line: string) => void) {
    super();
  }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.onLine(chunk.toString("utf8").trim());
    callback();
  }
}

function mockChild(handler: (request: any, stdout: PassThrough) => void) {
  const stdout = new PassThrough();
  const child = new EventEmitter() as any;
  child.stdout = stdout;
  child.stdin = new MockStdin((line) => handler(JSON.parse(line), stdout));
  return child;
}

describe("StdioJsonRpcProtocol", () => {
  it("initializes successfully and matches request ids", async () => {
    const child = mockChild((request, stdout) => {
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method })}\n`);
    });
    const protocol = new StdioJsonRpcProtocol(child, baseTestConfig());
    await protocol.connect();
    await protocol.initialize({ timeoutMs: 1000 });
    const response = await protocol.sendRequest({ model: "m", body: {}, format: "openai" }, { timeoutMs: 1000 });

    expect(response.raw).toBe("request");
  });

  it("handles partial stdout lines", async () => {
    const child = mockChild((request, stdout) => {
      const line = `${JSON.stringify({ id: request.id, result: "partial-ok" })}\n`;
      stdout.write(line.slice(0, 10));
      stdout.write(line.slice(10));
    });
    const protocol = new StdioJsonRpcProtocol(child, baseTestConfig());
    await protocol.connect();
    const response = await protocol.sendRequest({ model: "m", body: {}, format: "openai" }, { timeoutMs: 1000 });

    expect(response.raw).toBe("partial-ok");
  });

  it("times out when no matching response arrives", async () => {
    const child = mockChild((_request, _stdout) => {});
    const protocol = new StdioJsonRpcProtocol(child, baseTestConfig());
    await protocol.connect();

    await expect(protocol.initialize({ timeoutMs: 1 })).rejects.toThrow("timed out");
  });

  it("rejects malformed response", async () => {
    const child = mockChild((_request, stdout) => stdout.write("{bad json}\n"));
    const protocol = new StdioJsonRpcProtocol(child, baseTestConfig());
    await protocol.connect();

    await expect(protocol.initialize({ timeoutMs: 20 })).rejects.toThrow();
    expect((await protocol.healthCheck()).lastError).toBe("Malformed JSON-RPC message");
  });

  it("cancels pending requests on abort", async () => {
    const child = mockChild((_request, _stdout) => {});
    const protocol = new StdioJsonRpcProtocol(child, baseTestConfig());
    await protocol.connect();
    const controller = new AbortController();
    const promise = protocol.initialize({ timeoutMs: 1000, signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
  });
});
