#!/usr/bin/env node
import { configPath, loadConfig, writeDefaultConfig } from "./config.js";
import { initAutomationWorkspace } from "./automation/scaffold.js";
import { runAutomationPlan } from "./automation/runner.js";
import { startServer } from "./server.js";

function printHelp(): void {
  process.stdout.write(`own-ag

Usage:
  own-ag server [--host 127.0.0.1] [--port 8046]
  own-ag init
  own-ag doctor
  own-ag diagnose:ls
  own-ag accounts
  own-ag automate:init [--workspace .] [--name MyProject] [--force]
  own-ag automate --plan .\\plan.json [--workspace .] [--output-dir .\\.own-ag-runs] [--direct]

Environment:
  OWN_AG_PORT, OWN_AG_HOST, OWN_AG_API_KEY
  OWN_AG_CLOUDCODE_ENABLED, OWN_AG_CLOUDCODE_ACCOUNTS_DIR
  OWN_AG_GEMINI_API_KEY, GEMINI_BASE_URL, GEMINI_DEFAULT_MODEL
  OWN_AG_ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_VERSION
`);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

async function main(): Promise<void> {
  const [, , command = "help", ...args] = process.argv;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    const created = writeDefaultConfig();
    process.stdout.write(created ? `Created ${configPath}\n` : `Config already exists at ${configPath}\n`);
    return;
  }

  if (command === "doctor") {
    const config = loadConfig();
    process.stdout.write(
      `${JSON.stringify(
        {
          configPath,
          host: config.host,
          port: config.port,
          hasLocalApiKey: Boolean(config.localApiKey),
          gemini: {
            baseUrl: config.gemini.baseUrl,
            defaultModel: config.gemini.defaultModel,
            hasApiKey: Boolean(config.gemini.apiKey)
          },
          anthropic: {
            baseUrl: config.anthropic.baseUrl,
            version: config.anthropic.version,
            hasApiKey: Boolean(config.anthropic.apiKey)
          },
          cloudCode: {
            enabled: config.cloudCode.enabled,
            accountsDir: config.cloudCode.accountsDir,
            baseUrls: config.cloudCode.baseUrls
          }
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (command === "accounts") {
    const { loadCloudCodeAccounts } = await import("./cloudCode/accounts.js");
    const config = loadConfig();
    const accounts = loadCloudCodeAccounts(config).map((account) => ({
      id: account.id,
      email: account.email,
      projectId: account.projectId,
      expiresAt: account.expiresAt ? new Date(account.expiresAt * 1000).toISOString() : undefined,
      modelCount: account.quotaModels.length,
      claudeModels: account.quotaModels
        .filter((model) => model.name.toLowerCase().includes("claude"))
        .map((model) => ({
          name: model.name,
          percentage: model.percentage,
          resetTime: model.resetTime
        }))
    }));
    process.stdout.write(`${JSON.stringify({ count: accounts.length, accounts }, null, 2)}\n`);
    return;
  }

  if (command === "diagnose:ls") {
    const { createRuntime } = await import("./runtime.js");
    const config = loadConfig();
    const runtime = createRuntime(config);
    try {
      const result = await runtime.lsDiagnostics.run({ disableFallback: true, timeoutMs: 10000 });
      const rows = [
        ["native enabled", String(result.nativeEnabled)],
        ["transport", result.selectedTransport],
        ["binary", result.binary.found ? `found ${result.binary.path ?? ""}` : "missing"],
        ["cert", result.cert.found ? `found ${result.cert.path ?? ""}` : "missing"],
        ["spawn", result.process.spawnSuccess ? `ok pid=${result.process.pid ?? "n/a"}` : "fail"],
        ["startup", result.process.startupTimeMs !== undefined ? `${result.process.startupTimeMs}ms` : "n/a"],
        ["handshake", result.handshake.success ? "ok" : "fail"],
        ["native request", result.nativeRequest.success ? "ok" : "fail"],
        ["streaming", result.streamingSupport],
        ["fallback used", String(result.fallbackUsed)],
        ["error", result.error ? `${result.error.code}: ${result.error.message}` : "none"]
      ];
      const width = Math.max(...rows.map(([key]) => key.length));
      process.stdout.write(`${rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join("\n")}\n`);
    } finally {
      runtime.accountRegistry.close();
    }
    return;
  }

  if (command === "server") {
    const host = optionValue(args, "--host");
    const portRaw = optionValue(args, "--port");
    const port = portRaw ? Number.parseInt(portRaw, 10) : undefined;
    await startServer(loadConfig({ ...(host ? { host } : {}), ...(port ? { port } : {}) }));
    return;
  }

  if (command === "automate") {
    const planPath = optionValue(args, "--plan");
    if (!planPath) {
      throw new Error("Missing required --plan option");
    }
    const workspaceDir = optionValue(args, "--workspace");
    const outputDir = optionValue(args, "--output-dir");
    const direct = args.includes("--direct");
    const result = await runAutomationPlan({
      planPath,
      workspaceDir,
      outputDir,
      useProxy: !direct,
      config: loadConfig()
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          runDir: result.runDir,
          workspaceDir: result.workspaceDir,
          summaryPath: result.summaryPath,
          reportPath: result.reportPath,
          phases: result.phases.map((phase) => ({
            id: phase.id,
            title: phase.title,
            taskCount: phase.tasks.length,
            carryoverCount: phase.carryover.length
          }))
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (command === "automate:init") {
    const workspaceDir = optionValue(args, "--workspace");
    const projectName = optionValue(args, "--name");
    const force = args.includes("--force");
    const result = initAutomationWorkspace({ workspaceDir, projectName, force });
    process.stdout.write(
      `${JSON.stringify(
        {
          workspaceDir: result.workspaceDir,
          orchestratorDir: result.orchestratorDir,
          createdFiles: result.createdFiles
        },
        null,
        2
      )}\n`
    );
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
