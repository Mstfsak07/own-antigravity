export function redactSecret(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value.length <= 8) {
    return "****";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function deepRedact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepRedact);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|api[_-]?key|authorization|password/i.test(key)) {
      output[key] = redactSecret(typeof item === "string" ? item : undefined) ?? "<redacted>";
    } else {
      output[key] = deepRedact(item);
    }
  }
  return output;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer <redacted>")
    .replace(/ya29\.[A-Za-z0-9._\-]+/g, "ya29.<redacted>")
    .replace(/1\/\/[A-Za-z0-9._\-]+/g, "1//<redacted>")
    .replace(/(api[_-]?key|access_token|refresh_token|client_secret)=([^&\s]+)/gi, "$1=<redacted>");
}
