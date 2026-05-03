function emptyMetrics() {
  return {
    uptimeSeconds: 0,
    providerRequests: {},
    providerErrors: {},
    recentErrors: [],
    recentRequests: []
  };
}

export function createRuntimeSyncController(options) {
  const {
    api,
    state,
    toast,
    windowObject,
    setLoading,
    renderDashboardLoading,
    renderAccountsLoading,
    renderApiProxyLoading,
    getNode,
    renderDashboardSection,
    renderTrafficSection,
    renderTrafficColumns,
    renderTrafficViews,
    renderAll
  } = options;

  let trafficPollTimer;
  let quotaRefreshAttempted = false;

  async function refreshTraffic() {
    if (!api) return;
    try {
      state.metrics = await api.metrics();
      renderDashboardSection();
      renderTrafficSection();
      renderTrafficColumns();
      renderTrafficViews();
    } catch {}
  }

  function stopTrafficPolling() {
    if (trafficPollTimer) {
      windowObject.clearInterval(trafficPollTimer);
      trafficPollTimer = undefined;
    }
  }

  function startTrafficPolling() {
    stopTrafficPolling();
    trafficPollTimer = windowObject.setInterval(() => {
      void refreshTraffic();
    }, 2000);
  }

  async function refreshData() {
    setLoading(true);
    renderDashboardLoading(getNode("overviewCards"));
    renderAccountsLoading(getNode("accountCards"));
    renderApiProxyLoading(getNode("apiProxyRoot"));
    try {
      const gatewayStatus = windowObject.ownAg.gatewayStatus
        ? await windowObject.ownAg.gatewayStatus().catch(() => ({ running: true, owned: true }))
        : { running: true, owned: true };
      if (!gatewayStatus?.running) {
        state.health = { status: "offline", providers: {} };
        state.summary = {
          totalAccounts: 0,
          healthyAccounts: 0,
          activeAccountId: undefined,
          bestAccount: undefined,
          lowQuotaWarnings: ["Gateway stopped. Start the service to load live data."]
        };
        state.accounts = [];
        state.accountHealth = { accounts: [] };
        state.metrics = emptyMetrics();
        state.adminStatus = {
          status: "stopped",
          host: gatewayStatus?.url?.split("://")[1]?.split(":")?.[0] || "127.0.0.1",
          port: Number(gatewayStatus?.url?.split(":")?.at(-1) || 8046)
        };
        renderAll();
        return;
      }

      const healthResult = await api.health().catch((error) => ({ error }));
      const [summaryResult, accountsResult, metricsResult, adminResult, accountHealthResult] = await Promise.allSettled([
        api.summary(),
        api.accounts(),
        api.metrics(),
        api.adminStatus(),
        api.healthAccounts()
      ]);

      if (healthResult.error) {
        state.health = { status: "offline", providers: {} };
        toast.error(healthResult.error.message);
      } else {
        state.health = healthResult;
      }

      state.summary = summaryResult.status === "fulfilled"
        ? summaryResult.value
        : {
            totalAccounts: 0,
            healthyAccounts: 0,
            activeAccountId: undefined,
            bestAccount: undefined,
            lowQuotaWarnings: ["Admin API key required. Open Settings and enter your local gateway key."]
          };
      state.accounts = accountsResult.status === "fulfilled" ? accountsResult.value.accounts || [] : [];
      state.metrics = metricsResult.status === "fulfilled" ? metricsResult.value : emptyMetrics();
      state.adminStatus = adminResult.status === "fulfilled" ? adminResult.value : undefined;
      state.accountHealth = accountHealthResult.status === "fulfilled" ? accountHealthResult.value : { accounts: [] };

      const failures = [summaryResult, accountsResult, metricsResult, accountHealthResult].filter((result) => result?.status === "rejected");
      if (failures.length > 0) {
        toast.info("Some gateway data needs the Admin API key. Open Settings.");
      }
      renderAll();
      if (!quotaRefreshAttempted && state.accounts.length > 0 && state.accounts.every((account) => !account.quota?.length)) {
        quotaRefreshAttempted = true;
        toast.info("Model kotaları yenileniyor");
        try {
          await api.refreshQuotas();
          const accountsAfterQuota = await api.accounts();
          const summaryAfterQuota = await api.summary();
          const accountHealthAfterQuota = await api.healthAccounts().catch(() => ({ accounts: [] }));
          state.accounts = accountsAfterQuota.accounts || [];
          state.summary = summaryAfterQuota;
          state.accountHealth = accountHealthAfterQuota;
          renderAll();
        } catch (error) {
          toast.error(`Kota yenilenemedi: ${error.message}`);
        }
      }
    } catch (error) {
      toast.error(error.message);
      state.health = { status: "offline", providers: {} };
      state.summary = {
        totalAccounts: 0,
        healthyAccounts: 0,
        activeAccountId: undefined,
        bestAccount: undefined,
        lowQuotaWarnings: ["Gateway data could not be loaded."]
      };
      state.accounts = [];
      state.accountHealth = { accounts: [] };
      state.adminStatus = undefined;
      state.metrics = emptyMetrics();
      renderAll();
    } finally {
      setLoading(false);
    }
  }

  return {
    refreshTraffic,
    refreshData,
    startTrafficPolling,
    stopTrafficPolling
  };
}
