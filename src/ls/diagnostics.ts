import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { redactSensitiveText } from "../redact.js";
import type { Runtime } from "../runtime.js";
import type { CloudCodeAccount, ProxyConfig } from "../types.js";
import { LsError, LsProtocolError, LsRequestTimeout } from "./errors.js";
import { buildLsSpawnOptions, safeExtraArgs } from "./orchestrator.js";

export type LsDiagnosticRunOptions = {
  disableFallback?: boolean;
  timeoutMs?: number;
};

export type LsDiagnosticResult = {
  checkedAt: string;
  nativeEnabled: boolean;
  selectedTransport: ProxyConfig["ls"]["transport"];
  binary: { path?: string; found: boolean };
  cert: { path?: string; found: boolean };
  process: {
    spawnSuccess: boolean;
    pid?: number;
    startupTimeMs?: number;
    exitCode?: number | null;
    stderr?: string;
  };
  handshake: { success: boolean; status?: unknown };
  nativeRequest: { success: boolean; responseReceived?: boolean };
  streamingSupport: "yes" | "no" | "unknown";
  fallbackUsed: boolean;
  error?: { code: string; message: string };
};

type SpawnFn = typeof spawn;

function sanitizeError(error: unknown): { code: string; message: string } {
  if (error instanceof LsError) {
    return { code: error.code, message: redactSensitiveText(error.message) };
  }
  if (error instanceof Error) {
    const code = "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : error.name || "Error";
    return { code, message: redactSensitiveText(error.message) };
  }
  return { code: "Error", message: redactSensitiveText(String(error)) };
}

function sanitizeText(config: ProxyConfig, value: string): string {
  let output = redactSensitiveText(value);
  for (const secret of [
    config.localApiKey,
    config.cloudCode.oauthClientSecret,
    config.cloudCode.tokenEncryptionKey,
    process.env.OWN_AG_API_KEY
  ].filter((item): item is string => Boolean(item))) {
    output = output.split(secret).join("<redacted>");
  }
  return output;
}

function streamSupport(config: ProxyConfig): "yes" | "no" | "unknown" {
  if (config.ls.transport === "websocket") {
    return "yes";
  }
  if (config.ls.streamMethod) {
    return "yes";
  }
  return "unknown";
}

function diagnosticAccount(): CloudCodeAccount {
  return {
    id: "diagnostic",
    source: "imported_json",
    accessToken: "diagnostic-token",
    disabled: false,
    health: { healthy: true, consecutiveFailures: 0 },
    quotaModels: []
  };
}

export async function dryRunSpawn(
  config: ProxyConfig,
  lsCorePath: string | undefined,
  certPath: string | undefined,
  timeoutMs: number,
  spawnFn: SpawnFn = spawn
): Promise<LsDiagnosticResult["process"]> {
  if (!lsCorePath || !existsSync(lsCorePath)) {
    return { spawnSuccess: false };
  }
  const started = Date.now();
  const args = safeExtraArgs(config.ls.extraArgs);
  const options: SpawnOptionsWithoutStdio = buildLsSpawnOptions(
    config,
    diagnosticAccount(),
    config.gemini.defaultModel,
    "http://127.0.0.1:0",
    "diagnostic-secret",
    certPath
  );

  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    let child: ChildProcess | undefined;
    const done = (result: LsDiagnosticResult["process"]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child?.kill();
      resolve({
        ...result,
        startupTimeMs: Date.now() - started,
        stderr: result.stderr ? sanitizeText(config, result.stderr) : undefined
      });
    };
    const timer = setTimeout(() => {
      done({ spawnSuccess: true, pid: child?.pid });
    }, Math.min(Math.max(timeoutMs, 2000), 5000));

    try {
      child = spawnFn(lsCorePath, args, options);
      child.stderr?.on("data", (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-2000);
      });
      child.once("spawn", () => {
        if (timeoutMs <= 0) {
          done({ spawnSuccess: true, pid: child?.pid });
        }
      });
      child.once("exit", (code) => {
        done({ spawnSuccess: true, pid: child?.pid, exitCode: code, stderr });
      });
      child.once("error", (error) => {
        done({ spawnSuccess: false, pid: child?.pid, stderr: sanitizeError(error).message });
      });
    } catch (error) {
      done({ spawnSuccess: false, stderr: sanitizeError(error).message });
    }
  });
}

export class LsDiagnostics {
  private lastResult: LsDiagnosticResult | undefined;

  constructor(private readonly runtime: Runtime, private readonly spawnFn: SpawnFn = spawn) {}

  snapshot(): LsDiagnosticResult | undefined {
    return this.lastResult;
  }

  status() {
    const provision = this.runtime.assetProvisioner.status();
    return {
      nativeEnabled: this.runtime.config.ls.nativeEnabled,
      selectedTransport: this.runtime.config.ls.transport,
      binary: provision.binary,
      cert: provision.cert,
      streamingSupport: streamSupport(this.runtime.config),
      last: this.lastResult
    };
  }

  async run(options: LsDiagnosticRunOptions = {}): Promise<LsDiagnosticResult> {
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? this.runtime.config.ls.requestTimeoutMs, 1000), 30000);
    const provision = this.runtime.assetProvisioner.status();
    const result: LsDiagnosticResult = {
      checkedAt: new Date().toISOString(),
      nativeEnabled: this.runtime.config.ls.nativeEnabled,
      selectedTransport: this.runtime.config.ls.transport,
      binary: provision.binary,
      cert: provision.cert,
      process: { spawnSuccess: false },
      handshake: { success: false },
      nativeRequest: { success: false },
      streamingSupport: streamSupport(this.runtime.config),
      fallbackUsed: false
    };

    result.process = await dryRunSpawn(this.runtime.config, provision.lsCorePath, provision.certPath, timeoutMs, this.spawnFn);
    if (!provision.ready || !provision.lsCorePath) {
      result.error = { code: "LsCoreMissing", message: provision.lastError ?? "ls_core asset was not found" };
      this.lastResult = result;
      return result;
    }

    const account = await this.runtime.cloudCodeAccounts.select(this.runtime.config.gemini.defaultModel);
    if (!account) {
      result.error = { code: "LsCoreMissing", message: "No healthy account is available for native LS" };
      this.lastResult = result;
      return result;
    }

    try {
      const instance = await this.runtime.lsOrchestrator.startOrReuse(account, this.runtime.config.gemini.defaultModel);
      result.process.pid = instance.pid ?? result.process.pid;
      const handshakeStatus = await this.runtime.lsOrchestrator.handshake(instance.id, timeoutMs);
      result.handshake = { success: true, status: handshakeStatus };
    } catch (error) {
      result.error = sanitizeError(error);
      if (result.error.code === "LsRequestTimeout") {
        result.error = sanitizeError(new LsRequestTimeout());
      } else if (result.error.code === "LsProtocolError") {
        result.error = sanitizeError(new LsProtocolError(result.error.message));
      }
      this.lastResult = result;
      return result;
    }

    try {
      await this.runtime.nativeLsClient.request(
        this.runtime.config.gemini.defaultModel,
        "openai",
        {
          model: this.runtime.config.gemini.defaultModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1
        },
        false,
        AbortSignal.timeout(timeoutMs)
      );
      result.nativeRequest = { success: true, responseReceived: true };
    } catch (error) {
      result.error = sanitizeError(error);
      if (!options.disableFallback && this.runtime.config.ls.providerFallback) {
        result.fallbackUsed = true;
        result.nativeRequest = { success: false, responseReceived: false };
      }
    }

    this.lastResult = result;
    return result;
  }
}
