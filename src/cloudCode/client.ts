import type { CloudCodeAccount, ProxyConfig } from "../types.js";
import { resolveRequestUserAgent } from "../requestUserAgent.js";

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

function buildUrl(baseUrl: string, method: "generateContent" | "streamGenerateContent", search?: string): string {
  return `${baseUrl}:${method}${search ? `?${search}` : ""}`;
}

function headers(account: CloudCodeAccount, body: Record<string, unknown>, config: ProxyConfig): Headers {
  const requestUserAgent = resolveRequestUserAgent(config.cloudCode.userAgent);
  const result = new Headers({
    authorization: `Bearer ${account.accessToken}`,
    "content-type": "application/json",
    "user-agent": requestUserAgent,
    "x-client-name": "antigravity"
  });

  const project = typeof body.project === "string" ? body.project : account.projectId;
  if (config.cloudCode.sendUserProjectHeader && project) {
    result.set("x-goog-user-project", project);
  }

  return result;
}

export async function callCloudCode(
  config: ProxyConfig,
  account: CloudCodeAccount,
  method: "generateContent" | "streamGenerateContent",
  body: Record<string, unknown>,
  search?: string
): Promise<Response> {
  let lastResponse: Response | undefined;

  for (const baseUrl of config.cloudCode.baseUrls) {
    const response = await fetch(buildUrl(baseUrl, method, search), {
      method: "POST",
      headers: headers(account, body, config),
      body: JSON.stringify(body)
    });

    if (!retryableStatuses.has(response.status)) {
      return response;
    }

    lastResponse = response;
  }

  return lastResponse ?? new Response("No Cloud Code upstream response", { status: 502 });
}
