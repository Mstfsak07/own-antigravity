const FALLBACK_VERSION = "1.22.2";

function platformTag(): string {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    default:
      return "linux";
  }
}

function archTag(): string {
  if (process.arch === "x64") {
    return "amd64";
  }
  if (process.arch === "arm64") {
    return "arm64";
  }
  return process.arch;
}

export function buildUserAgent(version = FALLBACK_VERSION): string {
  return `antigravity/${version} ${platformTag()}/${archTag()}`;
}

export function resolveRequestUserAgent(configured?: string): string {
  const value = configured?.trim();
  if (!value || value.toLowerCase() === "antigravity") {
    return buildUserAgent();
  }
  return value;
}
