import { clear, el, renderSkeleton } from "./dom.js";
import { selectTrafficView, TRAFFIC_COLUMNS } from "./traffic.js";
import {
  activityView,
  auditTrailView,
  dashboardOverviewView,
  healthSnapshotView,
  modelQuotaEntries,
  providerBadgeView
} from "./dashboardView.js";

function uptime(seconds) {
  const value = Number(seconds || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${value}s`;
}

function metricCard(icon, label, value) {
  return el("article", { className: "metric-card" }, [
    el("div", { className: "metric-top" }, [
      el("span", { text: label }),
      el("span", { className: "metric-icon", text: icon })
    ]),
    el("strong", { text: value })
  ]);
}

function resetLabel(value) {
  if (!value) return "sıfırlanma bilinmiyor";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const delta = date.getTime() - Date.now();
  if (delta <= 0) return "şimdi sıfırlanıyor";
  const hours = Math.floor(delta / 3600000);
  const minutes = Math.floor((delta % 3600000) / 60000);
  if (hours >= 24) return `${Math.floor(hours / 24)}g sonra`;
  if (hours > 0) return `${hours}s ${minutes}d sonra`;
  return `${Math.max(1, minutes)}d sonra`;
}

function quotaClass(percent) {
  if (percent <= 20) return "danger";
  if (percent <= 50) return "warn";
  return "ok";
}

export function renderDashboardLoading(target) {
  renderSkeleton(target, 5, "metric-card");
}

export function renderDashboard({ health, summary, metrics, accounts, accountHealth, adminStatus }) {
  const target = document.getElementById("overviewCards");
  clear(target);
  const overview = dashboardOverviewView({ health, summary, metrics });
  const cards = overview.cards.map(([icon, label, value]) => [icon, label, label === "Uptime" ? uptime(value) : value]);
  for (const [icon, label, value] of cards) {
    target.append(metricCard(icon, label, value));
  }

  document.getElementById("topActiveAccount").textContent = overview.active;
  renderActivity(metrics);
  renderProviderBadges(health || {});
  renderHealthSnapshot({ health, summary, accounts, accountHealth, adminStatus });
  renderAuditTrail(metrics);
  renderModelQuotas(accounts || summary.accounts || []);
}

function renderModelQuotas(accounts) {
  const target = document.getElementById("modelQuotaList");
  if (!target) return;
  clear(target);
  const quotas = modelQuotaEntries(accounts);
  if (!quotas.length) {
    target.append(el("div", { className: "empty-state compact", text: "Model kota bilgisi yok. JSON import kotayla geldiyse veya hesap yenilendiyse burada görünür." }));
    return;
  }

  for (const quota of quotas) {
    const percent = Math.max(0, Math.min(100, quota.bestPercent < 0 ? 0 : Math.round(quota.bestPercent)));
    const state = quotaClass(percent);
    target.append(el("article", { className: `model-quota-row ${state}` }, [
      el("div", { className: "model-quota-main" }, [
        el("span", { className: `protocol-pill ${quota.provider.toLowerCase()}`, text: quota.provider }),
        el("strong", { text: quota.displayName ? `${quota.displayName} (${quota.name})` : quota.name }),
        el("small", { text: `${quota.bestAccount || "hesap bilinmiyor"} · ${quota.accounts} hesapta var · ${resetLabel(quota.bestResetTime)}` })
      ]),
      el("div", { className: "model-quota-meter" }, [
        el("div", { className: "quota-percent", text: `${percent}%` }),
        el("div", { className: "quota-track" }, [
          el("span", { className: `quota-fill ${state}`, attrs: { style: `width: ${percent}%` } })
        ])
      ])
    ]));
  }
}

function relativeLabel(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const delta = date.getTime() - Date.now();
  if (delta <= 0) return "şimdi";
  const minutes = Math.floor(delta / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}g`;
  if (hours > 0) return `${hours}s`;
  return `${Math.max(1, minutes)}d`;
}

function renderHealthSnapshot({ health, summary, accounts, accountHealth, adminStatus }) {
  const target = document.getElementById("healthSnapshot");
  if (!target) return;
  clear(target);
  const snapshot = healthSnapshotView({ health, summary, accounts, accountHealth, adminStatus });
  const { warnings, providerCards, problemAccounts } = snapshot;

  target.append(el("div", { className: "health-summary-grid" }, providerCards.map(([label, tone, value, hint]) => (
    el("article", { className: `health-stat ${tone}` }, [
      el("span", { className: "health-stat-label", text: label }),
      el("strong", { text: value }),
      el("small", { text: hint })
    ])
  ))));

  target.append(el("div", { className: "health-warning-panel" }, [
    el("div", { className: "health-warning-header" }, [
      el("strong", { text: "Kota Uyarıları" }),
      el("span", { className: warnings.length ? "health-warning-count warn" : "health-warning-count healthy", text: warnings.length ? `${warnings.length}` : "0" })
    ]),
    warnings.length
      ? el("div", { className: "health-warning-list" }, warnings.map((warning) => el("div", { className: "health-warning-item bad", text: warning })))
      : el("div", { className: "empty-state compact", text: "Şu an düşük kota uyarısı yok." })
  ]));

  target.append(el("div", { className: "health-account-panel" }, [
    el("div", { className: "health-warning-header" }, [
      el("strong", { text: "Problemli Hesaplar" }),
      el("span", { className: "health-warning-count", text: `${problemAccounts.length}` })
    ]),
    problemAccounts.length
      ? el("div", { className: "health-account-list" }, problemAccounts.map((account) => {
          return el("div", { className: "health-account-row" }, [
            el("div", { className: "health-account-main" }, [
              el("strong", { text: account.label }),
              el("small", { text: `${account.source} · ${account.quotaLabel}` })
            ]),
            el("div", { className: "health-account-meta" }, [
              el("span", { className: `health-badge ${account.tone}`, text: account.healthLabel }),
              el("span", { className: "health-account-retry", text: account.nextRetryAt ? `retry ${relativeLabel(account.nextRetryAt)}` : "ready" })
            ])
          ]);
        }))
      : el("div", { className: "empty-state compact", text: "Problemli hesap yok." })
  ]));
}

function renderAuditTrail(metrics) {
  const target = document.getElementById("auditTrail");
  if (!target) return;
  clear(target);

  const trail = auditTrailView(metrics);
  if (!trail.length) {
    target.append(el("div", { className: "empty-state compact", text: "Henüz audit kaydı yok." }));
    return;
  }

  for (const item of trail) {
    target.append(el("div", { className: `audit-row ${item.tone}` }, [
      el("div", { className: "audit-main" }, [
        el("strong", { text: item.title }),
        el("small", { text: item.summary })
      ]),
      el("div", { className: "audit-meta" }, [
        el("span", { className: `health-badge ${item.tone}`, text: String(item.status) }),
        el("span", { className: "audit-time", text: item.at ? new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-" })
      ])
    ]));
  }
}

function renderActivity(metrics) {
  const target = document.getElementById("recentActivity");
  clear(target);
  for (const item of activityView(metrics)) {
    target.append(el("div", { className: "activity-item" }, [
      el("span", { text: item.text }),
      el("span", { className: `health-badge ${item.tone}`, text: item.badge })
    ]));
  }
}

function renderProviderBadges(health) {
  const target = document.getElementById("providerBadges");
  clear(target);
  const rows = providerBadgeView(health);
  for (const [name, active] of rows) {
    target.append(el("span", {
      className: `provider-badge ${active ? "ok" : "bad"}`,
      text: `${name}: ${active ? "online" : "offline"}`
    }));
  }
}

function formatTokens(tokens) {
  if (!tokens) return "-";
  const input = Number(tokens.input ?? 0);
  const output = Number(tokens.output ?? 0);
  const total = Number(tokens.total ?? input + output);
  return `${input} / ${output} / ${total}`;
}

function formatDuration(ms) {
  const value = Number(ms ?? 0);
  return value > 0 ? `${value}ms` : "-";
}

function formatPayload(value) {
  if (value === undefined || value === null) return "-";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function statusBadge(status) {
  const code = Number(status);
  const className = code >= 500 || code === 429 || code === 403 || code === 401 ? "status-badge error" : "status-badge success";
  return el("span", { className, text: String(status) });
}

export function renderMetrics(metrics, options = {}) {
  const target = document.getElementById("trafficRows");
  if (!target) return;
  clear(target);
  const view = selectTrafficView(metrics, options);
  const { filteredRows, visibleColumns, visible, total, failed, success } = view;
  document.getElementById("trafficTotal").textContent = `${total} TOPLAM`;
  document.getElementById("trafficSuccess").textContent = `${success} BAŞARILI`;
  document.getElementById("trafficError").textContent = `${failed} HATA`;
  const hiddenCount = TRAFFIC_COLUMNS.length - visible.length;
  document.getElementById("trafficColumnsCount").textContent = hiddenCount ? `${visible.length}/${TRAFFIC_COLUMNS.length}` : `${TRAFFIC_COLUMNS.length}/${TRAFFIC_COLUMNS.length}`;
  const head = document.getElementById("trafficHead");
  if (head) {
    clear(head);
    for (const column of visible) {
      head.append(el("th", { text: column.label }));
    }
  }

  if (!visible.length) {
    target.append(el("tr", {}, [
      el("td", { attrs: { colspan: "1" }, text: "Görünür kolon yok. Sütunlardan en az birini aç." })
    ]));
    return;
  }

  if (!filteredRows.length) {
    target.append(el("tr", {}, [
      el("td", { attrs: { colspan: String(visible.length) }, text: "Kayıt bulunamadı" })
    ]));
    return;
  }

  for (const row of filteredRows) {
    const protocolClass = row.provider === "-" ? "unknown" : row.provider.toLowerCase();
    const cells = [];
    if (visibleColumns.status !== false) cells.push(el("td", {}, [statusBadge(row.statusCode)]));
    if (visibleColumns.method !== false) cells.push(el("td", { text: row.method }));
    if (visibleColumns.model !== false) cells.push(el("td", { text: row.model }));
    if (visibleColumns.provider !== false) cells.push(el("td", {}, [el("span", { className: `protocol-pill ${protocolClass}`, text: row.provider })]));
    if (visibleColumns.account !== false) cells.push(el("td", { text: row.account || "-" }));
    if (visibleColumns.route !== false) cells.push(el("td", { text: row.route }));
    if (visibleColumns.tokens !== false) cells.push(el("td", { text: formatTokens(row.tokens) }));
    if (visibleColumns.duration !== false) cells.push(el("td", { text: formatDuration(row.durationMs) }));
    if (visibleColumns.time !== false) cells.push(el("td", { text: row.at ? new Date(row.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-" }));
    const rowNode = el("tr", { className: "traffic-row", attrs: { tabindex: "0", role: "button" } }, cells);
    rowNode.addEventListener("click", () => options.onSelect?.(row));
    rowNode.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        options.onSelect?.(row);
      }
    });
    target.append(rowNode);
  }
}

export function formatTrafficPayload(value) {
  return formatPayload(value);
}
