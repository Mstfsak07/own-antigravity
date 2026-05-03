import type { ProxyConfig } from "../../types.js";
import { GrpcProtocol } from "../protocols/grpc.js";
import { HttpProtocol } from "../protocols/http.js";
import { WebSocketProtocol } from "../protocols/websocket.js";
import type { LsProtocolAdapter } from "../protocols/types.js";
import type { NativeTransport, NativeTransportName, NativeTransportRequest, NativeTransportResponse, NativeTransportSendOptions } from "./types.js";

export class ProtocolTransport implements NativeTransport {
  readonly name: NativeTransportName;

  constructor(private readonly adapter: LsProtocolAdapter) {
    this.name = adapter.name;
  }

  async connect(): Promise<void> {
    await this.adapter.connect();
  }

  async send(request: NativeTransportRequest, options: NativeTransportSendOptions): Promise<NativeTransportResponse> {
    await this.adapter.connect();
    if (request.stream) {
      const stream = await this.adapter.streamRequest(request, options);
      for await (const event of stream) {
        return event;
      }
      return { raw: "" };
    }
    return this.adapter.sendRequest(request, options);
  }

  async initialize(options: NativeTransportSendOptions): Promise<void> {
    await this.adapter.initialize(options);
  }

  async healthCheck() {
    return this.adapter.healthCheck();
  }

  close(): void {
    this.adapter.close();
  }
}

export function protocolTransport(config: ProxyConfig, authSecret: string): ProtocolTransport {
  if (config.ls.transport === "grpc") {
    return new ProtocolTransport(new GrpcProtocol(config));
  }
  if (config.ls.transport === "websocket") {
    return new ProtocolTransport(new WebSocketProtocol(config, authSecret));
  }
  return new ProtocolTransport(new HttpProtocol(config, authSecret));
}
