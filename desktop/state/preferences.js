import { mergeTrafficColumns } from "../ui/traffic.js";

function loadJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createInitialRendererState() {
  return {
    gateway: "http://127.0.0.1:8046",
    apiKey: localStorage.getItem("ownAg.apiKey") || "",
    theme: localStorage.getItem("ownAg.theme") || "light",
    language: localStorage.getItem("ownAg.lang") || "tr",
    accounts: [],
    proxyConfig: undefined,
    adminStatus: undefined,
    summary: undefined,
    health: undefined,
    accountHealth: undefined,
    metrics: undefined,
    trafficViews: loadJson(localStorage.getItem("ownAg.trafficViews") || "[]", []),
    trafficColumns: mergeTrafficColumns(loadJson(localStorage.getItem("ownAg.trafficColumns") || "null", null)),
    loading: false
  };
}

export function persistApiKey(state) {
  localStorage.setItem("ownAg.apiKey", state.apiKey || "");
}

export function persistTheme(theme) {
  localStorage.setItem("ownAg.theme", theme);
}

export function persistLanguage(language) {
  localStorage.setItem("ownAg.lang", language);
}

export function persistTrafficViews(state) {
  localStorage.setItem("ownAg.trafficViews", JSON.stringify(state.trafficViews || []));
}

export function persistTrafficColumns(state) {
  localStorage.setItem("ownAg.trafficColumns", JSON.stringify(state.trafficColumns || {}));
}

export function snapshotDesktopPreferences(state) {
  return {
    apiKey: state.apiKey,
    theme: state.theme,
    language: state.language,
    trafficViews: state.trafficViews || [],
    trafficColumns: state.trafficColumns || {}
  };
}

export function applyDesktopPreferences(state, snapshot, actions) {
  if (!snapshot || typeof snapshot !== "object") return;
  if (typeof snapshot.apiKey === "string") {
    state.apiKey = snapshot.apiKey;
    persistApiKey(state);
  }
  if (snapshot.theme === "dark" || snapshot.theme === "light") {
    actions.setTheme(snapshot.theme);
  }
  if (typeof snapshot.language === "string") {
    actions.setLanguage(snapshot.language);
  }
  if (Array.isArray(snapshot.trafficViews)) {
    state.trafficViews = snapshot.trafficViews;
    persistTrafficViews(state);
  }
  if (snapshot.trafficColumns && typeof snapshot.trafficColumns === "object") {
    state.trafficColumns = mergeTrafficColumns(snapshot.trafficColumns);
    persistTrafficColumns(state);
  }
}
