import { existsSync } from "node:fs";
import type { ProxyConfig } from "../../types.js";
import { LsTransportUnsupported } from "../errors.js";
import type { NativeTransportRequest, NativeTransportResponse } from "../transports/types.js";
import type { LsProtocolAdapter, ProtocolOptions, ProtocolStatus } from "./types.js";

export class GrpcProtocol implements LsProtocolAdapter {
  readonly name = "grpc" as const;
  private lastError: string | undefined;

  constructor(private readonly config: ProxyConfig) {}

  async connect(): Promise<void> {
    if (!this.config.ls.protoPath || !existsSync(this.config.ls.protoPath)) {
      throw this.fail("OWN_AG_LS_PROTO_PATH is required for gRPC transport");
    }
    if (!this.config.ls.serviceName || !this.config.ls.methodName) {
      throw this.fail("OWN_AG_LS_SERVICE_NAME and OWN_AG_LS_METHOD_NAME are required for gRPC transport");
    }
    throw this.fail("gRPC protocol adapter scaffold is present, but runtime gRPC client dependencies are not installed");
  }

  async initialize(_options: ProtocolOptions): Promise<void> {}

  async sendRequest(_request: NativeTransportRequest, _options: ProtocolOptions): Promise<NativeTransportResponse> {
    throw this.fail("gRPC transport is not available");
  }

  async streamRequest(_request: NativeTransportRequest, _options: ProtocolOptions): Promise<AsyncIterable<NativeTransportResponse>> {
    throw this.fail("gRPC streaming is not available");
  }

  async healthCheck(): Promise<ProtocolStatus> {
    return {
      name: this.name,
      connected: false,
      initialized: false,
      streamSupported: false,
      lastError: this.lastError
    };
  }

  close(): void {}

  private fail(message: string): LsTransportUnsupported {
    this.lastError = message;
    return new LsTransportUnsupported(message);
  }
}
