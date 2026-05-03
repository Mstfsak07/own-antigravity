import type { CloudCodeAccount, ProxyConfig } from "../types.js";
import { resolveRequestUserAgent } from "../requestUserAgent.js";

type QuotaApiResponse = {
  models?: Record<string, {
    quotaInfo?: {
      remainingFraction?: number;
      resetTime?: string;
    };
    displayName?: string;
  }>;
};

type LoadCodeAssistResponse = {
  cloudaicompanionProject?: string;
};

const quotaEndpoints = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"
];

const loadCodeAssistUrl = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist";

function quotaHeaders(config: ProxyConfig, account: CloudCodeAccount): Headers {
  return new Headers({
    authorization: `Bearer ${account.accessToken}`,
    "content-type": "application/json",
    "user-agent": resolveRequestUserAgent(config.cloudCode.userAgent)
  });
}

function isQuotaModel(name: string): boolean {
  return /^(gemini|claude|gpt|image|imagen)/i.test(name);
}

async function fetchProjectId(config: ProxyConfig, account: CloudCodeAccount): Promise<string | undefined> {
  if (account.projectId) {
    return account.projectId;
  }

  const response = await fetch(loadCodeAssistUrl, {
    method: "POST",
    headers: quotaHeaders(config, account),
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } })
  });
  if (!response.ok) {
    return undefined;
  }

  const body = (await response.json()) as LoadCodeAssistResponse;
  return body.cloudaicompanionProject;
}

export async function fetchCloudCodeQuota(config: ProxyConfig, account: CloudCodeAccount): Promise<CloudCodeAccount> {
  const projectId = await fetchProjectId(config, account);
  const payload = projectId ? { project: projectId } : {};
  let lastStatus = 0;
  let lastText = "";

  for (const endpoint of quotaEndpoints) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: quotaHeaders(config, account),
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      lastStatus = response.status;
      lastText = await response.text().catch(() => "");
      if ((response.status === 429 || response.status >= 500) && endpoint !== quotaEndpoints.at(-1)) {
        continue;
      }
      throw Object.assign(new Error(`Quota refresh failed with HTTP ${response.status}`), {
        statusCode: response.status
      });
    }

    const body = (await response.json()) as QuotaApiResponse;
    const quotaModels = Object.entries(body.models ?? {})
      .filter(([name, model]) => isQuotaModel(name) && model.quotaInfo)
      .map(([name, model]) => ({
        name,
        displayName: model.displayName,
        percentage: Math.max(0, Math.min(100, Math.round(Number(model.quotaInfo?.remainingFraction ?? 0) * 100))),
        resetTime: model.quotaInfo?.resetTime
      }));

    return {
      ...account,
      projectId: projectId ?? account.projectId,
      quotaModels
    };
  }

  throw Object.assign(new Error(`Quota refresh failed${lastStatus ? ` with HTTP ${lastStatus}` : ""}${lastText ? `: ${lastText}` : ""}`), {
    statusCode: lastStatus || 502
  });
}
