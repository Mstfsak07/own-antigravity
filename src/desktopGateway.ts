export type GatewayFetch = typeof fetch;

function localGatewayHeaders(localApiKey: string | undefined): Record<string, string> {
  return localApiKey ? { Authorization: `Bearer ${localApiKey}` } : {};
}

export function hasOnlyUnhealthyCloudCode(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const cloudCode = (payload as { cloudCode?: { accountCount?: unknown; healthyCount?: unknown } }).cloudCode;
  return Boolean(cloudCode?.accountCount && Number(cloudCode.accountCount) > 0 && Number(cloudCode.healthyCount) === 0);
}

export async function existingGatewayNeedsRestart(
  url: string,
  localApiKey: string | undefined,
  fetchImpl: GatewayFetch = fetch
): Promise<boolean> {
  if (!localApiKey) {
    return false;
  }
  try {
    const response = await fetchImpl(`${url}/health/providers`, {
      headers: localGatewayHeaders(localApiKey),
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) {
      return false;
    }
    return hasOnlyUnhealthyCloudCode(await response.json());
  } catch {
    return false;
  }
}

export async function requestExistingGatewayShutdown(
  url: string,
  localApiKey: string | undefined,
  existingGatewayIsReachable: (url: string) => Promise<boolean>,
  fetchImpl: GatewayFetch = fetch
): Promise<boolean> {
  if (!localApiKey) {
    return false;
  }
  try {
    const response = await fetchImpl(`${url}/admin/shutdown`, {
      method: "POST",
      headers: {
        ...localGatewayHeaders(localApiKey),
        "content-type": "application/json"
      },
      body: "{}",
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) {
      return false;
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!await existingGatewayIsReachable(url)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  } catch {
    return false;
  }
}
