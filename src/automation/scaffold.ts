import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type InitAutomationWorkspaceOptions = {
  workspaceDir?: string;
  projectName?: string;
  force?: boolean;
};

export type InitAutomationWorkspaceResult = {
  workspaceDir: string;
  orchestratorDir: string;
  createdFiles: string[];
};

function defaultProjectName(workspaceDir: string): string {
  return basename(workspaceDir) || "project";
}

function writeScaffoldFile(path: string, content: string, force: boolean, createdFiles: string[]): void {
  if (existsSync(path) && !force) {
    return;
  }
  writeFileSync(path, content, "utf8");
  createdFiles.push(path);
}

function normalizeProjectSlug(projectName: string): string {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

function planTemplate(projectName: string): string {
  const projectSlug = normalizeProjectSlug(projectName);
  return `${JSON.stringify(
    {
      goal: `${projectName} backlog'unu fazlar halinde ilerlet, bitmeyen işleri sonraki görevlere taşı ve her turda repo durumunu doğrula.`,
      workspaceDir: ".",
      globalContextFiles: [
        ".own-ag/orchestrator/PROJECT_BRIEF.md",
        ".own-ag/orchestrator/BACKLOG.md",
        ".own-ag/orchestrator/RUNBOOK.md"
      ],
      phases: [
        {
          id: "discovery",
          title: "Discovery",
          objective: "Repo yüzeyini, aktif backlog maddelerini ve riskleri netleştir.",
          tasks: [
            {
              id: `${projectSlug}-claude-discovery`,
              title: "Repo surface and implementation map",
              provider: "claude",
              model: "claude-sonnet-4-6",
              role: "repo mapper and implementation planner",
              prompt:
                "Repoyu incele, ilgili modulleri belirle, en kritik backlog maddesini seç ve dusuk riskli net degisiklikleri dogrudan uygula. JSON summary kisa ve net olsun."
            },
            {
              id: `${projectSlug}-gemini-risk`,
              title: "Risk and regression review",
              provider: "gemini",
              model: "gemini-2.5-pro",
              role: "integration reviewer",
              prompt:
                "Bir onceki gorevin ciktilarini denetle, regression risklerini ve eksik kalan isleri tanimla, gerekiyorsa backlog icin net follow-up maddeleri uret."
            }
          ]
        },
        {
          id: "execution",
          title: "Execution",
          objective: "Secilen backlog maddesini ilerlet ve sonraki turun girisini hazirla.",
          tasks: [
            {
              id: `${projectSlug}-claude-implementation`,
              title: "Implement the next backlog slice",
              provider: "claude",
              model: "claude-sonnet-4-6",
              role: "implementation owner",
              prompt:
                "En yuksek oncelikli backlog maddesini ilerlet, gerekli kod degisikliklerini yap, test veya dogrulama calistirabiliyorsan calistir ve sonucunu summary ile belirt."
            },
            {
              id: `${projectSlug}-gemini-qa`,
              title: "QA and next-step queue",
              provider: "gemini",
              model: "gemini-2.5-pro",
              role: "qa and handoff reviewer",
              prompt:
                "Yapilan degisiklikleri gozden gecir, test ve entegrasyon aciklarini cikar, sonraki tur icin backloga eklenecek net maddeler uret."
            }
          ]
        }
      ]
    },
    null,
    2
  )}\n`;
}

function projectBriefTemplate(projectName: string): string {
  return `# ${projectName}

## Product Goal
Bu bolumu projenin ne yaptigi ve kullaniciya hangi degeri sagladigi ile doldur.

## Technical Goal
Bu bolume teknik hedefleri, mimari sinirlari ve degistirilmemesi gereken kritik alanlari yaz.

## Constraints
- Runtime ve deployment beklentileri
- Security veya compliance gereksinimleri
- Dokunulmamasini istedigin moduller

## Definition of Done
- Hangi testler yesil olmali
- Hangi user flow'lar manuel kontrol edilmeli
- Hangi artifact veya ciktilar uretilmeli
`;
}

function backlogTemplate(): string {
  return `# Backlog

## Active
- [ ] Ilk hedefi buraya yaz

## Next
- [ ] Sonraki hedef

## Risks
- Kritik teknik risk veya bilinmeyenler

## Notes
- Orkestrator her turda buradaki aktif maddeleri context olarak gorecek.
- Tamamlanan maddeleri [x] ile isaretleyip yeni maddeleri asagi ekleyebilirsin.
`;
}

function runbookTemplate(): string {
  return `# Runbook

## Usage
1. Bu dizindeki ` + "`plan.json`" + ` dosyasini backlog'a gore guncelle.
2. Gerekirse ` + "`PROJECT_BRIEF.md`" + ` ve ` + "`BACKLOG.md`" + ` dosyalarini yenile.
3. ` + "`.\\run.ps1`" + ` ile orkestrasyonu baslat.

## Conventions
- Her task strict JSON dondurur.
- Bitmeyen isler followup veya unresolved olarak sonraki tasklara tasinir.
- Run artifact'lari workspace altindaki ` + "`.own-ag-runs/`" + ` klasorune yazilir.

## Maintenance
- Provider/model dagilimini ihtiyaca gore ` + "`plan.json`" + ` icinde degistir.
- Task prompt'larini proje ritmine gore sertlestir veya yumusat.
- Uzun sureli projelerde backlog bolumlerini duzenli temizle.
`;
}

function runScriptTemplate(): string {
  return `param(
  [string]$OwnAgCli = "own-ag",
  [switch]$Direct
)

$workspace = Resolve-Path (Join-Path $PSScriptRoot "..\\..")
$plan = Join-Path $PSScriptRoot "plan.json"
$args = @(
  "automate",
  "--plan",
  $plan,
  "--workspace",
  $workspace
)

if ($Direct) {
  $args += "--direct"
}

& $OwnAgCli @args
exit $LASTEXITCODE
`;
}

export function initAutomationWorkspace(options: InitAutomationWorkspaceOptions = {}): InitAutomationWorkspaceResult {
  const workspaceDir = resolve(options.workspaceDir ?? process.cwd());
  const projectName = options.projectName?.trim() || defaultProjectName(workspaceDir);
  const orchestratorDir = join(workspaceDir, ".own-ag", "orchestrator");
  const createdFiles: string[] = [];

  mkdirSync(orchestratorDir, { recursive: true });

  writeScaffoldFile(join(orchestratorDir, "plan.json"), planTemplate(projectName), Boolean(options.force), createdFiles);
  writeScaffoldFile(
    join(orchestratorDir, "PROJECT_BRIEF.md"),
    projectBriefTemplate(projectName),
    Boolean(options.force),
    createdFiles
  );
  writeScaffoldFile(join(orchestratorDir, "BACKLOG.md"), backlogTemplate(), Boolean(options.force), createdFiles);
  writeScaffoldFile(join(orchestratorDir, "RUNBOOK.md"), runbookTemplate(), Boolean(options.force), createdFiles);
  writeScaffoldFile(join(orchestratorDir, "run.ps1"), runScriptTemplate(), Boolean(options.force), createdFiles);

  return {
    workspaceDir,
    orchestratorDir,
    createdFiles
  };
}
