import type { ProxyConfig } from "../../types.js";
import { LsProtocolError } from "../errors.js";
import type { NativeTransportRequest, NativeTransportResponse } from "../transports/types.js";
import type { LsProtocolAdapter, ProtocolOptions, ProtocolStatus } from "./types.js";

export class WebSocketProtocol implements LsProtocolAdapter {
  readonly name = "websocket" as const;
  private socket: WebSocket | undefined;
  private initialized = false;
  private lastError: string | undefined;

  constructor(private readonly config: ProxyConfig, private readonly authSecret: string) {}

  async connect(): Promise<void> {
    if (!this.config.ls.endpoint) {
      throw this.fail("OWN_AG_LS_ENDPOINT is required for WebSocket transport");
    }
    const endpoint = new URL(this.config.ls.endpoint);
    endpoint.searchParams.set("auth", this.authSecret);
    this.socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      this.socket!.addEventListener("open", () => resolve(), { once: true });
      this.socket!.addEventListener("error", () => reject(this.fail("WebSocket connection failed")), { once: true });
    });
  }

  async initialize(_options: ProtocolOptions): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    this.initialized = true;
  }

  async sendRequest(_request: NativeTransportRequest, _options: ProtocolOptions): Promise<NativeTransportResponse> {
    throw this.fail("WebSocket request/response contract must be configured before use");
  }

  async streamRequest(_request: NativeTransportRequest, _options: ProtocolOptions): Promise<AsyncIterable<NativeTransportResponse>> {
    throw this.fail("WebSocket streaming contract must be configured before use");
  }

  async healthCheck(): Promise<ProtocolStatus> {
    return {
      name: this.name,
      connected: this.socket?.readyState === WebSocket.OPEN,
      initialized: this.initialized,
      streamSupported: true,
      lastError: this.lastError
    };
  }

  close(): void {
    this.socket?.close();
  }

  private fail(message: string): LsProtocolError {
    this.lastError = message;
    return new LsProtocolError(message);
  }
}
