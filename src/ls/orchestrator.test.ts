import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { AssetProvisioner } from "../assets/provisioner.js";
import { baseTestConfig } from "../testConfig.js";
import type { CloudCodeAccount } from "../types.js";
import { buildLsSpawnOptions, LsOrchestrator } from "./orchestrator.js";
import { InternalTokenServer } from "./tokenServer.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-ls-"));
  tempDirs.push(dir);
  return dir;
}

function account(id: string): CloudCodeAccount {
  return {
    id,
    filePath: "",
    source: "imported_json",
    accessToken: `token-${id}`,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    disabled: false,
    health: { healthy: true, consecutiveFailures: 0 },
    quotaModels: []
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("LsOrchestrator", () => {
  it("starts and reuses an instance for the same account", async () => {
    const dir = makeDir();
    const config = baseTestConfig({
      dataDir: dir,
      ls: {
        lsCorePath: process.execPath,
        binDir: join(dir, "bin"),
        instanceTtlSeconds: 1800,
        maxInstances: 3,
        extraArgs: ["-e", "setInterval(function(){},1000)"]
      }
    });
    const tokenServer = new InternalTokenServer(config, (id) => account(id));
    const orchestrator = new LsOrchestrator(config, new AssetProvisioner(config), tokenServer, (id) => account(id));

    const first = await orchestrator.startOrReuse(account("a"));
    const second = await orchestrator.startOrReuse(account("a"));

    expect(second.id).toBe(first.id);
    expect(orchestrator.list()).toHaveLength(1);
    orchestrator.stop(first.id);
    await tokenServer.stop();
  });

  it("cleans up expired instances", async () => {
    const dir = makeDir();
    const config = baseTestConfig({
      dataDir: dir,
      ls: {
        lsCorePath: process.execPath,
        binDir: join(dir, "bin"),
        instanceTtlSeconds: 1,
        maxInstances: 3,
        extraArgs: ["-e", "setInterval(function(){},1000)"]
      }
    });
    const tokenServer = new InternalTokenServer(config, (id) => account(id));
    const orchestrator = new LsOrchestrator(config, new AssetProvisioner(config), tokenServer, (id) => account(id));
    const instance = await orchestrator.startOrReuse(account("a"));

    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(orchestrator.cleanupExpired()).toBeGreaterThanOrEqual(1);
    expect(orchestrator.list()).toHaveLength(0);
    orchestrator.stop(instance.id);
    await tokenServer.stop();
  });

  it("reclaims least recently used instance", async () => {
    const dir = makeDir();
    const config = baseTestConfig({
      dataDir: dir,
      ls: {
        lsCorePath: process.execPath,
        binDir: join(dir, "bin"),
        instanceTtlSeconds: 1800,
        maxInstances: 1,
        extraArgs: ["-e", "setInterval(function(){},1000)"]
      }
    });
    const tokenServer = new InternalTokenServer(config, (id) => account(id));
    const orchestrator = new LsOrchestrator(config, new AssetProvisioner(config), tokenServer, (id) => account(id));

    const first = await orchestrator.startOrReuse(account("a"));
    const second = await orchestrator.startOrReuse(account("b"));

    expect(second.id).not.toBe(first.id);
    expect(orchestrator.list()).toHaveLength(1);
    expect(orchestrator.list()[0].accountId).toBe("b");
    orchestrator.stop(second.id);
    await tokenServer.stop();
  });

  it("uses shell:false for native process spawn options", () => {
    const config = baseTestConfig();
    const options = buildLsSpawnOptions(config, account("a"), "model", "http://127.0.0.1:1", "secret");

    expect(options.shell).toBe(false);
  });

  it("marks crashed process state", async () => {
    const dir = makeDir();
    const config = baseTestConfig({
      dataDir: dir,
      ls: { lsCorePath: process.execPath, binDir: join(dir, "bin"), instanceTtlSeconds: 1800, maxInstances: 3, extraArgs: ["-e", "process.exit(7)"] }
    });
    const tokenServer = new InternalTokenServer(config, (id) => account(id));
    const orchestrator = new LsOrchestrator(config, new AssetProvisioner(config), tokenServer, (id) => account(id));

    await orchestrator.startOrReuse(account("crash"));
    const startedAt = Date.now();
    while (Date.now() - startedAt < 2000) {
      const current = orchestrator.list()[0];
      if (current?.status === "crashed") {
        expect(current).toMatchObject({ status: "crashed", exitCode: 7 });
        await tokenServer.stop();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(orchestrator.list()[0]).toMatchObject({ status: "crashed", exitCode: 7 });
    await tokenServer.stop();
  });
});
