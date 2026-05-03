import type { NativeTransportRequest, NativeTransportResponse } from "../transports/types.js";

export type ProtocolName = "stdio" | "grpc" | "http" | "websocket";

export type ProtocolStatus = {
  name: ProtocolName;
  connected: boolean;
  initialized: boolean;
  streamSupported: boolean;
  lastHandshakeAt?: string;
  lastRequestAt?: string;
  lastLatencyMs?: number;
  lastError?: string;
};

export type ProtocolOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
};

export interface LsProtocolAdapter {
  readonly name: ProtocolName;
  connect(): Promise<void>;
  initialize(options: ProtocolOptions): Promise<void>;
  sendRequest(request: NativeTransportRequest, options: ProtocolOptions): Promise<NativeTransportResponse>;
  streamRequest(request: NativeTransportRequest, options: ProtocolOptions): Promise<AsyncIterable<NativeTransportResponse>>;
  healthCheck(): Promise<ProtocolStatus>;
  close(): void;
}
