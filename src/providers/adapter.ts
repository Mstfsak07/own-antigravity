import { redactSensitiveText } from "../redact.js";
import { classifyError, classifyStatus } from "../errors.js";
import type { ErrorClass } from "../types.js";

export type ProviderChatRequest = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  [key: string]: unknown;
};

export type ProviderHealth = {
  ok: boolean;
  provider: string;
  error?: string;
};

export interface ProviderAdapter {
  readonly name: string;
  listModels(): Promise<string[]>;
  chat(request: ProviderChatRequest): Promise<unknown>;
  streamChat(request: ProviderChatRequest): Promise<AsyncIterable<unknown>>;
  healthCheck(): Promise<ProviderHealth>;
}

type FetchLike = typeof fetch;

export class ProviderAdapterError extends Error {
  readonly type: ErrorClass;
  readonly statusCode: number;

  constructor(provider: string, type: ErrorClass, statusCode: number, message?: string) {
    super(redactSensitiveText(message ?? `${provider} request failed`));
    this.name = "ProviderAdapterError";
    this.type = type;
    this.statusCode = statusCode;
  }
}

export function mapProviderStatus(status: number): ErrorClass {
  return classifyStatus(status);
}

export function mapProviderError(error: unknown): ErrorClass {
  return classifyError(error);
}

export function providerErrorPayload(provider: string, error: unknown) {
  const type =
    error instanceof ProviderAdapterError
      ? error.type
      : typeof error === "object" && error && "type" in error
        ? ((error as { type?: ErrorClass }).type ?? mapProviderError(error))
        : mapProviderError(error);
  const statusCode =
    error instanceof ProviderAdapterError
      ? error.statusCode
      : type === "auth_error"
        ? 401
        : type === "rate_limit"
          ? 429
          : type === "invalid_config"
            ? 400
            : type === "timeout"
              ? 504
              : type === "network_error"
                ? 502
                : 502;
  const message = redactSensitiveText(error instanceof Error ? error.message : `${provider} provider error`);
  return {
    statusCode,
    body: {
      error: {
        message,
        type,
        provider
      }
    }
  };
}

async function jsonOrText(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function requireOk(provider: string, response: Response): void {
  if (!response.ok) {
    throw new ProviderAdapterError(provider, mapProviderStatus(response.status), response.status, `${provider} request failed with HTTP ${response.status}`);
  }
}

export class GeminiOfficialAdapter implements ProviderAdapter {
  readonly name = "gemini";

  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly fetcher: FetchLike = fetch) {}

  async listModels(): Promise<string[]> {
    const response = await this.fetcher(`${this.baseUrl}/v1beta/models?key=${encodeURIComponent(this.apiKey)}`);
    requireOk(this.name, response);
    const data = await response.json() as { models?: Array<{ name?: string }> };
    return data.models?.map((model) => model.name).filter((name): name is string => Boolean(name)) ?? [];
  }

  async chat(request: ProviderChatRequest): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}/v1beta/models/${request.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    requireOk(this.name, response);
    return jsonOrText(response);
  }

  async streamChat(request: ProviderChatRequest): Promise<AsyncIterable<unknown>> {
    const data = await this.chat({ ...request, stream: true });
    return (async function* () {
      yield data;
    })();
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await this.listModels();
      return { ok: true, provider: this.name };
    } catch (error) {
      return { ok: false, provider: this.name, error: redactSensitiveText(error instanceof Error ? error.message : String(error)) };
    }
  }
}

export class AnthropicOfficialAdapter implements ProviderAdapter {
  readonly name = "anthropic";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly version: string,
    private readonly fetcher: FetchLike = fetch
  ) {}

  async listModels(): Promise<string[]> {
    return ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1", "claude-opus-4-7"];
  }

  async chat(request: ProviderChatRequest): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.version
      },
      body: JSON.stringify(request)
    });
    requireOk(this.name, response);
    return jsonOrText(response);
  }

  async streamChat(request: ProviderChatRequest): Promise<AsyncIterable<unknown>> {
    const data = await this.chat({ ...request, stream: true });
    return (async function* () {
      yield data;
    })();
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { ok: Boolean(this.apiKey), provider: this.name };
  }
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name = "openai-compatible";

  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly fetcher: FetchLike = fetch) {}

  async listModels(): Promise<string[]> {
    const response = await this.fetcher(`${this.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${this.apiKey}` }
    });
    requireOk(this.name, response);
    const data = await response.json() as { data?: Array<{ id?: string }> };
    return data.data?.map((model) => model.id).filter((id): id is string => Boolean(id)) ?? [];
  }

  async chat(request: ProviderChatRequest): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(request)
    });
    requireOk(this.name, response);
    return jsonOrText(response);
  }

  async streamChat(request: ProviderChatRequest): Promise<AsyncIterable<unknown>> {
    const data = await this.chat({ ...request, stream: true });
    return (async function* () {
      yield data;
    })();
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await this.listModels();
      return { ok: true, provider: this.name };
    } catch (error) {
      return { ok: false, provider: this.name, error: redactSensitiveText(error instanceof Error ? error.message : String(error)) };
    }
  }
}
