import { clear, el, renderSkeleton, setBusy } from "./dom.js";

function healthState(account) {
  if (account.disabled || account.status === "disabled") {
    return "disabled";
  }
  if (account.health?.nextRetryAt && Date.parse(account.health.nextRetryAt) > Date.now()) {
    return "quarantined";
  }
  return account.health?.healthy ? "healthy" : "unhealthy";
}

function resetLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const delta = date.getTime() - Date.now();
  if (delta <= 0) return "0d";
  const minutes = Math.floor(delta / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}g ${hours % 24}s`;
  if (hours > 0) return `${hours}s ${minutes % 60}d`;
  return `${Math.max(1, minutes)}d`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function diagnosisTone(diagnosis) {
  const kind = diagnosis?.kind;
  if (kind === "auth_expired" || kind === "auth_failed") return "danger";
  if (kind === "provider_failure" || kind === "manual_disabled") return "warn";
  if (kind === "rate_limited" || kind === "quarantined") return "warn";
  return "ok";
}

function renderDiagnosisPanel(account) {
  const diagnosis = account.diagnosis;
  if (!diagnosis?.isProblem) return null;
  return el("div", { className: `account-diagnosis-panel ${diagnosisTone(diagnosis)}` }, [
    el("div", { className: "account-diagnosis-head" }, [
      el("strong", { text: diagnosis.title }),
      el("span", { className: "account-diagnosis-kind", text: diagnosis.kind.replaceAll("_", " ") })
    ]),
    el("p", { className: "account-diagnosis-reason", text: diagnosis.reason }),
    el("p", { className: "account-diagnosis-recommendation", text: diagnosis.recommendation }),
    el("div", { className: "account-diagnosis-steps" }, diagnosis.steps.map((step, index) =>
      el("div", { className: "account-diagnosis-step", text: `${index + 1}. ${step}` })
    ))
  ]);
}

function quotaClass(percent) {
  if (percent <= 20) return "danger";
  if (percent <= 50) return "warn";
  return "ok";
}

function providerIcon(name) {
  const normalized = String(name || "").toLowerCase();
  if (normalized.includes("claude")) return "✹";
  if (normalized.includes("gpt")) return "⚙";
  return "✦";
}

function providerClass(name) {
  const normalized = String(name || "").toLowerCase();
  if (normalized.includes("claude")) return "provider-claude";
  if (normalized.includes("gpt") || normalized.includes("openai") || normalized.includes("chatgpt")) return "provider-openai";
  if (normalized.includes("gemini")) return "provider-gemini";
  return "provider-default";
}

function displayName(quota) {
  return quota.displayName || quota.name || "model";
}

function modelQuotaChip(quota) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(quota.percentage ?? 0))));
  const state = quotaClass(percent);
  const label = displayName(quota);
  return el("span", { className: `account-quota-chip ${state} ${providerClass(quota.name)}`, title: `${quota.name || label} · ${percent}%` }, [
    el("span", { className: "quota-model-name", text: `${providerIcon(quota.name)} ${label}` }),
    el("span", { className: "quota-reset", text: resetLabel(quota.resetTime) }),
    el("strong", { text: `${percent}%` })
  ]);
}

function updateCounts(accounts) {
  const healthy = accounts.filter((account) => healthState(account) === "healthy").length;
  const quota = accounts.filter((account) => (account.quota || []).length > 0).length;
  const set = (id, value) => {
    const target = document.getElementById(id);
    if (target) target.textContent = String(value);
  };
  set("accountTotalCount", accounts.length);
  set("accountHealthyCount", healthy);
  set("accountQuotaCount", quota);
  set("accountEmptyQuotaCount", accounts.length - quota);
}

function accountMatchesMode(account, mode) {
  if (mode === "healthy") return healthState(account) === "healthy";
  if (mode === "quota") return (account.quota || []).length > 0;
  if (mode === "empty") return (account.quota || []).length === 0;
  return true;
}

function filterAccounts(accounts, filter, mode) {
  const query = String(filter || "").trim().toLowerCase();
  return accounts.filter((account) => {
    if (!accountMatchesMode(account, mode)) return false;
    if (!query) return true;
    return `${account.email || ""} ${account.displayName || ""} ${account.accountId || ""}`.toLowerCase().includes(query);
  });
}

export function renderAccountsLoading(target) {
  renderSkeleton(target, 6, "account-row-skeleton");
}

export function renderAccounts({ accounts, api, toast, onRefresh, onExportAccount, confirmRemove, filter = "", mode = "all" }) {
  const target = document.getElementById("accountCards");
  clear(target);
  updateCounts(accounts);

  const filtered = filterAccounts(accounts, filter, mode);
  if (!accounts.length) {
    target.append(el("div", { className: "empty-state compact", text: "Henüz hesap yok. Google OAuth ile hesap ekleyin veya JSON import edin." }));
    return;
  }

  const table = el("div", { className: "accounts-table" }, [
    el("div", { className: "accounts-head" }, [
      el("span", { text: "" }),
      el("span", { text: "E-POSTA" }),
      el("span", { text: "MODEL KOTASI" }),
      el("span", { text: "SON KULLANIM" }),
      el("span", { text: "İŞLEMLER" })
    ])
  ]);

  if (!filtered.length) {
    table.append(el("div", { className: "accounts-empty-row", text: "Filtreye uygun hesap bulunamadı." }));
    target.append(table);
    return;
  }

  for (const account of filtered) {
    const state = healthState(account);
    const quota = account.quota || [];
    const diagnosis = account.diagnosis;
    const row = el("article", { className: `accounts-row ${account.active ? "active-account-row" : ""}` });
    row.append(el("div", { className: "account-select-cell" }, [
      el("span", { className: "drag-handle", text: "⋮⋮" }),
      el("span", { className: "checkbox-fake" })
    ]));
    row.append(el("div", { className: "account-email-cell" }, [
      el("strong", { text: account.email || account.displayName || account.accountId }),
      el("div", { className: "account-badges" }, [
        account.active ? el("span", { className: "mini-badge active", text: "MEVCUT" }) : el("span", { className: `mini-badge ${state}`, text: state === "healthy" ? "SAĞLIKLI" : state === "disabled" ? "DEVRE DIŞI" : state.toUpperCase() }),
        state === "quarantined"
          ? el("span", { className: "mini-badge quarantined", text: account.health?.disabledReason === "rate_limit" ? "RATE LIMIT" : "KARANTİNA" })
          : state === "disabled" && /^http_(429|5\d\d)$/.test(String(account.health?.disabledReason || ""))
            ? el("span", { className: "mini-badge quarantined", text: "SINIR / SUNUCU" })
          : null
      ])
    ]));
    row.append(el("div", { className: "account-quota-cell" }, quota.length
      ? quota.slice(0, 14).map(modelQuotaChip)
      : [el("span", { className: "no-quota-chip", text: "Kota bilgisi yok" })]
    ));
    row.append(el("div", { className: "account-last-cell" }, [
      el("strong", { text: formatDate(account.health?.lastSuccessAt || account.updatedAt || account.createdAt) }),
      el("span", { text: account.health?.lastSuccessAt ? new Date(account.health.lastSuccessAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "-" }),
      state === "quarantined"
        ? el("span", { className: "account-quarantine-note", text: account.health?.nextRetryAt ? `Yeniden dene: ${new Date(account.health.nextRetryAt).toLocaleString("tr-TR")}` : "Karantina" })
        : null,
      diagnosis?.isProblem
        ? el("span", { className: `account-problem-inline ${diagnosisTone(diagnosis)}`, text: diagnosis.title })
        : null
    ]));

    const useButton = el("button", { className: "account-icon-action", text: "↔", type: "button", title: "Bu hesabı kullan" });
    const detailsButton = diagnosis?.isProblem
      ? el("button", { className: "account-icon-action", text: "?", type: "button", title: "Sorun nedeni ve çözüm" })
      : null;
    const disableButton = el("button", {
      className: `account-icon-action ${account.disabled ? "" : "danger"}`,
      text: account.disabled ? "⏻" : "⏸",
      type: "button",
      title: account.disabled ? "Hesabı tekrar etkinleştir" : "Hesabı devre dışı bırak"
    });
    const refreshButton = el("button", { className: "account-icon-action", text: "↻", type: "button", title: "Kotaları yenile" });
    const exportButton = el("button", { className: "account-icon-action", text: "⇩", type: "button", title: "Hesabı dışa aktar" });
    const removeButton = el("button", { className: "account-icon-action danger", text: "⌫", type: "button", title: "Hesabı sil" });
    const diagnosisPanel = renderDiagnosisPanel(account);
    useButton.disabled = Boolean(account.disabled);

    if (detailsButton && diagnosisPanel) {
      diagnosisPanel.hidden = true;
      detailsButton.addEventListener("click", () => {
        diagnosisPanel.hidden = !diagnosisPanel.hidden;
        detailsButton.textContent = diagnosisPanel.hidden ? "?" : "×";
      });
    }

    useButton.addEventListener("click", async () => {
      try {
        setBusy(useButton, true, "...");
        await api.switchAccount(account.accountId);
        toast.success("Hesap değiştirildi");
        await onRefresh();
      } catch (error) {
        toast.error(error.message);
      } finally {
        setBusy(useButton, false);
      }
    });
    disableButton.addEventListener("click", async () => {
      try {
        setBusy(disableButton, true, "...");
        if (account.disabled) {
          await api.enableAccount(account.accountId);
          toast.success("Hesap etkinleştirildi");
        } else {
          await api.disableAccount(account.accountId);
          toast.success("Hesap devre dışı bırakıldı");
        }
        await onRefresh();
      } catch (error) {
        toast.error(error.message);
      } finally {
        setBusy(disableButton, false);
      }
    });
    refreshButton.addEventListener("click", async () => {
      try {
        setBusy(refreshButton, true, "...");
        await api.json("/auth/accounts/refresh", {
          method: "POST",
          body: JSON.stringify({ accountId: account.accountId })
        });
        toast.success("Kota yenilendi");
        await onRefresh();
      } catch (error) {
        toast.error(error.message);
      } finally {
        setBusy(refreshButton, false);
      }
    });
    exportButton.addEventListener("click", () => onExportAccount(account));
    removeButton.addEventListener("click", async () => {
      const confirmed = await confirmRemove(account);
      if (!confirmed) return;
      try {
        setBusy(removeButton, true, "...");
        await api.removeAccount(account.accountId);
        toast.success("Hesap silindi");
        await onRefresh();
      } catch (error) {
        toast.error(error.message);
      } finally {
        setBusy(removeButton, false);
      }
    });

    row.append(el("div", { className: "account-actions-cell" }, [useButton, detailsButton, disableButton, refreshButton, exportButton, removeButton].filter(Boolean)));
    if (diagnosisPanel) {
      const fullWidth = el("div", { className: "account-diagnosis-row" }, [diagnosisPanel]);
      fullWidth.style.gridColumn = "1 / -1";
      row.append(fullWidth);
    }
    table.append(row);
  }

  target.append(table);
}
