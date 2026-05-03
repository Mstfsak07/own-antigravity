import { TRAFFIC_COLUMNS } from "./traffic.js";

export function getTrafficFilterState(getElement) {
  return {
    filter: getElement("trafficFilter")?.value || getElement("globalSearch")?.value || "",
    statusFilter: getElement("trafficStatus")?.value || "all",
    minTokens: Number(getElement("trafficMinTokens")?.value || 0),
    startAt: getElement("trafficStart")?.value || "",
    endAt: getElement("trafficEnd")?.value || ""
  };
}

export function applyTrafficView(getElement, view) {
  if (!view) return;
  if (getElement("trafficFilter")) getElement("trafficFilter").value = view.filter || "";
  if (getElement("trafficStatus")) getElement("trafficStatus").value = view.statusFilter || "all";
  if (getElement("trafficMinTokens")) getElement("trafficMinTokens").value = view.minTokens ?? 0;
  if (getElement("trafficStart")) getElement("trafficStart").value = view.startAt || "";
  if (getElement("trafficEnd")) getElement("trafficEnd").value = view.endAt || "";
}

export function saveTrafficView(views, current, name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return undefined;
  const existing = (views || []).filter((view) => view.name !== cleanName);
  return [...existing, { name: cleanName, ...current }];
}

export function removeTrafficView(views, name) {
  return (views || []).filter((view) => view.name !== name);
}

export function trafficViewMeta(view) {
  return [
    view.filter ? `q:${view.filter}` : "",
    view.statusFilter && view.statusFilter !== "all" ? `durum:${view.statusFilter}` : "",
    Number(view.minTokens) > 0 ? `min:${view.minTokens}` : ""
  ].filter(Boolean).join(" · ") || "filtre";
}

export function accountFingerprint(accounts = []) {
  return JSON.stringify(
    [...accounts]
      .map((account) => ({
        id: account.accountId,
        active: Boolean(account.active),
        updatedAt: account.updatedAt,
        quotaCount: Array.isArray(account.quota) ? account.quota.length : 0
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  );
}

export function trafficColumnEntries() {
  return TRAFFIC_COLUMNS.map((column) => [column.key, column.label]);
}
