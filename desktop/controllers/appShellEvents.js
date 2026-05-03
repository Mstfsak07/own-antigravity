export function bindAppShellEvents(options) {
  const {
    getNode,
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
  } = options;

  document.querySelectorAll(".nav").forEach((button) => {
    button.addEventListener("click", () => showPage(button.dataset.page));
  });

  getNode("refresh").addEventListener("click", async () => {
    try {
      setBusy(getNode("refresh"), true, "Refreshing");
      await api.refreshQuotas().catch(() => undefined);
      await refreshData();
    } finally {
      setBusy(getNode("refresh"), false);
    }
  });

  getNode("themeToggle").addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark"));
  getNode("language").addEventListener("change", (event) => setLanguage(event.target.value));

  bindTrafficEvents({ saveTrafficView });
  setupTabs(getNode);
  renderTrafficColumns();
}

function setupTabs(getNode) {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab,.tab-panel").forEach((node) => node.classList.remove("active"));
      button.classList.add("active");
      getNode(`tab-${button.dataset.tab}`).classList.add("active");
    });
  });
}
