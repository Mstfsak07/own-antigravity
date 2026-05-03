import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function lsCoreFileName(): string {
  return process.platform === "win32" ? "ls_core.exe" : "ls_core";
}

export function defaultLsCoreCandidates(binDir: string): string[] {
  const name = lsCoreFileName();
  const home = homedir();
  const candidates = [
    join(binDir, name),
    join(process.cwd(), "bin", name),
    join(home, ".own-antigravity", "bin", name)
  ];

  if (process.platform === "win32") {
    candidates.push(
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Antigravity", "resources", "app", "bin", name),
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Antigravity", "resources", "app", "bin", name)
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Antigravity.app/Contents/Resources/app/bin/ls_core",
      join(home, "Applications", "Antigravity.app", "Contents", "Resources", "app", "bin", "ls_core")
    );
  } else {
    candidates.push("/usr/local/bin/ls_core", "/opt/antigravity/bin/ls_core", join(home, ".antigravity", "bin", "ls_core"));
  }

  return candidates.filter(Boolean);
}

export function defaultCertCandidates(binDir: string): string[] {
  const home = homedir();
  return [
    join(binDir, "cert.pem"),
    join(process.cwd(), "bin", "cert.pem"),
    join(home, ".own-antigravity", "bin", "cert.pem")
  ];
}

export function firstExisting(candidates: string[]): string | undefined {
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? resolve(found) : undefined;
}
