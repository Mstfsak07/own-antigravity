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

type CodeAssistTier = {
  id?: string;
  isDefault?: boolean;
};

type LoadCodeAssistResponse = {
  cloudaicompanionProject?: string;
  currentTier?: CodeAssistTier;
  allowedTiers?: CodeAssistTier[];
};

type OnboardUserResponse = {
  done?: boolean;
  response?: {
    cloudaicompanionProject?: { id?: string } | string;
  };
};

const quotaEndpoints = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"
];

const loadCodeAssistEndpoints = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
  "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
];

const onboardUserEndpoints = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:onboardUser",
  "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser",
  "https://cloudcode-pa.googleapis.com/v1internal:onboardUser"
];

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

function pickTierId(load: LoadCodeAssistResponse): string {
  const current = load.currentTier?.id;
  if (current) return current;
  const defaultTier = load.allowedTiers?.find((tier) => tier.isDefault)?.id;
  if (defaultTier) return defaultTier;
  return "free-tier";
}

function extractOnboardProject(body: OnboardUserResponse): string | undefined {
  const project = body.response?.cloudaicompanionProject;
  if (!project) return undefined;
  if (typeof project === "string") return project;
  return project.id;
}

async function loadCodeAssist(config: ProxyConfig, account: CloudCodeAccount): Promise<LoadCodeAssistResponse | undefined> {
  for (const endpoint of loadCodeAssistEndpoints) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: quotaHeaders(config, account),
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } })
    });
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && endpoint !== loadCodeAssistEndpoints.at(-1)) {
        continue;
      }
      return undefined;
    }
    return (await response.json()) as LoadCodeAssistResponse;
  }
  return undefined;
}

async function onboardUser(
  config: ProxyConfig,
  account: CloudCodeAccount,
  tierId: string,
  existingProject: string | undefined
): Promise<string | undefined> {
  const payload: Record<string, unknown> = {
    tierId,
    metadata: { ideType: "ANTIGRAVITY" }
  };
  if (existingProject) {
    payload.cloudaicompanionProject = existingProject;
  }

  for (const endpoint of onboardUserEndpoints) {
    let lroAttempts = 0;
    while (lroAttempts < 6) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: quotaHeaders(config, account),
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && endpoint !== onboardUserEndpoints.at(-1)) {
          break;
        }
        return undefined;
      }
      const body = (await response.json()) as OnboardUserResponse;
      const project = extractOnboardProject(body);
      if (project) return project;
      if (body.done === false) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        lroAttempts += 1;
        continue;
      }
      break;
    }
  }
  return undefined;
}

async function fetchProjectId(config: ProxyConfig, account: CloudCodeAccount): Promise<string | undefined> {
  if (account.projectId) {
    return account.projectId;
  }

  const load = await loadCodeAssist(config, account);
  if (!load) {
    return undefined;
  }
  if (load.cloudaicompanionProject) {
    return load.cloudaicompanionProject;
  }

  const tierId = pickTierId(load);
  const onboarded = await onboardUser(config, account, tierId, load.cloudaicompanionProject);
  if (onboarded) {
    return onboarded;
  }

  const reload = await loadCodeAssist(config, account);
  return reload?.cloudaicompanionProject;
}

export async function ensureCloudCodeProjectId(config: ProxyConfig, account: CloudCodeAccount): Promise<CloudCodeAccount> {
  const projectId = await fetchProjectId(config, account);
  if (!projectId || projectId === account.projectId) {
    return account;
  }
  return {
    ...account,
    projectId
  };
}

export async function fetchCloudCodeQuota(config: ProxyConfig, account: CloudCodeAccount): Promise<CloudCodeAccount> {
  const hydratedAccount = await ensureCloudCodeProjectId(config, account);
  const payload = hydratedAccount.projectId ? { project: hydratedAccount.projectId } : {};
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
      ...hydratedAccount,
      quotaModels
    };
  }

  throw Object.assign(new Error(`Quota refresh failed${lastStatus ? ` with HTTP ${lastStatus}` : ""}${lastText ? `: ${lastText}` : ""}`), {
    statusCode: lastStatus || 502
  });
}
