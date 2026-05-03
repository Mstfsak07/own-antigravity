import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PersistentLsConfig = {
  version: number;
  simulatedVersion?: string;
  assetVersion?: string;
  lsCorePath?: string;
  certPath?: string;
  provisionMode?: "Auto" | "LocalOnly" | "ForceRemote";
  updatedAt: string;
};

export function lsConfigPath(dataDir: string): string {
  return join(dataDir, "ls_config.json");
}

export function readPersistentLsConfig(dataDir: string): PersistentLsConfig {
  const path = lsConfigPath(dataDir);
  if (!existsSync(path)) {
    return { version: 1, updatedAt: new Date(0).toISOString() };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistentLsConfig>;
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    ...parsed
  };
}

export function writePersistentLsConfig(dataDir: string, config: PersistentLsConfig): void {
  const path = resolve(lsConfigPath(dataDir));
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}
