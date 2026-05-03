export function createOAuthWatchController(options) {
  const {
    api,
    state,
    toast,
    windowObject,
    accountFingerprint,
    refreshData
  } = options;

  let oauthWatchTimer;
  let oauthWatchStopAt = 0;
  let oauthBaseline = "";

  function stopOAuthWatch() {
    if (oauthWatchTimer) {
      windowObject.clearInterval(oauthWatchTimer);
      oauthWatchTimer = undefined;
    }
    oauthWatchStopAt = 0;
  }

  function startOAuthWatch() {
    stopOAuthWatch();
    oauthBaseline = accountFingerprint(state.accounts);
    oauthWatchStopAt = Date.now() + 2 * 60 * 1000;
    oauthWatchTimer = windowObject.setInterval(async () => {
      if (Date.now() >= oauthWatchStopAt) {
        stopOAuthWatch();
        return;
      }
      try {
        const accountsResult = await api.accounts();
        const nextAccounts = accountsResult.accounts || [];
        const nextFingerprint = accountFingerprint(nextAccounts);
        if (nextFingerprint === oauthBaseline) {
          return;
        }

        state.accounts = nextAccounts;
        oauthBaseline = nextFingerprint;
        const newest = [...nextAccounts]
          .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))[0];
        if (newest && (!Array.isArray(newest.quota) || newest.quota.length === 0)) {
          await api.json("/auth/accounts/refresh", {
            method: "POST",
            body: JSON.stringify({ accountId: newest.accountId })
          }).catch(() => undefined);
        }
        await refreshData();
        const active = newest?.email || newest?.displayName || newest?.accountId || "Yeni hesap";
        toast.success(`${active} account active`);
        stopOAuthWatch();
      } catch {}
    }, 3000);
  }

  return {
    startOAuthWatch,
    stopOAuthWatch
  };
}
