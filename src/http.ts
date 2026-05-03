import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";

const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function filteredRequestHeaders(
  headers: FastifyRequest["headers"],
  extra: Record<string, string | undefined> = {}
): Headers {
  const result = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (!value || hopByHopHeaders.has(key.toLowerCase()) || key.toLowerCase() === "host") {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
    } else {
      result.set(key, String(value));
    }
  }

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      result.set(key, value);
    }
  }

  return result;
}

export function jsonBody(body: unknown): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

export async function pipeUpstream(reply: FastifyReply, response: Response): Promise<void> {
  for (const [key, value] of response.headers.entries()) {
    if (!hopByHopHeaders.has(key.toLowerCase())) {
      reply.header(key, value);
    }
  }

  reply.status(response.status);

  if (!response.body) {
    reply.send();
    return;
  }

  await reply.send(Readable.fromWeb(response.body as any));
}

export function requireKey(value: string | undefined, provider: string): string {
  if (!value) {
    throw Object.assign(new Error(`${provider} API key is not configured`), {
      statusCode: 503
    });
  }
  return value;
}
