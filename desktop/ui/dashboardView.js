function providerFromModel(name) {
  const normalized = String(name || "").toLowerCase();
  if (normalized.includes("claude")) return "Claude";
  if (normalized.includes("gemini")) return "Gemini";
  if (normalized.includes("gpt") || normalized.includes("openai")) return "OpenAI";
  return "Model";
}

function accountQuotas(account) {
  if (Array.isArray(account?.claudeModels) && account.claudeModels.length) {
    return account.claudeModels;
  }
  return Array.isArray(account?.quota) ? account.quota : [];
}

function activeProviders(providers) {
  const names = Object.entries(providers || {})
    .filter(([, active]) => Boolean(active))
    .map(([name]) => name);
  return names.length ? names.join(", ") : "inactive";
}

export function modelQuotaEntries(accounts = []) {
  const models = new Map();
  for (const account of accounts) {
    for (const quota of account.quota || []) {
      if (!quota?.name) continue;
      const current = models.get(quota.name) || {
        name: quota.name,
        displayName: quota.displayName,
        provider: providerFromModel(quota.name),
        bestPercent: -1,
        bestResetTime: undefined,
        bestAccount: undefined,
        accounts: 0
      };
      const percent = Number.isFinite(Number(quota.percentage)) ? Number(quota.percentage) : 0;
      current.accounts += 1;
      current.displayName = current.displayName || quota.displayName;
      if (percent > current.bestPercent) {
        current.bestPercent = percent;
        current.bestResetTime = quota.resetTime;
        current.bestAccount = account.email || account.displayName || account.accountId;
      }
      models.set(quota.name, current);
    }
  }
  return [...models.values()].sort((a, b) => {
    const providerOrder = a.provider.localeCompare(b.provider);
    if (providerOrder !== 0) return providerOrder;
    return b.bestPercent - a.bestPercent;
  });
}

export function accountHealthTone(account) {
  if (account?.health?.nextRetryAt && Date.parse(account.health.nextRetryAt) > Date.now()) {
    return "quarantined";
  }
  if (account?.health?.healthy === false) {
    return "bad";
  }
  return "healthy";
}

export function accountHealthLabel(account) {
  if (account?.health?.nextRetryAt && Date.parse(account.health.nextRetryAt) > Date.now()) {
    return "quarantined";
  }
  if (account?.health?.healthy === false) {
    return "unhealthy";
  }
  return "healthy";
}

export function accountQuotaLabel(account) {
  const quotas = accountQuotas(account);
  if (!quotas.length) return "kota yok";
  const first = quotas[0];
  const percent = Number.isFinite(Number(first?.percentage)) ? Math.round(Number(first.percentage)) : 0;
  return `${first?.name || "model"} · ${percent}%`;
}

export function accountLowQuota(account) {
  const quotas = accountQuotas(account);
  if (!quotas.length) return undefined;
  return quotas
    .map((quota) => ({
      name: quota.name,
      percentage: Number.isFinite(Number(quota.percentage)) ? Number(quota.percentage) : 0
    }))
    .filter((quota) => quota.percentage <= 20)
    .sort((a, b) => a.percentage - b.percentage)[0];
}

export function collectWarnings(accounts = [], summaryWarnings = []) {
  const warnings = new Set((summaryWarnings || []).filter(Boolean));
  for (const account of accounts) {
    const label = account.email || account.displayName || account.accountId || account.id;
    const quotas = accountQuotas(account);
    if (!quotas.length) {
      warnings.add(`${label} için kota bilgisi yok`);
      continue;
    }
    const low = accountLowQuota(account);
    if (low) {
      warnings.add(`${label} · ${low.name} %${Math.round(low.percentage)}`);
    }
    if (account.health?.healthy === false) {
      warnings.add(`${label} karantinada`);
    }
  }
  return [...warnings].slice(0, 8);
}

export function dashboardOverviewView({ health, summary, metrics }) {
  const active = summary.activeAccountId || summary.bestAccount?.email || "unknown";
  return {
    active,
    cards: [
      ["T", "Total Accounts", summary.totalAccounts ?? 0],
      ["H", "Healthy Accounts", summary.healthyAccounts ?? 0],
      ["A", "Active Account", active],
      ["P", "Provider Status", activeProviders(health.providers)],
      ["U", "Uptime", metrics.uptimeSeconds]
    ]
  };
}

export function providerBadgeView(health) {
  return [
    ["Gemini", health?.providers?.gemini?.active],
    ["Claude", health?.providers?.anthropic?.active || health?.providers?.cloudCode?.active],
    ["CloudCode", health?.providers?.cloudCode?.active],
    ["LS", Boolean(health?.ls?.enabled)]
  ];
}

export function activityView(metrics) {
  const errors = metrics.recentErrors || [];
  if (!errors.length) {
    return [{ text: "No recent failures", tone: "healthy", badge: "healthy" }];
  }
  return errors.slice(0, 5).map((item) => ({
    text: `${item.route} returned ${item.statusCode}`,
    tone: "unhealthy",
    badge: "failure"
  }));
}

export function auditTrailView(metrics) {
  return (metrics.auditTrail || metrics.recentRequests || []).slice(0, 8).map((item) => {
    const status = Number(item.statusCode ?? 0);
    return {
      ...item,
      status,
      tone: status >= 400 ? "bad" : "healthy",
      title: `${item.actor || item.account || item.provider || "-"} · ${item.model || "-"}`,
      summary: [
        item.provider || "-",
        item.resolvedModel ? `→ ${item.resolvedModel}` : "",
        item.route || "-",
        item.event || "request"
      ].filter(Boolean).join(" · ")
    };
  });
}

export function healthSnapshotView({ health, summary, accounts, accountHealth, adminStatus }) {
  const healthAccounts = Array.isArray(accountHealth?.accounts) && accountHealth.accounts.length ? accountHealth.accounts : accounts || [];
  const warnings = collectWarnings(healthAccounts, summary?.lowQuotaWarnings || []);
  const activeLs = Number(health?.ls?.activeInstances ?? 0);
  const providerCards = [
    ["API Proxy", adminStatus?.status === "ok" ? "healthy" : "bad", adminStatus?.status === "ok" ? `127.0.0.1:${adminStatus?.port || 8046}` : "durduruldu", `Auth ${adminStatus?.status === "ok" ? "ok" : "kapalı"}`],
    ["Gemini", health?.providers?.gemini?.active ? "healthy" : "bad", `${health?.providers?.gemini?.keyCount || 0} key`, health?.providers?.gemini?.active ? "online" : "offline"],
    ["Claude", health?.providers?.anthropic?.active ? "healthy" : "bad", `${health?.providers?.anthropic?.keyCount || 0} key`, health?.providers?.anthropic?.active ? "online" : "offline"],
    ["CloudCode", health?.providers?.cloudCode?.active ? "healthy" : "bad", `${health?.providers?.cloudCode?.healthyCount || 0} healthy`, `${health?.providers?.cloudCode?.unhealthyCount || 0} unhealthy`],
    ["LS", health?.ls?.enabled ? "healthy" : "bad", `${activeLs} instance`, `Native ${health?.ls?.nativeEnabled ? "on" : "off"} · Fallback ${health?.ls?.providerFallback ? "on" : "off"}`]
  ];

  const problemAccounts = healthAccounts
    .filter((account) =>
      account?.health?.healthy === false ||
      (account?.health?.nextRetryAt && Date.parse(account.health.nextRetryAt) > Date.now()) ||
      accountLowQuota(account) ||
      accountQuotaLabel(account) === "kota yok"
    )
    .map((account) => ({
      label: account.email || account.displayName || account.accountId || account.id,
      source: account.source || "imported",
      quotaLabel: accountQuotaLabel(account),
      tone: accountHealthTone(account),
      healthLabel: accountHealthLabel(account),
      nextRetryAt: account?.health?.nextRetryAt
    }));

  return {
    warnings,
    providerCards,
    problemAccounts
  };
}
