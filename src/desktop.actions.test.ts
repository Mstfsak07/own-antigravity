import { describe, expect, it, vi } from "vitest";
import { createAccountActionsController } from "../desktop/controllers/accountActions.js";

function makeController(overrides = {}) {
  const nodes: Record<string, any> = {
    exportModal: { showModal: vi.fn() },
    encryptedExport: { checked: true },
    exportOutput: { value: "" },
    runExport: {},
    importManual: {},
    importJson: {},
    manualEmail: { value: "" },
    manualRefreshToken: { value: "" },
    jsonImport: { value: "" },
    accountModal: { close: vi.fn() },
    confirmTitle: { textContent: "" },
    confirmMessage: { textContent: "" },
    confirmModal: { showModal: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    confirmAccept: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    confirmCancel: { addEventListener: vi.fn(), removeEventListener: vi.fn() }
  };
  const toast = { info: vi.fn(), success: vi.fn(), error: vi.fn() };
  const controller = createAccountActionsController({
    api: {
      exportAccounts: vi.fn().mockResolvedValue({ encrypted: false }),
      importRefreshToken: vi.fn(),
      importJson: vi.fn()
    },
    state: { apiKey: "k", theme: "light", language: "tr", trafficViews: [], trafficColumns: {} },
    toast,
    windowObject: {
      ownAg: {
        gatewayConfig: vi.fn().mockResolvedValue({ localApiKey: "k" }),
        gatewayConfigImport: vi.fn()
      }
    },
    getNode: (id: string) => nodes[id],
    setBusy: vi.fn(),
    refreshData: vi.fn(),
    renderTrafficColumns: vi.fn(),
    renderTrafficViews: vi.fn(),
    renderAll: vi.fn(),
    applyDesktopPreferences: vi.fn(),
    setTheme: vi.fn(),
    setLanguage: vi.fn(),
    snapshotDesktopPreferences: vi.fn().mockReturnValue({ apiKey: "k" }),
    ...overrides
  });
  return { controller, nodes, toast };
}

describe("desktop account actions controller", () => {
  it("detects backup bundles and prepares one-account export", () => {
    const { controller, nodes, toast } = makeController();
    expect(controller.isAppBackupBundle({ kind: "own-antigravity-backup-v1" })).toBe(true);
    expect(controller.isAppBackupBundle({ kind: "other" })).toBe(false);

    controller.exportOneAccount({ email: "a@example.com" });
    expect(nodes.exportModal.showModal).toHaveBeenCalled();
    expect(nodes.encryptedExport.checked).toBe(false);
    expect(nodes.exportOutput.value).toContain("a@example.com");
    expect(toast.info).toHaveBeenCalledWith("Account export prepared");
  });
});
