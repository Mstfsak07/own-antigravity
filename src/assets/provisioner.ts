import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ProxyConfig } from "../types.js";
import { readPersistentLsConfig, writePersistentLsConfig } from "../lsConfig.js";
import { defaultCertCandidates, defaultLsCoreCandidates, firstExisting, lsCoreFileName } from "./resolver.js";

export type ProvisionMode = "Auto" | "LocalOnly" | "ForceRemote";

export type ProvisionStatus = {
  mode: ProvisionMode;
  ready: boolean;
  source: "configured" | "local" | "remote" | "missing";
  lsCorePath?: string;
  certPath?: string;
  version?: string;
  expectedSha256?: string;
  actualSha256?: string;
  lastError?: string;
  binary: { path?: string; found: boolean };
  cert: { path?: string; found: boolean };
};

type RemoteManifest = {
  version: string;
  lsCoreUrl: string;
  lsCoreSha256: string;
  certUrl?: string;
  certSha256?: string;
};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeAssetPath(baseDir: string, name: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, basename(name));
  if (!target.startsWith(base)) {
    throw new Error("Invalid asset path");
  }
  return target;
}

export class AssetProvisioner {
  private statusCache: ProvisionStatus | undefined;

  constructor(private readonly config: ProxyConfig) {}

  status(): ProvisionStatus {
    this.statusCache = this.discover();
    return this.statusCache;
  }

  async sync(mode = this.config.ls.provisionMode): Promise<ProvisionStatus> {
    if (mode === "LocalOnly") {
      this.statusCache = this.discoverLocalOnly(mode);
      return this.statusCache;
    }

    if (mode === "Auto") {
      const local = this.discoverLocalOnly(mode);
      if (local.ready) {
        this.statusCache = local;
        return local;
      }
    }

    if (!this.config.ls.remoteManifestUrl) {
      this.statusCache = {
        ...this.discoverLocalOnly(mode),
        source: "missing",
        ready: false,
        lastError: "Remote manifest URL is not configured"
      };
      return this.statusCache;
    }

    this.statusCache = await this.syncRemote(mode);
    return this.statusCache;
  }

  private discover(): ProvisionStatus {
    return this.discoverLocalOnly(this.config.ls.provisionMode);
  }

  private discoverLocalOnly(mode: ProvisionMode): ProvisionStatus {
    const persisted = readPersistentLsConfig(this.config.dataDir);
    const candidates = [
      this.config.ls.lsCorePath,
      persisted.lsCorePath,
      ...defaultLsCoreCandidates(this.config.ls.binDir)
    ].filter((value): value is string => Boolean(value));
    const certCandidates = [
      this.config.ls.certPath,
      persisted.certPath,
      ...defaultCertCandidates(this.config.ls.binDir)
    ].filter((value): value is string => Boolean(value));

    const lsCorePath = firstExisting(candidates);
    const certPath = firstExisting(certCandidates);
    if (!lsCorePath) {
      return {
        mode,
        ready: false,
        source: "missing",
        certPath,
        binary: { found: false },
        cert: { path: certPath, found: Boolean(certPath) },
        version: persisted.assetVersion,
        lastError: "ls_core asset was not found"
      };
    }

    const actualSha256 = sha256(lsCorePath);
    const expectedSha256 = this.config.ls.remoteExpectedSha256 || persisted.assetVersion;
    return {
      mode,
      ready: true,
      source: this.config.ls.lsCorePath ? "configured" : "local",
      lsCorePath: resolve(lsCorePath),
      certPath: certPath ? resolve(certPath) : undefined,
      binary: { path: resolve(lsCorePath), found: true },
      cert: { path: certPath ? resolve(certPath) : undefined, found: Boolean(certPath) },
      version: persisted.assetVersion,
      expectedSha256: this.config.ls.remoteExpectedSha256,
      actualSha256
    };
  }

  private async syncRemote(mode: ProvisionMode): Promise<ProvisionStatus> {
    mkdirSync(this.config.ls.binDir, { recursive: true });
    const manifestResponse = await fetch(this.config.ls.remoteManifestUrl!);
    if (!manifestResponse.ok) {
      return {
        mode,
        ready: false,
        source: "remote",
        binary: { found: false },
        cert: { found: false },
        lastError: `Manifest fetch failed: ${manifestResponse.status}`
      };
    }
    const manifest = (await manifestResponse.json()) as RemoteManifest;
    if (this.config.ls.remoteExpectedSha256 && this.config.ls.remoteExpectedSha256 !== manifest.lsCoreSha256) {
      return {
        mode,
        ready: false,
        source: "remote",
        binary: { found: false },
        cert: { found: false },
        lastError: "Manifest hash does not match configured hash"
      };
    }

    const lsCorePath = await this.downloadVerified(manifest.lsCoreUrl, lsCoreFileName(), manifest.lsCoreSha256);
    const certPath = manifest.certUrl && manifest.certSha256
      ? await this.downloadVerified(manifest.certUrl, "cert.pem", manifest.certSha256)
      : undefined;

    writePersistentLsConfig(this.config.dataDir, {
      version: 1,
      assetVersion: manifest.version,
      lsCorePath,
      certPath,
      provisionMode: mode,
      updatedAt: new Date().toISOString()
    });

    return {
      mode,
      ready: true,
      source: "remote",
      lsCorePath,
      certPath,
      binary: { path: lsCorePath, found: true },
      cert: { path: certPath, found: Boolean(certPath) },
      version: manifest.version,
      expectedSha256: manifest.lsCoreSha256,
      actualSha256: sha256(lsCorePath)
    };
  }

  private async downloadVerified(url: string, fileName: string, expectedHash: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Asset download failed: ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error("Downloaded asset hash mismatch");
    }
    const target = safeAssetPath(this.config.ls.binDir, fileName);
    mkdirSync(dirname(target), { recursive: true });
    const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, target);
    return target;
  }
}
