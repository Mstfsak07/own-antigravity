import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { buildServer } from "../server.js";
import type { ProxyConfig } from "../types.js";

const AgentResultSchema = z.object({
  summary: z.string(),
  deliverables: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  followupTasks: z.array(z.string()).default([]),
  unresolved: z.array(z.string()).default([])
});

const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.enum(["claude", "gemini"]),
  model: z.string().optional(),
  role: z.string().optional(),
  prompt: z.string(),
  workspaceAccess: z.boolean().optional().default(true),
  contextFiles: z.array(z.string()).optional().default([]),
  passPhaseCarryover: z.boolean().optional().default(true),
  passPriorTaskOutputs: z.boolean().optional().default(true)
});

const PhaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string().optional(),
  tasks: z.array(TaskSchema).min(1)
});

const PlanSchema = z.object({
  goal: z.string(),
  workspaceDir: z.string().optional(),
  phases: z.array(PhaseSchema).min(1)
});

export type AutomationPlan = z.infer<typeof PlanSchema>;
export type AutomationTask = z.infer<typeof TaskSchema>;
export type AutomationPhase = z.infer<typeof PhaseSchema>;
export type AgentTaskResult = z.infer<typeof AgentResultSchema>;

export type RunPlanOptions = {
  planPath: string;
  workspaceDir?: string;
  outputDir?: string;
  useProxy?: boolean;
  config: ProxyConfig;
};

function quoteWindowsArg(value: string): string {
  if (value.length === 0) {
    return "\"\"";
  }

  if (!/[\s"&|<>^()]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

type ExecuteAgentCliInput = {
  provider: "claude" | "gemini";
  model: string;
  workspaceDir: string;
  prompt: string;
  workspaceAccess: boolean;
  env: NodeJS.ProcessEnv;
};

export type ExecuteAgentCli = (input: ExecuteAgentCliInput) => Promise<string>;

type RunDependencies = {
  executeAgentCli?: ExecuteAgentCli;
};

type AttemptRecord = {
  provider: "claude" | "gemini";
  model: string;
  viaProxy: boolean;
  ok: boolean;
  error?: string;
};

type TaskRunRecord = {
  id: string;
  title: string;
  provider: "claude" | "gemini";
  model: string;
  rawOutputPath: string;
  parsedOutputPath: string;
  result: AgentTaskResult;
  attempts: AttemptRecord[];
};

type PhaseRunRecord = {
  id: string;
  title: string;
  objective?: string;
  tasks: TaskRunRecord[];
  carryover: string[];
};

export type AutomationRunResult = {
  runDir: string;
  workspaceDir: string;
  plan: AutomationPlan;
  phases: PhaseRunRecord[];
  summaryPath: string;
  reportPath: string;
};

export function loadAutomationPlan(planPath: string): AutomationPlan {
  const resolved = resolve(planPath);
  const raw = readFileSync(resolved, "utf8");
  return PlanSchema.parse(JSON.parse(raw));
}

function defaultModelFor(provider: "claude" | "gemini", config: ProxyConfig): string {
  return provider === "claude" ? "claude-sonnet-4-6" : config.gemini.defaultModel;
}

function fallbackProviderFor(provider: "claude" | "gemini"): "claude" | "gemini" {
  return provider === "claude" ? "gemini" : "claude";
}

function fallbackModelFor(provider: "claude" | "gemini", currentModel: string, config: ProxyConfig): string {
  if (provider === "claude") {
    if (currentModel !== "claude-sonnet-4-6") {
      return "claude-sonnet-4-6";
    }
    return "claude-opus-4-1";
  }

  if (currentModel !== config.gemini.defaultModel) {
    return config.gemini.defaultModel;
  }
  return "gemini-2.5-flash";
}

function buildProxyEnv(
  provider: "claude" | "gemini",
  config: ProxyConfig,
  useProxy: boolean | undefined
): NodeJS.ProcessEnv {
  if (!useProxy) {
    return { ...process.env };
  }

  const baseUrl = `http://${config.host}:${config.port}`;
  if (provider === "claude") {
    return {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_URL: baseUrl,
      ANTHROPIC_API_KEY: config.localApiKey ?? process.env.ANTHROPIC_API_KEY ?? "local",
      ANTHROPIC_AUTH_TOKEN: config.localApiKey ?? process.env.ANTHROPIC_API_KEY ?? "local"
    };
  }

  return {
    ...process.env,
    GOOGLE_GEMINI_BASE_URL: baseUrl,
    GEMINI_API_KEY: config.localApiKey ?? process.env.GEMINI_API_KEY ?? "local"
  };
}

function buildTaskPrompt(
  plan: AutomationPlan,
  phase: AutomationPhase,
  task: AutomationTask,
  workspaceDir: string,
  priorTaskResults: TaskRunRecord[],
  phaseCarryover: string[]
): string {
  const priorOutputs = task.passPriorTaskOutputs && priorTaskResults.length > 0
    ? priorTaskResults
        .map(
          (item) =>
            `- ${item.id} (${item.provider}/${item.model}): ${item.result.summary}${
              item.result.followupTasks.length > 0 ? ` | followups: ${item.result.followupTasks.join("; ")}` : ""
            }`
        )
        .join("\n")
    : "None";

  const carryover = task.passPhaseCarryover && phaseCarryover.length > 0
    ? phaseCarryover.map((item) => `- ${item}`).join("\n")
    : "None";

  const contextSections = task.contextFiles
    .map((filePath) => {
      const resolved = resolve(workspaceDir, filePath);
      if (!existsSync(resolved)) {
        return `File: ${filePath}\n[missing]`;
      }

      return `File: ${filePath}\n${readFileSync(resolved, "utf8")}`;
    })
    .join("\n\n---\n\n");

  return [
    `You are working inside workspace: ${plan.workspaceDir ?? "."}`,
    `Global goal: ${plan.goal}`,
    `Current phase: ${phase.title}${phase.objective ? ` - ${phase.objective}` : ""}`,
    `Current task: ${task.title}`,
    task.role ? `Assigned role: ${task.role}` : undefined,
    "",
    "Prior completed task outputs:",
    priorOutputs,
    "",
    "Carryover items from earlier tasks/phases:",
    carryover,
    "",
    task.contextFiles.length > 0 ? "Context file contents:" : undefined,
    task.contextFiles.length > 0 ? contextSections : undefined,
    task.contextFiles.length > 0 ? "" : undefined,
    "Task instructions:",
    task.prompt,
    "",
    "If a previous execution attempt failed, first repair the failure mode or work around it, then continue the project task.",
    "",
    "Return strict JSON only with this shape:",
    JSON.stringify(
      {
        summary: "short status summary",
        deliverables: ["what you completed"],
        changedFiles: ["relative/path.ts"],
        followupTasks: ["what the next task should continue"],
        unresolved: ["known gaps or blockers"]
      },
      null,
      2
    ),
    "",
    "If you edit files, include them in changedFiles. Do not include markdown fences."
  ]
    .filter(Boolean)
    .join("\n");
}

function extractJsonObject(raw: string): AgentTaskResult {
  const trimmed = raw.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      if ("summary" in parsed) {
        return AgentResultSchema.parse(parsed);
      }

      if (typeof (parsed as { result?: unknown }).result === "string") {
        return extractJsonObject((parsed as { result: string }).result);
      }

      if (typeof (parsed as { response?: unknown }).response === "string") {
        return extractJsonObject((parsed as { response: string }).response);
      }
    }
  } catch {
    // Fall through to substring extraction.
  }

  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenceMatch?.[1] ?? trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Agent output did not contain a JSON object");
  }

  const slice = candidate.slice(firstBrace, lastBrace + 1);
  return AgentResultSchema.parse(JSON.parse(slice));
}

async function ensureGateway(config: ProxyConfig): Promise<(() => Promise<void>) | undefined> {
  const healthUrl = `http://${config.host}:${config.port}/health`;
  try {
    const response = await fetch(healthUrl);
    if (response.ok) {
      return undefined;
    }
  } catch {
    // Start a local ephemeral server only when nothing is listening.
  }

  const app = buildServer(config);
  await app.listen({ host: config.host, port: config.port });
  return async () => {
    await app.close();
  };
}

export async function executeAgentCli(input: ExecuteAgentCliInput): Promise<string> {
  const baseCommand = input.provider === "claude" ? "claude" : "gemini";
  const command = process.platform === "win32" ? `${baseCommand}.cmd` : baseCommand;
  const promptViaStdin = !input.workspaceAccess;
  const useGeminiWindowsPromptFile = process.platform === "win32" && input.provider === "gemini" && promptViaStdin;
  const stdinPromptPath = useGeminiWindowsPromptFile
    ? join(input.workspaceDir, `.own-ag-gemini-stdin-${Date.now()}.txt`)
    : undefined;
  const args =
    input.provider === "claude"
      ? [
          "--print",
          "--output-format",
          "json",
          "--model",
          input.model,
          ...(promptViaStdin ? [] : [input.prompt]),
          ...(input.workspaceAccess ? ["--dangerously-skip-permissions", "--add-dir", input.workspaceDir] : [])
        ]
      : [
          ...(promptViaStdin ? ["--prompt", "Use the full task instructions from stdin and ignore this placeholder."] : [input.prompt]),
          "--model",
          input.model,
          "--output-format",
          "json",
          ...(input.workspaceAccess
            ? ["--yolo", "--skip-trust", "--include-directories", input.workspaceDir]
            : ["--approval-mode", "plan"])
        ];

  if (stdinPromptPath) {
    writeFileSync(stdinPromptPath, input.prompt, "utf8");
  }

  return new Promise((resolvePromise, reject) => {
    const child =
      useGeminiWindowsPromptFile && stdinPromptPath
        ? spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `$p = Get-Content -Raw '${stdinPromptPath.replace(/'/g, "''")}'; $p | gemini.cmd --prompt "Use the full task instructions from stdin and ignore this placeholder." --model ${input.model} --output-format json --approval-mode plan; exit $LASTEXITCODE`
            ],
            {
              cwd: input.workspaceDir,
              env: input.env,
              shell: false,
              windowsHide: true
            }
          )
        : process.platform === "win32"
        ? spawn(
            process.env.ComSpec ?? "cmd.exe",
            [
              "/d",
              "/s",
              "/c",
              [command, ...args].map(quoteWindowsArg).join(" ")
            ],
            {
            cwd: input.workspaceDir,
            env: input.env,
            shell: false,
            windowsHide: true
            }
          )
        : spawn(command, args, {
            cwd: input.workspaceDir,
            env: input.env,
            shell: false,
            windowsHide: true
          });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    if (promptViaStdin && !useGeminiWindowsPromptFile) {
      child.stdin.write(input.prompt);
      child.stdin.end();
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (stdinPromptPath && existsSync(stdinPromptPath)) {
        unlinkSync(stdinPromptPath);
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim() || "unknown error"}`));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

async function runTaskWithRecovery(
  task: AutomationTask,
  model: string,
  prompt: string,
  workspaceDir: string,
  options: RunPlanOptions,
  executor: ExecuteAgentCli,
  workspaceAccess: boolean
): Promise<{ rawOutput: string; result: AgentTaskResult; provider: "claude" | "gemini"; model: string; attempts: AttemptRecord[] }> {
  const attempts: AttemptRecord[] = [];
  const candidates: Array<{ provider: "claude" | "gemini"; model: string; viaProxy: boolean }> = [];
  const preferredProxy = options.useProxy ?? true;
  const fallbackProvider = fallbackProviderFor(task.provider);

  candidates.push({ provider: task.provider, model, viaProxy: preferredProxy });
  candidates.push({ provider: task.provider, model, viaProxy: !preferredProxy });

  const fallbackModel = fallbackModelFor(task.provider, model, options.config);
  if (fallbackModel !== model) {
    candidates.push({ provider: task.provider, model: fallbackModel, viaProxy: preferredProxy });
  }

  candidates.push({
    provider: fallbackProvider,
    model: defaultModelFor(fallbackProvider, options.config),
    viaProxy: preferredProxy
  });

  let lastError = "Unknown agent failure";
  for (const candidate of candidates) {
    try {
      const rawOutput = await executor({
        provider: candidate.provider,
        model: candidate.model,
        workspaceDir,
        prompt,
        workspaceAccess,
        env: buildProxyEnv(candidate.provider, options.config, candidate.viaProxy)
      });
      let result: AgentTaskResult;
      try {
        result = extractJsonObject(rawOutput);
      } catch (error) {
        const parseMessage = error instanceof Error ? error.message : String(error);
        const snippet = rawOutput.slice(0, 1200).replace(/\s+/g, " ").trim();
        throw new Error(`${parseMessage} | raw: ${snippet || "[empty]"}`);
      }
      attempts.push({ ...candidate, ok: true });
      return {
        rawOutput,
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      attempts.push({
        ...candidate,
        ok: false,
        error: lastError
      });
    }
  }

  const recoveryResult: AgentTaskResult = {
    summary: `Task could not be completed automatically after agent recovery attempts: ${lastError}`,
    deliverables: [],
    changedFiles: [],
    followupTasks: [
      `Retry task "${task.title}" after fixing provider/CLI issue`,
      `Inspect failed attempts in automation run artifacts before resuming implementation`
    ],
    unresolved: attempts
      .filter((attempt) => !attempt.ok)
      .map(
        (attempt) =>
          `${attempt.provider}/${attempt.model} via ${attempt.viaProxy ? "proxy" : "direct"} failed: ${attempt.error ?? "unknown error"}`
      )
  };

  return {
    rawOutput: JSON.stringify(recoveryResult, null, 2),
    result: recoveryResult,
    provider: task.provider,
    model,
    attempts
  };
}

export async function runAutomationPlan(
  options: RunPlanOptions,
  dependencies: RunDependencies = {}
): Promise<AutomationRunResult> {
  const plan = loadAutomationPlan(options.planPath);
  const workspaceDir = resolve(options.workspaceDir ?? plan.workspaceDir ?? process.cwd());
  const runRoot = resolve(options.outputDir ?? join(workspaceDir, ".own-ag-runs"));
  const runDir = join(runRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  const runPhases: PhaseRunRecord[] = [];
  const runTasksFlat: TaskRunRecord[] = [];

  if (!existsSync(workspaceDir)) {
    throw new Error(`Workspace directory was not found: ${workspaceDir}`);
  }

  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  const closeGateway = await ensureGateway(options.config);
  const executor = dependencies.executeAgentCli ?? executeAgentCli;

  try {
    for (const phase of plan.phases) {
      const phaseDir = join(runDir, phase.id);
      mkdirSync(phaseDir, { recursive: true });

      const phaseRecord: PhaseRunRecord = {
        id: phase.id,
        title: phase.title,
        objective: phase.objective,
        tasks: [],
        carryover: []
      };

      for (const task of phase.tasks) {
        const model = task.model ?? defaultModelFor(task.provider, options.config);
        const prompt = buildTaskPrompt(plan, phase, task, workspaceDir, runTasksFlat, phaseRecord.carryover);
        const promptPath = join(phaseDir, `${task.id}.prompt.md`);
        writeFileSync(promptPath, `${prompt}\n`, "utf8");
        const relativePromptPath = relative(workspaceDir, promptPath).replace(/\\/g, "/");
        const cliPrompt =
          `Read the task instructions from "${relativePromptPath}" in the workspace, follow them exactly, and return strict JSON only with no markdown fences.`;
        const taskRun = await runTaskWithRecovery(
          task,
          model,
          task.workspaceAccess ? cliPrompt : prompt,
          workspaceDir,
          options,
          executor,
          task.workspaceAccess
        );
        const rawOutput = taskRun.rawOutput;
        const result = taskRun.result;
        const rawOutputPath = join(phaseDir, `${task.id}.raw.txt`);
        const parsedOutputPath = join(phaseDir, `${task.id}.json`);

        writeFileSync(rawOutputPath, `${rawOutput}\n`, "utf8");
        writeFileSync(parsedOutputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        writeFileSync(join(phaseDir, `${task.id}.attempts.json`), `${JSON.stringify(taskRun.attempts, null, 2)}\n`, "utf8");

        phaseRecord.carryover.push(...result.followupTasks, ...result.unresolved);

        const taskRecord: TaskRunRecord = {
          id: task.id,
          title: task.title,
          provider: taskRun.provider,
          model: taskRun.model,
          rawOutputPath,
          parsedOutputPath,
          result,
          attempts: taskRun.attempts
        };
        phaseRecord.tasks.push(taskRecord);
        runTasksFlat.push(taskRecord);
      }

      runPhases.push(phaseRecord);
    }
  } finally {
    if (closeGateway) {
      await closeGateway();
    }
  }

  const report = {
    workspaceDir,
    runDir,
    phases: runPhases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      objective: phase.objective,
      carryover: phase.carryover,
      tasks: phase.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        provider: task.provider,
        model: task.model,
        attempts: task.attempts,
        result: task.result,
        rawOutputPath: task.rawOutputPath,
        parsedOutputPath: task.parsedOutputPath
      }))
    }))
  };
  const reportPath = join(runDir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const summaryLines = [
    `# Automation Run`,
    ``,
    `Workspace: ${workspaceDir}`,
    `Plan goal: ${plan.goal}`,
    `Run dir: ${runDir}`,
    ``
  ];

  for (const phase of runPhases) {
    summaryLines.push(`## ${phase.title}`);
    if (phase.objective) {
      summaryLines.push(phase.objective);
      summaryLines.push("");
    }
    for (const task of phase.tasks) {
      summaryLines.push(`- ${task.id} [${task.provider}/${task.model}]: ${task.result.summary}`);
      for (const item of task.result.deliverables) {
        summaryLines.push(`  deliverable: ${item}`);
      }
      for (const item of task.result.followupTasks) {
        summaryLines.push(`  followup: ${item}`);
      }
      for (const item of task.result.unresolved) {
        summaryLines.push(`  unresolved: ${item}`);
      }
      if (task.attempts.some((attempt) => !attempt.ok)) {
        for (const attempt of task.attempts.filter((attempt) => !attempt.ok)) {
          summaryLines.push(
            `  recovery: ${attempt.provider}/${attempt.model} via ${attempt.viaProxy ? "proxy" : "direct"} failed - ${attempt.error ?? "unknown"}`
          );
        }
      }
    }
    summaryLines.push("");
  }

  const summaryPath = join(runDir, "SUMMARY.md");
  writeFileSync(summaryPath, `${summaryLines.join("\n")}\n`, "utf8");

  return {
    runDir,
    workspaceDir,
    plan,
    phases: runPhases,
    summaryPath,
    reportPath
  };
}
