export function bindAccountEvents(options) {
  const {
    getNode,
    api,
    state,
    toast,
    setBusy,
    renderAll,
    refreshData,
    accountActions,
    startOAuthWatch,
    renderTrafficColumns
  } = options;

  getNode("accountSearch")?.addEventListener("input", () => renderAll());
  getNode("refreshAccounts")?.addEventListener("click", async () => {
    try {
      setBusy(getNode("refreshAccounts"), true, "Yenileniyor");
      await api.refreshQuotas();
      await refreshData();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(getNode("refreshAccounts"), false);
    }
  });
  getNode("disableBrokenAccounts")?.addEventListener("click", async () => {
    try {
      setBusy(getNode("disableBrokenAccounts"), true, "Kontrol ediliyor");
      const result = await api.checkAllAccounts();
      await refreshData();
      toast.success(
        result.disabledCount > 0
          ? `${result.checkedCount} hesap kontrol edildi, ${result.disabledCount} sorunlu hesap pasife alındı`
          : `${result.checkedCount} hesap kontrol edildi, pasife alınacak sorun bulunmadı`
      );
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(getNode("disableBrokenAccounts"), false);
    }
  });

  document.querySelectorAll(".account-filter").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".account-filter").forEach((node) => node.classList.remove("active"));
      button.classList.add("active");
      renderAll();
    });
  });

  getNode("addAccount").addEventListener("click", () => getNode("accountModal").showModal());
  getNode("dashboardAddAccount").addEventListener("click", () => getNode("accountModal").showModal());
  getNode("openExport").addEventListener("click", () => getNode("exportModal").showModal());
  getNode("runExport").addEventListener("click", () => accountActions?.runExport());
  getNode("importManual").addEventListener("click", () => accountActions?.importManual());
  getNode("importJson").addEventListener("click", () => accountActions?.importJson());
  getNode("startOAuth").addEventListener("click", () => {
    const key = state.apiKey ? `?key=${encodeURIComponent(state.apiKey)}` : "";
    startOAuthWatch();
    window.ownAg.openExternal(`${state.gateway}/auth/google/start${key}`);
    toast.info("OAuth opened in browser");
  });

  setupJsonDropzone(getNode, toast);
  renderTrafficColumns();
}

function setupJsonDropzone(getNode, toast) {
  const dropzone = getNode("jsonDropzone");
  const fileInput = getNode("jsonFile");
  const loadFile = async (file) => {
    if (!file) return;
    getNode("jsonImport").value = await file.text();
    toast.info("JSON file loaded");
  };

  fileInput.addEventListener("change", () => loadFile(fileInput.files?.[0]));
  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });
  dropzone.addEventListener("drop", (event) => loadFile(event.dataTransfer?.files?.[0]));
}
