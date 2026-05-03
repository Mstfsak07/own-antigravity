const secretPattern = /(access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|bearer)\s*[:=]\s*[^,\s"}]+/ig;

export function sanitize(value) {
  return String(value ?? "").replace(secretPattern, "$1: [redacted]");
}

export class ApiClient {
  constructor({ gatewayUrl, getApiKey }) {
    this.gatewayUrl = gatewayUrl;
    this.getApiKey = getApiKey;
  }

  setGatewayUrl(value) {
    this.gatewayUrl = value;
  }

  headers(hasBody = false) {
    const apiKey = this.getApiKey();
    return {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(hasBody ? { "content-type": "application/json" } : {})
    };
  }

  async json(path, options = {}) {
    const response = await fetch(`${this.gatewayUrl}${path}`, {
      ...options,
      headers: {
        ...this.headers(Boolean(options.body)),
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      let message = `${path} -> ${response.status}`;
      try {
        const body = await response.json();
        message = body?.error?.message || message;
      } catch {}
      throw new Error(sanitize(message));
    }

    return response.json();
  }

  health() {
    return this.json("/health");
  }

  healthAccounts() {
    return this.json("/health/accounts");
  }

  summary() {
    return this.json("/auth/accounts/summary");
  }

  accounts() {
    return this.json("/auth/accounts");
  }

  metrics() {
    return this.json("/metrics");
  }

  adminStatus() {
    return this.json("/admin/status");
  }

  refreshQuotas() {
    return this.json("/auth/accounts/refresh", {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  switchAccount(accountId) {
    return this.json(`/auth/accounts/switch/${encodeURIComponent(accountId)}`, { method: "POST" });
  }

  disableAccount(accountId) {
    return this.json(`/auth/accounts/disable/${encodeURIComponent(accountId)}`, { method: "POST" });
  }

  disableBrokenAccounts() {
    return this.json("/auth/accounts/disable-broken", { method: "POST" });
  }

  checkAllAccounts() {
    return this.json("/auth/accounts/check-all", { method: "POST" });
  }

  enableAccount(accountId) {
    return this.json(`/auth/accounts/enable/${encodeURIComponent(accountId)}`, { method: "POST" });
  }

  removeAccount(accountId) {
    return this.json(`/auth/google/logout/${encodeURIComponent(accountId)}`, { method: "POST" });
  }

  importRefreshToken(payload) {
    return this.json("/auth/accounts/import/refresh-token", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  importJson(rawJson) {
    return this.json("/auth/accounts/import/json", {
      method: "POST",
      body: rawJson
    });
  }

  exportAccounts(includeEncryptedSecrets) {
    return this.json("/auth/accounts/export", {
      method: "POST",
      body: JSON.stringify({ includeEncryptedSecrets })
    });
  }
}
