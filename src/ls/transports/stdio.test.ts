import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { baseTestConfig } from "../../testConfig.js";
import { StdioTransport } from "./stdio.js";

class MockStdin extends Writable {
  constructor(private readonly onLine: (line: string) => void) {
    super();
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.onLine(chunk.toString("utf8").trim());
    callback();
  }
}

describe("StdioTransport", () => {
  it("handles request/response with mocked child process", async () => {
    const stdout = new PassThrough();
    const child = new EventEmitter() as any;
    child.stdout = stdout;
    child.stdin = new MockStdin((line) => {
      const request = JSON.parse(line);
      stdout.write(`${JSON.stringify({ id: request.id, result: request.method === "initialize" ? { ok: true } : "native ok" })}\n`);
    });
    const transport = new StdioTransport(child, baseTestConfig());

    const response = await transport.send(
      { model: "m", body: { input: "hi" }, format: "openai" },
      { timeoutMs: 1000 }
    );

    expect(response.raw).toBe("native ok");
  });
});
