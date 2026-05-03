import { normalizeLsOutput, toAnthropicMessage, toGeminiGenerateContent, toOpenAIChat, toOpenAIResponse, toSseEvents } from "../transcoder/index.js";
import type { CloudCodeAccount } from "../types.js";
import { LsCoreMissing, LsRequestTimeout } from "./errors.js";
import type { LsOrchestrator } from "./orchestrator.js";
import type { NativeTransportRequest } from "./transports/types.js";

export type NativeFormat = "openai" | "anthropic" | "gemini" | "responses";

export class NativeLsClient {
  constructor(
    private readonly orchestrator: LsOrchestrator,
    private readonly selectAccount: (model: string) => Promise<CloudCodeAccount | undefined>,
    private readonly timeoutMs: number
  ) {}

  async request(
    model: string,
    format: NativeFormat,
    body: unknown,
    stream = false,
    signal?: AbortSignal
  ): Promise<{ data: unknown; sse?: string; instanceId: string; accountId: string; accountLabel?: string }> {
    const account = await this.selectAccount(model);
    if (!account) {
      throw new LsCoreMissing("No healthy account is available for native LS");
    }
    const instance = await this.orchestrator.startOrReuse(account, model);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    timeout.addEventListener("abort", abort, { once: true });
    try {
      const request: NativeTransportRequest = { model, body, format, stream };
      const response = await this.orchestrator.send(instance.id, request, controller.signal);
      const output = normalizeLsOutput(response.raw, model);
      if (stream && response.stream) {
        return {
          data: undefined,
          sse: toSseEvents(output, format === "responses" ? "openai" : format),
          instanceId: instance.id,
          accountId: account.id,
          accountLabel: account.email || account.displayName || account.id
        };
      }
      return {
        data: this.mapOutput(output, format),
        instanceId: instance.id,
        accountId: account.id,
        accountLabel: account.email || account.displayName || account.id
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new LsRequestTimeout();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private mapOutput(output: ReturnType<typeof normalizeLsOutput>, format: NativeFormat): unknown {
    if (format === "anthropic") {
      return toAnthropicMessage(output);
    }
    if (format === "gemini") {
      return toGeminiGenerateContent(output);
    }
    if (format === "responses") {
      return toOpenAIResponse(output);
    }
    return toOpenAIChat(output);
  }
}
