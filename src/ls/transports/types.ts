export type NativeTransportName = "stdio" | "grpc" | "http" | "websocket";

export type NativeTransportRequest = {
  model: string;
  body: unknown;
  format: "openai" | "anthropic" | "gemini" | "responses";
  stream?: boolean;
};

export type NativeTransportResponse = {
  raw: unknown;
  stream?: AsyncIterable<unknown>;
};

export type NativeTransportSendOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
};

export interface NativeTransport {
  readonly name: NativeTransportName;
  connect?(): Promise<void>;
  initialize?(options: NativeTransportSendOptions): Promise<void>;
  healthCheck?(): Promise<unknown>;
  send(request: NativeTransportRequest, options: NativeTransportSendOptions): Promise<NativeTransportResponse>;
  close(): void;
}
