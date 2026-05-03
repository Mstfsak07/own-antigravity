import type { ProxyConfig } from "../../types.js";
import { LsProtocolError } from "../errors.js";
import type { NativeTransportRequest, NativeTransportResponse } from "../transports/types.js";
import type { LsProtocolAdapter, ProtocolOptions, ProtocolStatus } from "./types.js";

export class HttpProtocol implements LsProtocolAdapter {
  readonly name = "http" as const;
  private connected = false;
  private initialized = false;
  private lastRequestAt: string | undefined;
  private lastLatencyMs: number | undefined;
  private lastError: string | undefined;

  constructor(private readonly config: ProxyConfig, private readonly authSecret: string) {}

  async connect(): Promise<void> {
    if (!this.config.ls.endpoint) {
      throw this.fail("OWN_AG_LS_ENDPOINT is required for HTTP transport");
    }
    this.connected = true;
  }

  async initialize(options: ProtocolOptions): Promise<void> {
    await this.connect();
    if (!this.config.ls.initMethod) {
      this.initialized = true;
      return;
    }
    await this.post(this.config.ls.initMethod, { client: "own-antigravity" }, options);
    this.initialized = true;
  }

  async sendRequest(request: NativeTransportRequest, options: ProtocolOptions): Promise<NativeTransportResponse> {
    if (!this.initialized) {
      await this.initialize(options);
    }
    const path = this.config.ls.requestMethod;
    if (!path) {
      throw this.fail("OWN_AG_LS_REQUEST_METHOD is required for HTTP transport");
    }
    const started = Date.now();
    const raw = await this.post(path, request, options);
    this.lastRequestAt = new Date().toISOString();
    this.lastLatencyMs = Date.now() - started;
    return { raw };
  }

  async streamRequest(request: NativeTransportRequest, options: ProtocolOptions): Promise<AsyncIterable<NativeTransportResponse>> {
    const single = await this.sendRequest(request, options);
    return (async function* () {
      yield single;
    })();
  }

  async healthCheck(): Promise<ProtocolStatus> {
    return {
      name: this.name,
      connected: this.connected,
      initialized: this.initialized,
      streamSupported: Boolean(this.config.ls.streamMethod),
      lastRequestAt: this.lastRequestAt,
      lastLatencyMs: this.lastLatencyMs,
      lastError: this.lastError
    };
  }

  close(): void {
    this.connected = false;
  }

  private async post(path: string, body: unknown, options: ProtocolOptions): Promise<unknown> {
    const url = new URL(path, this.config.ls.endpoint);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.authSecret}`
      },
      body: JSON.stringify(body),
      signal: options.signal
    });
    if (!response.ok) {
      throw this.fail(`HTTP LS request failed: ${response.status}`);
    }
    return response.json();
  }

  private fail(message: string): LsProtocolError {
    this.lastError = message;
    return new LsProtocolError(message);
  }
}
