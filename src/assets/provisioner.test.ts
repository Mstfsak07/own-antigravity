import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { AssetProvisioner } from "./provisioner.js";
import { baseTestConfig } from "../testConfig.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-provision-"));
  tempDirs.push(dir);
  return dir;
}

function lsCoreName(): string {
  return process.platform === "win32" ? "ls_core.exe" : "ls_core";
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("AssetProvisioner", () => {
  it("reports graceful error when ls_core is missing", () => {
    const dir = makeDir();
    const provisioner = new AssetProvisioner(baseTestConfig({ dataDir: dir, ls: { binDir: join(dir, "bin") } }));

    expect(provisioner.status()).toMatchObject({
      ready: false,
      source: "missing",
      lastError: "ls_core asset was not found"
    });
  });

  it("supports local-only success", async () => {
    const dir = makeDir();
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, lsCoreName()), "fake", "utf8");
    writeFileSync(join(binDir, "cert.pem"), "cert", "utf8");
    const provisioner = new AssetProvisioner(
      baseTestConfig({ dataDir: dir, ls: { binDir, provisionMode: "LocalOnly" } })
    );

    const status = await provisioner.sync("LocalOnly");

    expect(status.ready).toBe(true);
    expect(status.lsCorePath).toContain(lsCoreName());
    expect(status.certPath).toContain("cert.pem");
  });
});
