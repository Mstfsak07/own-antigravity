export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Own Antigravity</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17211d;
      --muted: #5e6b65;
      --line: #d7dfd7;
      --paper: #f6f7f2;
      --panel: #ffffff;
      --green: #17764b;
      --red: #b63c2f;
      --blue: #245f8f;
      --gold: #a86f16;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(135deg, #f6f7f2 0%, #eef5f0 48%, #f7f0e7 100%);
      color: var(--ink);
      font-family: "Aptos", "Segoe UI", sans-serif;
    }
    main {
      width: min(1120px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 32px 0;
    }
    header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 20px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 54px);
      font-weight: 780;
      letter-spacing: 0;
    }
    .subtitle {
      margin-top: 8px;
      color: var(--muted);
      font-size: 15px;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    input, button {
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--ink);
      font: inherit;
    }
    input {
      width: 260px;
      padding: 0 10px;
    }
    button {
      padding: 0 14px;
      cursor: pointer;
      font-weight: 650;
    }
    section {
      margin-top: 22px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .panel {
      background: color-mix(in srgb, var(--panel) 90%, transparent);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      min-height: 132px;
    }
    .label {
      color: var(--muted);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .value {
      margin-top: 10px;
      font-size: 26px;
      font-weight: 760;
      overflow-wrap: anywhere;
    }
    .ok { color: var(--green); }
    .bad { color: var(--red); }
    .info { color: var(--blue); }
    .warn { color: var(--gold); }
    table {
      width: 100%;
      border-collapse: collapse;
      background: color-mix(in srgb, var(--panel) 90%, transparent);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      text-align: left;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    tr:last-child td { border-bottom: 0; }
    pre {
      margin: 0;
      padding: 16px;
      background: #17211d;
      color: #ecf4ed;
      border-radius: 8px;
      overflow: auto;
      font-size: 13px;
      line-height: 1.5;
    }
    @media (max-width: 780px) {
      header { align-items: stretch; flex-direction: column; }
      .toolbar { flex-direction: column; align-items: stretch; }
      input, button { width: 100%; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Own Antigravity</h1>
        <div class="subtitle">Local proxy status for Gemini, Anthropic, and OpenAI-compatible clients.</div>
      </div>
      <div class="toolbar">
        <input id="key" type="password" placeholder="local API key">
        <button id="login-google">Login with Google</button>
        <button id="run-ls-diag">Run LS Diagnostic</button>
        <button id="refresh">Refresh</button>
      </div>
    </header>

    <section class="grid">
      <div class="panel">
        <div class="label">Gemini</div>
        <div id="gemini" class="value warn">loading</div>
      </div>
      <div class="panel">
        <div class="label">Anthropic</div>
        <div id="anthropic" class="value warn">loading</div>
      </div>
      <div class="panel">
        <div class="label">CloudCode</div>
        <div id="cloudcode" class="value warn">loading</div>
      </div>
      <div class="panel">
        <div class="label">Requests</div>
        <div id="requests" class="value info">0</div>
      </div>
      <div class="panel">
        <div class="label">Errors</div>
        <div id="errors" class="value warn">0</div>
      </div>
      <div class="panel">
        <div class="label">Uptime</div>
        <div id="uptime" class="value info">0s</div>
      </div>
      <div class="panel">
        <div class="label">Last Error</div>
        <div id="last-error" class="value warn">none</div>
      </div>
      <div class="panel">
        <div class="label">LS Instances</div>
        <div id="ls-instances" class="value info">0</div>
      </div>
      <div class="panel">
        <div class="label">Provision</div>
        <div id="provision" class="value warn">checking</div>
      </div>
      <div class="panel">
        <div class="label">Asset</div>
        <div id="asset" class="value info">none</div>
      </div>
      <div class="panel">
        <div class="label">Native LS</div>
        <div id="native-ls" class="value warn">disabled</div>
      </div>
      <div class="panel">
        <div class="label">Fallbacks</div>
        <div id="fallbacks" class="value info">0</div>
      </div>
      <div class="panel">
        <div class="label">Auth Server</div>
        <div id="auth-server" class="value warn">stopped</div>
      </div>
      <div class="panel">
        <div class="label">Protocol</div>
        <div id="protocol" class="value info">unknown</div>
      </div>
    </section>

    <section>
      <table>
        <thead><tr><th>Native LS diagnostic</th><th>Status</th></tr></thead>
        <tbody id="ls-diagnostics"><tr><td colspan="2">loading</td></tr></tbody>
      </table>
    </section>

    <section>
      <table>
        <thead><tr><th>Account</th><th>Source</th><th>Health</th><th>Token expiry</th><th>Action</th></tr></thead>
        <tbody id="accounts"><tr><td colspan="5">loading</td></tr></tbody>
      </table>
    </section>

    <section>
      <table>
        <thead><tr><th>Alias</th><th>Target model</th></tr></thead>
        <tbody id="aliases"><tr><td colspan="2">loading</td></tr></tbody>
      </table>
    </section>

    <section>
      <pre id="raw">loading</pre>
    </section>
  </main>
  <script>
    const keyInput = document.getElementById("key");
    const refresh = document.getElementById("refresh");
    const loginGoogle = document.getElementById("login-google");
    const runLsDiag = document.getElementById("run-ls-diag");
    const raw = document.getElementById("raw");
    const headers = () => keyInput.value ? { Authorization: "Bearer " + keyInput.value } : {};

    async function getJson(path) {
      const response = await fetch(path, { headers: headers() });
      if (!response.ok) throw new Error(path + " -> " + response.status);
      return response.json();
    }

    function expiryText(value) {
      if (!value) return "unknown";
      return new Date(value * 1000).toLocaleString();
    }

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }

    function accountLabel(account) {
      return account.email || account.displayName || account.accountId;
    }

    async function removeAccount(accountId) {
      const response = await fetch("/auth/google/logout/" + encodeURIComponent(accountId), {
        method: "POST",
        headers: headers()
      });
      if (!response.ok) throw new Error("logout -> " + response.status);
      await load();
    }

    async function runDiagnostic() {
      const response = await fetch("/v1/ls/diagnostics/run", {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ disableFallback: true, timeoutMs: 10000 })
      });
      if (!response.ok) throw new Error("ls diagnostics -> " + response.status);
      await load();
    }

    async function load() {
      try {
        const status = await getJson("/admin/status");
        const metrics = await getJson("/admin/metrics");
        const auth = await getJson("/auth/accounts");
        const diagnostics = await getJson("/v1/ls/diagnostics");
        const geminiHealthy = status.providers.gemini.keys.filter((key) => key.healthy).length;
        const anthropicHealthy = status.providers.anthropic.keys.filter((key) => key.healthy).length;
        const cloud = status.providers.cloudCode;
        document.getElementById("gemini").textContent = status.providers.gemini.active
          ? geminiHealthy + "/" + status.providers.gemini.keyCount + " keys"
          : "missing key";
        document.getElementById("gemini").className = "value " + (geminiHealthy > 0 ? "ok" : "bad");
        document.getElementById("anthropic").textContent = status.providers.anthropic.active
          ? anthropicHealthy + "/" + status.providers.anthropic.keyCount + " keys"
          : "missing key";
        document.getElementById("anthropic").className = "value " + (anthropicHealthy > 0 ? "ok" : "bad");
        document.getElementById("cloudcode").textContent = cloud.active
          ? cloud.healthyCount + "/" + cloud.accountCount + " healthy"
          : "no accounts";
        document.getElementById("cloudcode").className = "value " + (cloud.healthyCount > 0 ? "ok" : "bad");
        document.getElementById("requests").textContent = metrics.totalRequests;
        document.getElementById("errors").textContent = metrics.errorCount;
        document.getElementById("errors").className = "value " + (metrics.errorCount > 0 ? "bad" : "ok");
        document.getElementById("uptime").textContent = Math.floor(metrics.uptimeSeconds) + "s";
        document.getElementById("last-error").textContent = metrics.lastError
          ? metrics.lastError.route + " -> " + metrics.lastError.statusCode
          : "none";
        document.getElementById("ls-instances").textContent = status.ls.instances.length;
        document.getElementById("provision").textContent = status.ls.provision.ready
          ? status.ls.provision.source + " ready"
          : status.ls.provision.lastError || "missing";
        document.getElementById("provision").className = "value " + (status.ls.provision.ready ? "ok" : "bad");
        document.getElementById("asset").textContent = status.ls.provision.lsCorePath || "none";
        document.getElementById("native-ls").textContent = status.ls.provision.ready
          ? "enabled / " + status.ls.instances.length + " instances"
          : "missing";
        document.getElementById("native-ls").className = "value " + (status.ls.provision.ready ? "ok" : "bad");
        document.getElementById("fallbacks").textContent = metrics.fallbackCount;
        document.getElementById("auth-server").textContent = status.ls.tokenServer.running ? "running" : "stopped";
        document.getElementById("protocol").textContent = status.ls.protocol.active +
          (status.ls.protocol.streamSupported ? " / stream" : " / unary");
        document.getElementById("aliases").innerHTML = Object.entries(status.modelAliases)
          .map(([alias, target]) => "<tr><td>" + alias + "</td><td>" + target + "</td></tr>")
          .join("");
        document.getElementById("accounts").innerHTML = auth.accounts.length
          ? auth.accounts.map((account) =>
              "<tr><td>" + esc(accountLabel(account)) + "</td><td>" + esc(account.source) + "</td><td>" +
              (account.health && account.health.healthy ? "healthy" : "unhealthy") + "</td><td>" +
              esc(expiryText(account.expiresAt)) + "</td><td><button data-remove='" + esc(account.accountId) + "'>Remove</button></td></tr>"
            ).join("")
          : "<tr><td colspan='5'>no connected accounts</td></tr>";
        document.querySelectorAll("[data-remove]").forEach((button) => {
          button.addEventListener("click", () => removeAccount(button.getAttribute("data-remove")));
        });
        const last = diagnostics.last;
        document.getElementById("ls-diagnostics").innerHTML = [
          ["binary status", diagnostics.binary && diagnostics.binary.found ? "found" : "missing"],
          ["process status", last ? (last.process.spawnSuccess ? "spawn ok" : "spawn fail") : "not run"],
          ["handshake status", last ? (last.handshake.success ? "ok" : "fail") : "not run"],
          ["native request status", last ? (last.nativeRequest.success ? "ok" : "fail") : "not run"],
          ["last diagnostic time", last ? last.checkedAt : "never"],
          ["last error", last && last.error ? last.error.code + ": " + last.error.message : "none"],
          ["fallback used", last ? String(last.fallbackUsed) : "unknown"]
        ].map(([key, value]) => "<tr><td>" + esc(key) + "</td><td>" + esc(value) + "</td></tr>").join("");
        raw.textContent = JSON.stringify({ status, metrics }, null, 2);
      } catch (error) {
        raw.textContent = error.message;
      }
    }

    refresh.addEventListener("click", load);
    loginGoogle.addEventListener("click", () => {
      const query = keyInput.value ? "?key=" + encodeURIComponent(keyInput.value) : "";
      window.location.href = "/auth/google/start" + query;
    });
    runLsDiag.addEventListener("click", () => runDiagnostic().catch((error) => { raw.textContent = error.message; }));
    load();
  </script>
</body>
</html>`;
}
