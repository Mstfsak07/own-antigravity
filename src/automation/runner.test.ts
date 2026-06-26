import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baseTestConfig } from "../testConfig.js";
import { initAutomationWorkspace } from "./scaffold.js";
import { runAutomationPlan } from "./runner.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-automation-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runAutomationPlan", () => {
  it("runs plan tasks sequentially and carries followups forward", async () => {
    const dir = makeDir();
    const planPath = join(dir, "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify(
        {
          goal: "Ship a feature",
          workspaceDir: dir,
          phases: [
            {
              id: "phase-1",
              title: "Discovery",
              tasks: [
                {
                  id: "claude-discovery",
                  title: "Inspect codebase",
                  provider: "claude",
                  prompt: "Inspect the repo",
                  workspaceAccess: false
                },
                {
                  id: "gemini-plan",
                  title: "Draft next steps",
                  provider: "gemini",
                  prompt: "Use prior outputs",
                  workspaceAccess: false
                }
              ]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const prompts: string[] = [];
    const result = await runAutomationPlan(
      {
        planPath,
        workspaceDir: dir,
        outputDir: join(dir, "runs"),
        useProxy: false,
        config: baseTestConfig({ localApiKey: "local" })
      },
      {
        executeAgentCli: async ({ provider, prompt }) => {
          prompts.push(`${provider}:${prompt}`);
          if (provider === "claude") {
            return JSON.stringify({
              summary: "inspected repo",
              deliverables: ["repo map"],
              changedFiles: [],
              followupTasks: ["validate architecture choices"],
              unresolved: []
            });
          }
          return JSON.stringify({
            summary: prompt.includes("validate architecture choices") ? "used carryover" : "missing carryover",
            deliverables: ["execution outline"],
            changedFiles: [],
            followupTasks: [],
            unresolved: []
          });
        }
      }
    );

    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]?.tasks).toHaveLength(2);
    expect(result.phases[0]?.tasks[1]?.result.summary).toBe("used carryover");
    expect(prompts[1]).toContain("validate architecture choices");
    expect(readFileSync(result.summaryPath, "utf8")).toContain("inspected repo");
  });

  it("recovers from a failed provider attempt and continues with the project task", async () => {
    const dir = makeDir();
    const planPath = join(dir, "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify(
        {
          goal: "Ship a feature",
          workspaceDir: dir,
          phases: [
            {
              id: "phase-1",
              title: "Implementation",
              tasks: [
                {
                  id: "claude-implementation",
                  title: "Implement feature",
                  provider: "claude",
                  prompt: "Implement the feature"
                }
              ]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const calls: Array<{ provider: string; model: string; viaProxy: boolean }> = [];
    const result = await runAutomationPlan(
      {
        planPath,
        workspaceDir: dir,
        outputDir: join(dir, "runs"),
        useProxy: true,
        config: baseTestConfig({ localApiKey: "local" })
      },
      {
        executeAgentCli: async ({ provider, model, env }) => {
          calls.push({
            provider,
            model,
            viaProxy: Boolean(env.ANTHROPIC_BASE_URL || env.GOOGLE_GEMINI_BASE_URL)
          });
          if (provider === "claude") {
            throw new Error("claude transport failed");
          }
          return JSON.stringify({
            summary: "continued after recovery",
            deliverables: ["feature patch"],
            changedFiles: ["src/app.ts"],
            followupTasks: [],
            unresolved: []
          });
        }
      }
    );

    expect(calls.length).toBeGreaterThan(1);
    expect(result.phases[0]?.tasks[0]?.result.summary).toBe("continued after recovery");
    expect(result.phases[0]?.tasks[0]?.attempts.some((attempt) => attempt.provider === "claude" && !attempt.ok)).toBe(true);
    expect(readFileSync(result.summaryPath, "utf8")).toContain("recovery:");
  });

  it("passes global context files into task prompts", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "GLOBAL.md"), "shared context", "utf8");
    const planPath = join(dir, "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify(
        {
          goal: "Ship a feature",
          workspaceDir: dir,
          globalContextFiles: ["GLOBAL.md"],
          phases: [
            {
              id: "phase-1",
              title: "Discovery",
              tasks: [
                {
                  id: "claude-discovery",
                  title: "Inspect codebase",
                  provider: "claude",
                  prompt: "Inspect the repo",
                  workspaceAccess: false
                }
              ]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    let receivedPrompt = "";
    await runAutomationPlan(
      {
        planPath,
        workspaceDir: dir,
        outputDir: join(dir, "runs"),
        useProxy: false,
        config: baseTestConfig({ localApiKey: "local" })
      },
      {
        executeAgentCli: async ({ prompt }) => {
          receivedPrompt = prompt;
          return JSON.stringify({
            summary: "ok",
            deliverables: [],
            changedFiles: [],
            followupTasks: [],
            unresolved: []
          });
        }
      }
    );

    expect(receivedPrompt).toContain("File: GLOBAL.md");
    expect(receivedPrompt).toContain("shared context");
  });

  it("scaffolds a reusable orchestrator workspace", () => {
    const dir = makeDir();
    const result = initAutomationWorkspace({ workspaceDir: dir, projectName: "Demo Project" });

    expect(result.createdFiles.length).toBe(5);
    expect(readFileSync(join(result.orchestratorDir, "plan.json"), "utf8")).toContain("\"globalContextFiles\"");
    expect(readFileSync(join(result.orchestratorDir, "PROJECT_BRIEF.md"), "utf8")).toContain("# Demo Project");
    expect(readFileSync(join(result.orchestratorDir, "run.ps1"), "utf8")).toContain("\"automate\"");
  });
});
