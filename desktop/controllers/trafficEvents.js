export function createTrafficEventsBinder(options) {
  const {
    getNode,
    state,
    renderMetrics,
    renderTraffic,
    renderTrafficColumns,
    persistTrafficColumns,
    defaultTrafficColumns,
    trafficRenderOptions,
    saveTrafficView
  } = options;

  return function bindTrafficEvents({ saveTrafficView: nextSaveTrafficView = saveTrafficView } = {}) {
    getNode("globalSearch").addEventListener("input", () => renderMetrics(state.metrics, {
      ...trafficRenderOptions(),
      filter: getNode("globalSearch").value
    }));
    getNode("trafficFilter")?.addEventListener("input", renderTraffic);
    getNode("trafficStatus")?.addEventListener("change", renderTraffic);
    getNode("trafficMinTokens")?.addEventListener("input", renderTraffic);
    getNode("trafficStart")?.addEventListener("change", renderTraffic);
    getNode("trafficEnd")?.addEventListener("change", renderTraffic);
    getNode("saveTrafficView")?.addEventListener("click", nextSaveTrafficView);
    getNode("trafficColumnsReset")?.addEventListener("click", () => {
      state.trafficColumns = defaultTrafficColumns();
      persistTrafficColumns(state);
      renderTrafficColumns();
      renderTraffic();
    });

    document.querySelectorAll(".filter-chip").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".filter-chip").forEach((node) => node.classList.remove("active"));
        button.classList.add("active");
        const label = button.textContent?.trim() || "";
        if (label === "Tümü") {
          if (getNode("trafficFilter")) getNode("trafficFilter").value = "";
          if (getNode("trafficStatus")) getNode("trafficStatus").value = "all";
        } else if (label === "Hata") {
          if (getNode("trafficFilter")) getNode("trafficFilter").value = "";
          if (getNode("trafficStatus")) getNode("trafficStatus").value = "error";
        } else {
          if (getNode("trafficFilter")) getNode("trafficFilter").value = label;
          if (getNode("trafficStatus")) getNode("trafficStatus").value = "all";
        }
        renderTraffic();
      });
    });
  };
}
