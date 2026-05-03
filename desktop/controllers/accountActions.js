function isAppBackupBundle(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      typeof data.kind === "string" &&
      data.kind.startsWith("own-antigravity-backup")
  );
}

export function createAccountActionsController(options) {
  const {
    api,
    state,
    toast,
    windowObject,
    getNode,
    setBusy,
    refreshData,
    renderTrafficColumns,
    renderTrafficViews,
    renderAll,
    applyDesktopPreferences,
    setTheme,
    setLanguage,
    snapshotDesktopPreferences
  } = options;

  async function confirmRemove(account) {
    getNode("confirmTitle").textContent = "Remove account?";
    getNode("confirmMessage").textContent = `Remove ${account.email || account.accountId} from this local registry?`;
    const modal = getNode("confirmModal");
    modal.showModal();
    return new Promise((resolve) => {
      const cleanup = () => {
        getNode("confirmAccept").removeEventListener("click", accept);
        getNode("confirmCancel").removeEventListener("click", cancel);
        modal.removeEventListener("cancel", cancel);
      };
      const accept = () => {
        cleanup();
        resolve(true);
      };
      const cancel = () => {
        cleanup();
        resolve(false);
      };
      getNode("confirmAccept").addEventListener("click", accept, { once: true });
      getNode("confirmCancel").addEventListener("click", cancel, { once: true });
      modal.addEventListener("cancel", cancel, { once: true });
    });
  }

  function exportOneAccount(account) {
    getNode("exportModal").showModal();
    getNode("encryptedExport").checked = false;
    getNode("exportOutput").value = JSON.stringify({
      encrypted: false,
      account
    }, null, 2);
    toast.info("Account export prepared");
  }

  async function runExport() {
    const button = getNode("runExport");
    try {
      setBusy(button, true, "Exporting");
      const [accountsExport, gatewayConfig] = await Promise.all([
        api.exportAccounts(getNode("encryptedExport").checked),
        windowObject.ownAg.gatewayConfig()
      ]);
      const bundle = {
        kind: "own-antigravity-backup-v1",
        exportedAt: new Date().toISOString(),
        renderer: snapshotDesktopPreferences(state),
        gatewayConfig,
        accountsExport
      };
      getNode("exportOutput").value = JSON.stringify(bundle, null, 2);
      await navigator.clipboard.writeText(getNode("exportOutput").value);
      toast.success("Export completed");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function importManual() {
    const button = getNode("importManual");
    try {
      setBusy(button, true, "Importing");
      await api.importRefreshToken({
        email: getNode("manualEmail").value || undefined,
        refreshToken: getNode("manualRefreshToken").value
      });
      getNode("accountModal").close();
      toast.success("Account added");
      await refreshData();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function importJson() {
    const button = getNode("importJson");
    try {
      setBusy(button, true, "Importing");
      const raw = getNode("jsonImport").value;
      const parsed = JSON.parse(raw);
      if (isAppBackupBundle(parsed)) {
        if (parsed.gatewayConfig) {
          await windowObject.ownAg.gatewayConfigImport(parsed.gatewayConfig);
        }
        if (parsed.accountsExport) {
          await api.importJson(JSON.stringify(parsed.accountsExport));
        }
        if (parsed.renderer) {
          applyDesktopPreferences(state, parsed.renderer, { setTheme, setLanguage });
        }
        getNode("accountModal").close();
        renderTrafficColumns();
        renderTrafficViews();
        renderAll();
        toast.success("Yedek geri yüklendi. Config değişiklikleri için gateway restart gerekebilir.");
        await refreshData();
        return;
      }
      await api.importJson(raw);
      getNode("accountModal").close();
      toast.success("Account added");
      await refreshData();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  return {
    confirmRemove,
    exportOneAccount,
    runExport,
    importManual,
    importJson,
    isAppBackupBundle
  };
}
