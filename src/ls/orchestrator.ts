import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AssetProvisioner } from "../assets/provisioner.js";
import { logger } from "../logger.js";
import { redactSensitiveText } from "../redact.js";
import type { CloudCodeAccount, ProxyConfig } from "../types.js";
import { LsCoreCrashed, LsCoreMissing, LsCoreStartFailed } from "./errors.js";
import type { InternalTokenServer } from "./tokenServer.js";
import { StdioTransport } from "./transports/stdio.js";
import { protocolTransport } from "./transports/tcp.js";
import type { NativeTransport, NativeTransportRequest, NativeTransportResponse } from "./transports/types.js";

export type LsInstance = {
  id: string;
  accountId: string;
  model?: string;
  pid?: number;
  status: "starting" | "running" | "stopped" | "crashed";
  startedAt: string;
  lastUsedAt: string;
  expiresAt: string;
  transport: "stdio" | "grpc" | "http" | "websocket";
  port?: number;
  socketPath?: string;
  assetPath?: string;
  certPath?: string;
  exitCode?: number | null;
  crashCount: number;
  lastError?: string;
};

type ManagedInstance = LsInstance & {
  process?: ChildProcess;
  transportAdapter?: NativeTransport;
  stoppedByUs?: boolean;
};

function sanitizeExecutablePath(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new LsCoreMissing("ls_core binary was not found");
  }
  return resolved;
}

export function safeExtraArgs(args: string[]): string[] {
  return args.filter((arg) => !/[;&|><`]/.test(arg));
}

export function buildLsSpawnOptions(
  config: ProxyConfig,
  account: CloudCodeAccount,
  model: string | undefined,
  authServerUrl: string,
  authSecret: string,
  certPath?: string
): SpawnOptionsWithoutStdio {
  return {
    shell: false,
    windowsHide: true,
    cwd: config.ls.workingDirectory ? resolve(config.ls.workingDirectory) : undefined,
    env: {
      ...process.env,
      OWN_AG_ACCOUNT_ID: account.id,
      OWN_AG_MODEL: model ?? "",
      OWN_AG_AUTH_SERVER_URL: authServerUrl,
      OWN_AG_AUTH_SERVER_SECRET: authSecret,
      OWN_AG_TOKEN_ENDPOINT: `${authServerUrl}/internal/token/${encodeURIComponent(account.id)}`,
      OWN_AG_CERT_PATH: certPath ?? ""
    },
    stdio: ["pipe", "pipe", "pipe"]
  };
}

export class LsOrchestrator {
  private readonly instances = new Map<string, ManagedInstance>();

  constructor(
    private readonly config: ProxyConfig,
    private readonly provisioner: AssetProvisioner,
    private readonly tokenServer: InternalTokenServer,
    private readonly getAccount?: (accountId: string) => CloudCodeAccount | undefined
  ) {}

  list(): LsInstance[] {
    this.cleanupExpired();
    return [...this.instances.values()].map((instance) => this.publicInstance(instance));
  }

  health() {
    const instances = this.list();
    return {
      active: instances.filter((instance) => instance.status === "running").length,
      crashCount: instances.reduce((total, instance) => total + instance.crashCount, 0),
      instances
    };
  }

  async startOrReuse(account: CloudCodeAccount, model?: string): Promise<LsInstance> {
    this.cleanupExpired();
    const reusable = [...this.instances.values()].find(
      (instance) => instance.accountId === account.id && instance.model === model && instance.status === "running"
    );
    if (reusable) {
      reusable.lastUsedAt = new Date().toISOString();
      reusable.expiresAt = this.expiryIso();
      return this.publicInstance(reusable);
    }

    this.reclaimIfNeeded();
    const managed = await this.spawnInstance(account, model);
    this.instances.set(managed.id, managed);
    return this.publicInstance(managed);
  }

  async send(instanceId: string, request: NativeTransportRequest, signal?: AbortSignal): Promise<NativeTransportResponse> {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.status !== "running" || !instance.transportAdapter) {
      throw new LsCoreCrashed("LS instance is not running");
    }
    instance.lastUsedAt = new Date().toISOString();
    instance.expiresAt = this.expiryIso();
    return instance.transportAdapter.send(request, { timeoutMs: this.config.ls.requestTimeoutMs, signal });
  }

  async handshake(instanceId: string, timeoutMs = this.config.ls.requestTimeoutMs): Promise<unknown> {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.status !== "running" || !instance.transportAdapter) {
      throw new LsCoreCrashed("LS instance is not running");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (instance.transportAdapter.initialize) {
        await instance.transportAdapter.initialize({ timeoutMs, signal: controller.signal });
      } else if (instance.transportAdapter.connect) {
        await instance.transportAdapter.connect();
      }
      return instance.transportAdapter.healthCheck ? instance.transportAdapter.healthCheck() : {};
    } finally {
      clearTimeout(timer);
    }
  }

  async protocolStatus(instanceId?: string) {
    const instances = instanceId
      ? [...this.instances.values()].filter((instance) => instance.id === instanceId)
      : [...this.instances.values()];
    return Promise.all(
      instances.map(async (instance) => {
        const status = instance.transportAdapter?.healthCheck ? await instance.transportAdapter.healthCheck() : {};
        return {
          instanceId: instance.id,
          ...(typeof status === "object" && status ? status : {})
        };
      })
    );
  }

  async restart(id: string): Promise<LsInstance> {
    const existing = this.instances.get(id);
    if (!existing) {
      throw new LsCoreMissing("LS instance was not found");
    }
    const account = this.getAccount?.(existing.accountId);
    if (!account) {
      throw new LsCoreMissing("LS account was not found");
    }
    const model = existing.model;
    this.stop(id);
    return this.startOrReuse(account, model);
  }

  stop(id: string): boolean {
    const instance = this.instances.get(id);
    if (!instance) {
      return false;
    }
    instance.stoppedByUs = true;
    instance.transportAdapter?.close();
    instance.process?.kill();
    instance.status = "stopped";
    this.instances.delete(id);
    return true;
  }

  cleanupExpired(): number {
    const now = Date.now();
    let stopped = 0;
    for (const instance of this.instances.values()) {
      if (Date.parse(instance.expiresAt) <= now) {
        this.stop(instance.id);
        stopped += 1;
      }
    }
    return stopped;
  }

  private async spawnInstance(account: CloudCodeAccount, model?: string): Promise<ManagedInstance> {
    const status = this.provisioner.status();
    if (!status.ready || !status.lsCorePath) {
      throw new LsCoreMissing(status.lastError ?? "ls_core is not provisioned");
    }

    const authServerUrl = await this.tokenServer.start();
    this.tokenServer.setAccount(account);
    const lsCorePath = sanitizeExecutablePath(status.lsCorePath);
    const args = safeExtraArgs(this.config.ls.extraArgs);
    const spawnOptions = buildLsSpawnOptions(this.config, account, model, authServerUrl, this.tokenServer.secret, status.certPath);

    const instance: ManagedInstance = {
      id: randomUUID(),
      accountId: account.id,
      model,
      status: "starting",
      startedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      expiresAt: this.expiryIso(),
      transport: this.config.ls.transport,
      assetPath: lsCorePath,
      certPath: status.certPath,
      crashCount: 0
    };

    try {
      const child = spawn(lsCorePath, args, spawnOptions);
      instance.process = child;
      instance.pid = child.pid;
      instance.transportAdapter = this.createTransport(child);
      instance.status = "running";
      child.stdout?.on("data", (chunk) =>
        logger.info("ls_core stdout data", { lsInstance: instance.id, bytes: Buffer.byteLength(String(chunk)) })
      );
      child.stderr?.on("data", (chunk) => {
        instance.lastError = redactSensitiveText(String(chunk).trim());
        logger.warn(instance.lastError, { lsInstance: instance.id });
      });
      child.once("exit", (code) => {
        instance.exitCode = code;
        if (instance.stoppedByUs) {
          instance.status = "stopped";
          return;
        }
        instance.status = "crashed";
        instance.crashCount += 1;
        instance.lastError = `ls_core exited with code ${code}`;
      });
      child.once("error", (error) => {
        instance.status = "crashed";
        instance.crashCount += 1;
        instance.lastError = redactSensitiveText(error.message);
      });
      return instance;
    } catch (error) {
      throw new LsCoreStartFailed(error instanceof Error ? redactSensitiveText(error.message) : "ls_core start failed");
    }
  }

  private createTransport(child: ChildProcess): NativeTransport {
    if (this.config.ls.transport === "stdio") {
      return new StdioTransport(child, this.config);
    }
    return protocolTransport(this.config, this.tokenServer.secret);
  }

  private reclaimIfNeeded(): void {
    while (this.instances.size >= this.config.ls.maxInstances) {
      const [oldest] = [...this.instances.values()].sort(
        (a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt)
      );
      if (!oldest) {
        return;
      }
      this.stop(oldest.id);
    }
  }

  private expiryIso(): string {
    return new Date(Date.now() + this.config.ls.instanceTtlSeconds * 1000).toISOString();
  }

  private publicInstance(instance: ManagedInstance): LsInstance {
    const { process: _process, transportAdapter: _adapter, stoppedByUs: _stoppedByUs, ...publicData } = instance;
    return publicData;
  }
}
