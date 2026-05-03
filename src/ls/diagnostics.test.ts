import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseTestConfig } from "../testConfig.js";
import { LsProtocolError, LsRequestTimeout } from "./errors.js";
import { dryRunSpawn, LsDiagnostics } from "./diagnostics.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-ls-diag-"));
  tempDirs.push(dir);
  return dir;
}

function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 1234;
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.kill = vi.fn();
  return child;
}

function fakeSpawn(mode: "success" | "crash" | "error", stderr = "") {
  return vi.fn((_path, _args, options) => {
    const child = fakeChild();
    child.options = options;
    setTimeout(() => {
      if (mode === "error") {
        child.emit("error", new Error(`bad secret ${process.env.OWN_AG_API_KEY ?? "token-secret"}`));
        return;
      }
      child.emit("spawn");
      if (stderr) {
        child.stderr.write(stderr);
      }
      if (mode === "crash") {
        child.emit("exit", 7);
      }
    }, 0);
    return child;
  });
}

function runtime(overrides: Record<string, unknown> = {}) {
  const dir = makeDir();
  const bin = join(dir, "ls_core.exe");
  writeFileSync(bin, "fake", "utf8");
  const config = baseTestConfig({
    dataDir: dir,
    ls: {
      nativeEnabled: true,
      providerFallback: true,
      lsCorePath: bin,
      requestTimeoutMs: 1000,
      streamMethod: "stream"
    }
  });
  const base = {
    config,
    assetProvisioner: {
      status: () => ({
        mode: "Auto",
        ready: true,
        source: "configured",
        lsCorePath: bin,
        binary: { path: bin, found: true },
        cert: { found: false }
      })
    },
    cloudCodeAccounts: {
      select: vi.fn(async () => ({
        id: "a",
        source: "imported_json",
        accessToken: "access",
        disabled: false,
        health: { healthy: true, consecutiveFailures: 0 },
        quotaModels: []
      }))
    },
    lsOrchestrator: {
      startOrReuse: vi.fn(async () => ({ id: "i", accountId: "a", status: "running", pid: 1234 })),
      handshake: vi.fn(async () => ({ initialized: true }))
    },
    nativeLsClient: {
      request: vi.fn(async () => ({ data: { ok: true }, instanceId: "i" }))
    }
  };
  return { ...base, ...overrides } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("LS diagnostics", () => {
  it("reports missing binary", async () => {
    const rt = runtime({
      assetProvisioner: {
        status: () => ({
          mode: "Auto",
          ready: false,
          source: "missing",
          binary: { found: false },
          cert: { found: false },
          lastError: "ls_core asset was not found"
        })
      }
    });
    const result = await new LsDiagnostics(rt, fakeSpawn("success") as any).run();

    expect(result.binary.found).toBe(false);
    expect(result.error?.code).toBe("LsCoreMissing");
  });

  it("dry-run spawn succeeds with shell false", async () => {
    const rt = runtime();
    const spawn = fakeSpawn("success");
    const result = await dryRunSpawn(rt.config, rt.assetProvisioner.status().lsCorePath, undefined, 0, spawn as any);

    expect(result.spawnSuccess).toBe(true);
    expect(result.pid).toBe(1234);
    expect(spawn.mock.calls[0][2].shell).toBe(false);
  });

  it("captures crash on startup", async () => {
    const rt = runtime();
    const result = await dryRunSpawn(
      rt.config,
      rt.assetProvisioner.status().lsCorePath,
      undefined,
      1000,
      fakeSpawn("crash", "startup failed") as any
    );

    expect(result.spawnSuccess).toBe(true);
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("startup failed");
  });

  it("classifies handshake timeout", async () => {
    const rt = runtime({
      lsOrchestrator: {
        startOrReuse: vi.fn(async () => ({ id: "i", accountId: "a", status: "running", pid: 1234 })),
        handshake: vi.fn(async () => {
          throw new LsRequestTimeout();
        })
      }
    });
    const result = await new LsDiagnostics(rt, fakeSpawn("crash") as any).run();

    expect(result.handshake.success).toBe(false);
    expect(result.error?.code).toBe("LsRequestTimeout");
  });

  it("classifies protocol error", async () => {
    const rt = runtime({
      lsOrchestrator: {
        startOrReuse: vi.fn(async () => ({ id: "i", accountId: "a", status: "running", pid: 1234 })),
        handshake: vi.fn(async () => {
          throw new LsProtocolError("wrong protocol");
        })
      }
    });
    const result = await new LsDiagnostics(rt, fakeSpawn("crash") as any).run();

    expect(result.error).toMatchObject({ code: "LsProtocolError", message: "wrong protocol" });
  });

  it("reports native response success", async () => {
    const result = await new LsDiagnostics(runtime(), fakeSpawn("crash") as any).run({ disableFallback: true });

    expect(result.handshake.success).toBe(true);
    expect(result.nativeRequest.success).toBe(true);
    expect(result.fallbackUsed).toBe(false);
  });

  it("fails native request when fallback is disabled", async () => {
    const rt = runtime({
      nativeLsClient: {
        request: vi.fn(async () => {
          throw new LsProtocolError("native failed");
        })
      }
    });
    const result = await new LsDiagnostics(rt, fakeSpawn("crash") as any).run({ disableFallback: true });

    expect(result.nativeRequest.success).toBe(false);
    expect(result.fallbackUsed).toBe(false);
    expect(result.error?.code).toBe("LsProtocolError");
  });

  it("marks fallback used when enabled", async () => {
    const rt = runtime({
      nativeLsClient: {
        request: vi.fn(async () => {
          throw new LsProtocolError("native failed");
        })
      }
    });
    const result = await new LsDiagnostics(rt, fakeSpawn("crash") as any).run({ disableFallback: false });

    expect(result.nativeRequest.success).toBe(false);
    expect(result.fallbackUsed).toBe(true);
  });

  it("redacts secrets from dry-run errors", async () => {
    const rt = runtime();
    process.env.OWN_AG_API_KEY = "super-secret-token";
    const result = await dryRunSpawn(
      rt.config,
      rt.assetProvisioner.status().lsCorePath,
      undefined,
      1000,
      fakeSpawn("error") as any
    );

    expect(result.stderr).not.toContain("super-secret-token");
  });
});
