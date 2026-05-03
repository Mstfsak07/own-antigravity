import { createAccountActionsController } from "./controllers/accountActions.js";
import { ApiClient } from "./api/client.js";
import { bindAccountEvents } from "./controllers/accountEvents.js";
import { bindAppShellEvents } from "./controllers/appShellEvents.js";
import { createOAuthWatchController } from "./controllers/oauthWatch.js";
import { createRuntimeSyncController } from "./controllers/runtimeSync.js";
import { createTrafficEventsBinder } from "./controllers/trafficEvents.js";
import {
  applyDesktopPreferences,
  createInitialRendererState,
  persistApiKey,
  persistLanguage,
  persistTheme,
  persistTrafficColumns,
  persistTrafficViews,
  snapshotDesktopPreferences
} from "./state/preferences.js";
import { renderApiProxy, renderApiProxyLoading } from "./ui/apiProxy.js";
import { renderAccounts, renderAccountsLoading } from "./ui/accounts.js";
import { formatTrafficPayload, renderDashboard, renderDashboardLoading, renderMetrics } from "./ui/dashboard.js";
import { $, setBusy } from "./ui/dom.js";
import { openTrafficDetailModal } from "./ui/trafficDetail.js";
import { renderTrafficColumnsPanel, renderTrafficViewsPanel } from "./ui/trafficPanels.js";
import { renderSettings } from "./ui/settings.js";
import { defaultTrafficColumns } from "./ui/traffic.js";
import {
  accountFingerprint,
  applyTrafficView,
  getTrafficFilterState,
  removeTrafficView as removeSavedTrafficView,
  saveTrafficView as buildSavedTrafficView
} from "./ui/trafficControls.js";
import { createToastSystem } from "./ui/toast.js";

const state = createInitialRendererState();

let api;
let toast;
let runtimeSync;
let oauthWatch;
let accountActions;
let bindTrafficEvents;

function trafficRenderOptions(overrides = {}) {
  return {
    ...getTrafficFilterState($),
    visibleColumns: state.trafficColumns,
    onSelect: openTrafficDetail,
    ...overrides
  };
}

function renderTraffic() {
  if (!state.metrics) return;
  renderMetrics(state.metrics, trafficRenderOptions());
}

function loadTrafficView(view) {
  applyTrafficView($, view);
  renderTraffic();
  renderTrafficViews();
}

function saveTrafficView() {
  const nameInput = $("trafficViewName");
  const name = String(nameInput?.value || "").trim();
  if (!name) {
    toast.info("Görünüm adı gir");
    return;
  }
  const current = getTrafficFilterState($);
  const nextViews = buildSavedTrafficView(state.trafficViews, current, name);
  if (!nextViews) {
    toast.info("Görünüm adı gir");
    return;
  }
  state.trafficViews = nextViews;
  persistTrafficViews(state);
  if (nameInput) nameInput.value = "";
  renderTrafficViews();
  toast.success("Görünüm kaydedildi");
}

function removeTrafficView(name) {
  state.trafficViews = removeSavedTrafficView(state.trafficViews, name);
  persistTrafficViews(state);
  renderTrafficViews();
}

function renderTrafficViews() {
  renderTrafficViewsPanel($("trafficViews"), state.trafficViews || [], {
    onApply: loadTrafficView,
    onRemove: removeTrafficView
  });
}

function renderTrafficColumns() {
  renderTrafficColumnsPanel($("trafficColumns"), state.trafficColumns, {
    onToggle: (key, checked) => {
      state.trafficColumns[key] = checked;
      persistTrafficColumns(state);
      renderTraffic();
    }
  });
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.classList.toggle("light", theme === "light");
  persistTheme(theme);
}

function setLanguage(language) {
  state.language = language;
  $("language").value = language;
  persistLanguage(language);
}

function setLoading(loading) {
  state.loading = loading;
  $("globalSpinner").hidden = !loading;
}

async function refreshTraffic() {
  await runtimeSync?.refreshTraffic();
}

function startTrafficPolling() {
  runtimeSync?.startTrafficPolling();
}

function stopTrafficPolling() {
  runtimeSync?.stopTrafficPolling();
}

function stopOAuthWatch() {
  oauthWatch?.stopOAuthWatch();
}

function startOAuthWatch() {
  oauthWatch?.startOAuthWatch();
}

function openTrafficDetail(record) {
  openTrafficDetailModal({
    record,
    getNode: $,
    formatTrafficPayload,
    toast
  });
}

function showPage(pageId) {
  document.querySelectorAll(".nav,.page").forEach((node) => node.classList.remove("active"));
  document.querySelector(`.nav[data-page="${pageId}"]`)?.classList.add("active");
  $(pageId)?.classList.add("active");
}

async function refreshData() {
  await runtimeSync?.refreshData();
}

async function saveGatewayConfig(patch) {
  await window.ownAg.gatewayConfigImport(patch);
  state.proxyConfig = await window.ownAg.gatewayConfig?.();
  await refreshData();
}

function renderAll() {
  if (!state.health || !state.summary || !state.metrics) return;
  renderDashboard({
    health: state.health,
    summary: state.summary,
    metrics: state.metrics,
    accounts: state.accounts,
    accountHealth: state.accountHealth,
    adminStatus: state.adminStatus
  });
  renderApiProxy({
    gatewayConfig: state.proxyConfig,
    adminStatus: state.adminStatus,
    api,
    toast,
    onRefresh: refreshData,
    onSaveConfig: saveGatewayConfig,
    onStartService: async () => {
      await window.ownAg.gatewayStart();
      state.proxyConfig = await window.ownAg.gatewayConfig?.();
      await refreshData();
    },
    onStopService: async () => {
      await window.ownAg.gatewayStop();
      state.proxyConfig = await window.ownAg.gatewayConfig?.();
      await refreshData();
    }
  });
  renderTraffic();
  renderTrafficColumns();
  renderAccounts({
    accounts: state.accounts,
    api,
    toast,
    onRefresh: refreshData,
    onExportAccount: accountActions?.exportOneAccount,
    confirmRemove: accountActions?.confirmRemove,
    filter: $("accountSearch")?.value || "",
    mode: document.querySelector(".account-filter.active")?.dataset.filter || "all"
  });
  renderSettings({
    gatewayUrl: state.gateway,
    apiKey: state.apiKey,
    theme: state.theme,
    language: state.language,
    geminiConfig: state.proxyConfig?.gemini,
    cloudCodeConfig: state.proxyConfig?.cloudCode,
    onSave: saveSettings
  });
  renderTrafficViews();
}

function saveSettings(next) {
  state.apiKey = next.apiKey;
  persistApiKey(state);
  setTheme(next.theme);
  setLanguage(next.language);
  toast.success("Settings saved");
  refreshData();
}

function setupEvents() {
  bindAppShellEvents({
    getNode: $,
    api,
    state,
    setBusy,
    setTheme,
    setLanguage,
    refreshData,
    renderTrafficColumns,
    bindTrafficEvents,
    showPage,
    saveTrafficView
  });
  bindAccountEvents({
    getNode: $,
    api,
    state,
    toast,
    setBusy,
    renderAll,
    refreshData,
    accountActions,
    startOAuthWatch,
    renderTrafficColumns
  });
}

async function init() {
  toast = createToastSystem($("toastStack"));
  renderTrafficViews();
  state.gateway = await window.ownAg.gatewayUrl();
  state.proxyConfig = await window.ownAg.gatewayConfig?.();
  if (!state.apiKey && state.proxyConfig?.localApiKey) {
    state.apiKey = state.proxyConfig.localApiKey;
    persistApiKey(state);
  }
  api = new ApiClient({
    gatewayUrl: state.gateway,
    getApiKey: () => state.apiKey
  });
  runtimeSync = createRuntimeSyncController({
    api,
    state,
    toast,
    windowObject: window,
    setLoading,
    renderDashboardLoading,
    renderAccountsLoading,
    renderApiProxyLoading,
    getNode: $,
    renderDashboardSection: () => renderDashboard({
      health: state.health,
      summary: state.summary,
      metrics: state.metrics,
      accounts: state.accounts,
      accountHealth: state.accountHealth,
      adminStatus: state.adminStatus
    }),
    renderTrafficSection: renderTraffic,
    renderTrafficColumns,
    renderTrafficViews,
    renderAll
  });
  bindTrafficEvents = createTrafficEventsBinder({
    getNode: $,
    state,
    renderMetrics,
    renderTraffic,
    renderTrafficColumns,
    persistTrafficColumns,
    defaultTrafficColumns,
    trafficRenderOptions,
    saveTrafficView
  });
  oauthWatch = createOAuthWatchController({
    api,
    state,
    toast,
    windowObject: window,
    accountFingerprint,
    refreshData
  });
  accountActions = createAccountActionsController({
    api,
    state,
    toast,
    windowObject: window,
    getNode: $,
    setBusy,
    refreshData,
    renderTrafficColumns,
    renderTrafficViews,
    renderAll,
    applyDesktopPreferences,
    setTheme,
    setLanguage,
    snapshotDesktopPreferences
  });
  setTheme(state.theme);
  setLanguage(state.language);
  setupEvents();
  renderSettings({
    gatewayUrl: state.gateway,
    apiKey: state.apiKey,
    theme: state.theme,
    language: state.language,
    geminiConfig: state.proxyConfig?.gemini,
    cloudCodeConfig: state.proxyConfig?.cloudCode,
    onSave: saveSettings
  });
  startTrafficPolling();
  await refreshData();
}

init();

window.addEventListener("beforeunload", stopTrafficPolling);
window.addEventListener("beforeunload", stopOAuthWatch);
