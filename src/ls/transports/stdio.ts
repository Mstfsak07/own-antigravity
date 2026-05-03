import type { ChildProcess } from "node:child_process";
import type { ProxyConfig } from "../../types.js";
import { StdioJsonRpcProtocol } from "../protocols/stdio-jsonrpc.js";
import type { NativeTransport, NativeTransportRequest, NativeTransportResponse, NativeTransportSendOptions } from "./types.js";

export class StdioTransport implements NativeTransport {
  readonly name = "stdio" as const;
  private readonly protocol: StdioJsonRpcProtocol;
  private connected = false;

  constructor(child: ChildProcess, config: ProxyConfig) {
    this.protocol = new StdioJsonRpcProtocol(child, config);
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.protocol.connect();
      this.connected = true;
    }
  }

  async send(request: NativeTransportRequest, options: NativeTransportSendOptions): Promise<NativeTransportResponse> {
    await this.connect();
    if (request.stream) {
      const stream = await this.protocol.streamRequest(request, options);
      for await (const event of stream) {
        return event;
      }
      return { raw: "" };
    }
    return this.protocol.sendRequest(request, options);
  }

  async initialize(options: NativeTransportSendOptions): Promise<void> {
    await this.connect();
    await this.protocol.initialize(options);
  }

  async healthCheck() {
    return this.protocol.healthCheck();
  }

  close(): void {
    this.protocol.close();
  }
}
