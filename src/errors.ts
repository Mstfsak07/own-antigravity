import type { ErrorClass } from "./types.js";

export function classifyStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) {
    return "auth_error";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status >= 500) {
    return "provider_error";
  }
  return "provider_error";
}

export function classifyError(error: unknown): ErrorClass {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "timeout";
  }
  if (error instanceof Error && /timeout|timed out|abort/i.test(error.message)) {
    return "timeout";
  }
  if (typeof error === "object" && error && "statusCode" in error) {
    const statusCode = Number((error as { statusCode?: unknown }).statusCode);
    if (Number.isFinite(statusCode)) {
      return classifyStatus(statusCode);
    }
  }
  if (error instanceof TypeError) {
    return "network_error";
  }
  return "provider_error";
}

export function quarantineMs(reason: ErrorClass, defaultSeconds: number, failureCount = 1): number {
  const exponent = Math.max(0, failureCount - 1);
  const baseSeconds =
    reason === "auth_error"
      ? Math.max(defaultSeconds, 30 * 60)
      : reason === "rate_limit"
        ? Math.max(defaultSeconds, 5 * 60)
        : reason === "timeout"
          ? Math.max(defaultSeconds, 60)
          : defaultSeconds;
  const multiplier = Math.min(8, 2 ** exponent);
  return baseSeconds * multiplier * 1000;
}
