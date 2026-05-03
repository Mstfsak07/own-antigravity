import { describe, expect, it, vi } from "vitest";
import { bindAccountEvents } from "../desktop/controllers/accountEvents.js";
import { bindAppShellEvents } from "../desktop/controllers/appShellEvents.js";
import { createTrafficEventsBinder } from "../desktop/controllers/trafficEvents.js";

describe("desktop traffic events", () => {
  it("binds traffic filter reset and chip behavior", () => {
    const nodes: Record<string, any> = {
      globalSearch: { value: "", addEventListener: vi.fn() },
      trafficFilter: { value: "", addEventListener: vi.fn() },
      trafficStatus: { value: "all", addEventListener: vi.fn() },
      trafficMinTokens: { addEventListener: vi.fn() },
      trafficStart: { addEventListener: vi.fn() },
      trafficEnd: { addEventListener: vi.fn() },
      saveTrafficView: { addEventListener: vi.fn() },
      trafficColumnsReset: { addEventListener: vi.fn() }
    };
    const chipAll = {
      textContent: "Tümü",
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn()
    };
    const chipError = {
      textContent: "Hata",
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn()
    };
    const chipNodes = [chipAll, chipError];
    const documentStub = {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === ".filter-chip") return chipNodes as any;
        return [] as any;
      })
    };
    vi.stubGlobal("document", documentStub);

    const renderTraffic = vi.fn();
    const renderTrafficColumns = vi.fn();
    const persistTrafficColumns = vi.fn();
    const state = { trafficColumns: { status: false } };

    const bindTrafficEvents = createTrafficEventsBinder({
      getNode: (id: string) => nodes[id],
      state,
      renderMetrics: vi.fn(),
      renderTraffic,
      renderTrafficColumns,
      persistTrafficColumns,
      defaultTrafficColumns: () => ({ status: true }),
      trafficRenderOptions: () => ({}),
      saveTrafficView: vi.fn()
    });
    bindTrafficEvents();

    const resetHandler = nodes.trafficColumnsReset.addEventListener.mock.calls[0][1];
    resetHandler();
    expect(state.trafficColumns).toEqual({ status: true });
    expect(persistTrafficColumns).toHaveBeenCalled();

    const errorChipHandler = chipError.addEventListener.mock.calls[0][1];
    errorChipHandler();
    expect(nodes.trafficStatus.value).toBe("error");
    expect(renderTraffic).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("binds shell events through a dedicated controller", async () => {
    const refresh = { addEventListener: vi.fn() };
    const language = { addEventListener: vi.fn() };
    const themeToggle = { addEventListener: vi.fn() };
    const tabPanel = { classList: { add: vi.fn(), remove: vi.fn() } };
    const navButton = { dataset: { page: "dashboard" }, addEventListener: vi.fn() };
    const tabButton = {
      dataset: { tab: "traffic" },
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn()
    };
    const documentStub = {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === ".nav") return [navButton] as any;
        if (selector === ".tab") return [tabButton] as any;
        if (selector === ".tab,.tab-panel") return [tabButton, tabPanel] as any;
        return [] as any;
      })
    };
    vi.stubGlobal("document", documentStub);

    const api = { refreshQuotas: vi.fn().mockResolvedValue(undefined) };
    const setBusy = vi.fn();
    const refreshData = vi.fn().mockResolvedValue(undefined);
    const setTheme = vi.fn();
    const setLanguage = vi.fn();
    const renderTrafficColumns = vi.fn();
    const bindTrafficEvents = vi.fn();
    const showPage = vi.fn();
    const saveTrafficView = vi.fn();
    const nodes: Record<string, any> = {
      refresh,
      language,
      themeToggle,
      "tab-traffic": tabPanel
    };

    bindAppShellEvents({
      getNode: (id: string) => nodes[id],
      api,
      state: { theme: "dark" },
      setBusy,
      setTheme,
      setLanguage,
      refreshData,
      renderTrafficColumns,
      bindTrafficEvents,
      showPage,
      saveTrafficView
    });

    expect(bindTrafficEvents).toHaveBeenCalledWith({ saveTrafficView });
    expect(renderTrafficColumns).toHaveBeenCalled();

    const refreshHandler = refresh.addEventListener.mock.calls[0][1];
    await refreshHandler();
    expect(api.refreshQuotas).toHaveBeenCalled();
    expect(refreshData).toHaveBeenCalled();

    const themeHandler = themeToggle.addEventListener.mock.calls[0][1];
    themeHandler();
    expect(setTheme).toHaveBeenCalledWith("light");

    const languageHandler = language.addEventListener.mock.calls[0][1];
    languageHandler({ target: { value: "tr" } });
    expect(setLanguage).toHaveBeenCalledWith("tr");

    const navHandler = navButton.addEventListener.mock.calls[0][1];
    navHandler();
    expect(showPage).toHaveBeenCalledWith("dashboard");

    vi.unstubAllGlobals();
  });

  it("binds account events through a dedicated controller", async () => {
    const accountModal = { showModal: vi.fn() };
    const exportModal = { showModal: vi.fn() };
    const accountSearch = { addEventListener: vi.fn() };
    const refreshAccounts = { addEventListener: vi.fn() };
    const addAccount = { addEventListener: vi.fn() };
    const dashboardAddAccount = { addEventListener: vi.fn() };
    const openExport = { addEventListener: vi.fn() };
    const runExport = { addEventListener: vi.fn() };
    const importManual = { addEventListener: vi.fn() };
    const importJson = { addEventListener: vi.fn() };
    const startOAuth = { addEventListener: vi.fn() };
    const jsonImport = { value: "" };
    const jsonFile = { files: [], addEventListener: vi.fn() };
    const jsonDropzone = {
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn()
    };
    const filterButton = {
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn()
    };
    const documentStub = {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === ".account-filter") return [filterButton] as any;
        return [] as any;
      })
    };
    const ownAg = { openExternal: vi.fn() };
    vi.stubGlobal("document", documentStub);
    vi.stubGlobal("window", { ownAg });

    const renderAll = vi.fn();
    const refreshData = vi.fn().mockResolvedValue(undefined);
    const renderTrafficColumns = vi.fn();
    const setBusy = vi.fn();
    const toast = { error: vi.fn(), info: vi.fn() };
    const api = { refreshQuotas: vi.fn().mockResolvedValue(undefined) };
    const accountActions = {
      runExport: vi.fn(),
      importManual: vi.fn(),
      importJson: vi.fn()
    };
    const startOAuthWatch = vi.fn();
    const nodes: Record<string, any> = {
      accountSearch,
      refreshAccounts,
      addAccount,
      dashboardAddAccount,
      openExport,
      runExport,
      importManual,
      importJson,
      startOAuth,
      accountModal,
      exportModal,
      jsonImport,
      jsonFile,
      jsonDropzone
    };

    bindAccountEvents({
      getNode: (id: string) => nodes[id],
      api,
      state: { apiKey: "abc", gateway: "http://localhost:8046" },
      toast,
      setBusy,
      renderAll,
      refreshData,
      accountActions,
      startOAuthWatch,
      renderTrafficColumns
    });

    expect(renderTrafficColumns).toHaveBeenCalled();

    const searchHandler = accountSearch.addEventListener.mock.calls[0][1];
    searchHandler();
    expect(renderAll).toHaveBeenCalled();

    const refreshHandler = refreshAccounts.addEventListener.mock.calls[0][1];
    await refreshHandler();
    expect(api.refreshQuotas).toHaveBeenCalled();
    expect(refreshData).toHaveBeenCalled();

    const addAccountHandler = addAccount.addEventListener.mock.calls[0][1];
    addAccountHandler();
    expect(accountModal.showModal).toHaveBeenCalled();

    const exportHandler = openExport.addEventListener.mock.calls[0][1];
    exportHandler();
    expect(exportModal.showModal).toHaveBeenCalled();

    const runExportHandler = runExport.addEventListener.mock.calls[0][1];
    runExportHandler();
    expect(accountActions.runExport).toHaveBeenCalled();

    const oauthHandler = startOAuth.addEventListener.mock.calls[0][1];
    oauthHandler();
    expect(startOAuthWatch).toHaveBeenCalled();
    expect(ownAg.openExternal).toHaveBeenCalledWith("http://localhost:8046/auth/google/start?key=abc");

    vi.unstubAllGlobals();
  });
});
