const { existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const releaseDir = join(__dirname, "..", "release");
const staleArtifacts = [
  "Own Antigravity.exe"
];

for (const relativePath of staleArtifacts) {
  const absolutePath = join(releaseDir, relativePath);
  if (!existsSync(absolutePath)) {
    continue;
  }
  rmSync(absolutePath, { force: true });
  process.stdout.write(`removed stale desktop artifact ${absolutePath}\n`);
}
