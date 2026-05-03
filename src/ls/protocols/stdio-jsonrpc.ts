import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "../../redact.js";
import type { ProxyConfig } from "../../types.js";
import { LsProtocolError, LsRequestTimeout } from "../errors.js";
import type { NativeTransportRequest, NativeTransportResponse } from "../transports/types.js";
import type { LsProtocolAdapter, ProtocolOptions, ProtocolStatus } from "./types.js";

type Pending = {
  resolve: (value: NativeTransportResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class StdioJsonRpcProtocol implements LsProtocolAdapter {
  readonly name = "stdio" as const;
  private buffer = "";
  private connected = false;
  private initialized = false;
  private readonly pending = new Map<string, Pending>();
  private lastHandshakeAt: string | undefined;
  private lastRequestAt: string | undefined;
  private lastLatencyMs: number | undefined;
  private lastError: string | undefined;

  constructor(private readonly child: ChildProcess, private readonly config: ProxyConfig) {}

  async connect(): Promise<void> {
    if (!this.child.stdin?.writable || !this.child.stdout?.readable) {
      throw this.fail(new LsProtocolError("stdio JSON-RPC transport is unavailable"));
    }
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.once("exit", () => this.rejectAll(new LsProtocolError("stdio JSON-RPC process closed")));
    this.connected = true;
  }

  async initialize(options: ProtocolOptions): Promise<void> {
    if (this.initialized) {
      return;
    }
    const method = this.config.ls.initMethod;
    if (!method) {
      throw this.fail(new LsProtocolError("OWN_AG_LS_INIT_METHOD is required for stdio JSON-RPC"));
    }
    await this.call(method, { client: "own-antigravity" }, options);
    this.initialized = true;
    this.lastHandshakeAt = new Date().toISOString();
  }

  async sendRequest(request: NativeTransportRequest, options: ProtocolOptions): Promise<NativeTransportResponse> {
    if (!this.initialized) {
      await this.initialize(options);
    }
    const method = this.config.ls.requestMethod;
    if (!method) {
      throw this.fail(new LsProtocolError("OWN_AG_LS_REQUEST_METHOD is required for stdio JSON-RPC"));
    }
    const started = Date.now();
    const response = await this.call(method, request, options);
    this.lastRequestAt = new Date().toISOString();
    this.lastLatencyMs = Date.now() - started;
    return response;
  }

  async streamRequest(request: NativeTransportRequest, options: ProtocolOptions): Promise<AsyncIterable<NativeTransportResponse>> {
    const method = this.config.ls.streamMethod;
    if (!method) {
      const single = await this.sendRequest(request, options);
      return (async function* () {
        yield single;
      })();
    }
    const response = await this.call(method, request, options);
    return (async function* () {
      yield response;
    })();
  }

  async healthCheck(): Promise<ProtocolStatus> {
    return {
      name: this.name,
      connected: this.connected,
      initialized: this.initialized,
      streamSupported: Boolean(this.config.ls.streamMethod),
      lastHandshakeAt: this.lastHandshakeAt,
      lastRequestAt: this.lastRequestAt,
      lastLatencyMs: this.lastLatencyMs,
      lastError: this.lastError
    };
  }

  close(): void {
    this.rejectAll(new LsProtocolError("stdio JSON-RPC transport closed"));
    this.connected = false;
  }

  private async call(method: string, params: unknown, options: ProtocolOptions): Promise<NativeTransportResponse> {
    if (!this.child.stdin?.writable) {
      throw this.fail(new LsProtocolError("stdio JSON-RPC stdin is not writable"));
    }
    const id = randomUUID();
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<NativeTransportResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.fail(new LsRequestTimeout()));
      }, options.timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.sendNotification("$/cancelRequest", { id });
        reject(this.fail(new LsRequestTimeout("LS request aborted")));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          options.signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject,
        timer
      });
      this.child.stdin!.write(`${message}\n`, "utf8", (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(this.fail(new LsProtocolError(error.message)));
        }
      });
    });
  }

  private sendNotification(method: string, params: unknown): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: { id?: string; error?: { message?: string } | string; result?: unknown; method?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      const error = this.fail(new LsProtocolError("Malformed JSON-RPC message"));
      this.rejectAll(error);
      return;
    }
    if (!parsed.id) {
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);
    if (parsed.error) {
      const message = typeof parsed.error === "string" ? parsed.error : parsed.error.message ?? "JSON-RPC error";
      pending.reject(this.fail(new LsProtocolError(message)));
      return;
    }
    pending.resolve({ raw: parsed.result });
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private fail<T extends Error>(error: T): T {
    this.lastError = redactSensitiveText(error.message);
    return error;
  }
}
