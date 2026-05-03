import { clear, el, renderSkeleton, setBusy } from "./dom.js";

const GEMINI_MODEL_OPTIONS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-image",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite-001"
];

const ZAI_MODEL_OPTIONS = [
  "glm-4.6",
  "glm-4.5-air",
  "glm-4.5v",
  "glm-4.1v-thinking"
];

const ROUTING_TARGET_OPTIONS = [
  ...GEMINI_MODEL_OPTIONS,
  ...ZAI_MODEL_OPTIONS,
  "claude-haiku-4-5",
  "claude-sonnet-4-5"
];

const MODEL_STRATEGY_PRESETS = [
  {
    alias: "gpt-5",
    label: "GPT-5",
    note: "Yüksek düşünme maliyetini Gemini Pro veya Claude Sonnet'e yönlendirmek için."
  },
  {
    alias: "gpt-4.1",
    label: "GPT-4.1",
    note: "Ara seviye genel amaçlı istekleri dengeli modele sabitlemek için."
  },
  {
    alias: "gpt-4o",
    label: "GPT-4o",
    note: "Hız odaklı OpenAI uyumlu işleri Flash veya benzeri hedefe map etmek için."
  },
  {
    alias: "gemini-latest",
    label: "Gemini Latest",
    note: "Eski ve latest tabanlı Gemini istemcilerini canonical hedefe toplar."
  },
  {
    alias: "gemini-pro-latest",
    label: "Gemini Pro Latest",
    note: "Pro aile istekleri için stabil sabitleme noktası."
  },
  {
    alias: "gemini-flash-latest",
    label: "Gemini Flash Latest",
    note: "Düşük gecikmeli Gemini işleri için Flash yönlendirmesi."
  },
  {
    alias: "claude-haiku",
    label: "Claude Haiku",
    note: "Hafif Claude işleri için Haiku hedefini sabitlemek için."
  },
  {
    alias: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    note: "Claude uyumlu istemciler CloudCode hesabı bulduğunda doğrudan geçebilir."
  }
];

const PRESET_ALIAS_SET = new Set(MODEL_STRATEGY_PRESETS.map((item) => item.alias));

let targetInputSequence = 0;

function statusLabel(adminStatus) {
  return adminStatus?.status === "ok" ? "Hizmet Çalışıyor" : "Hizmet Durduruldu";
}

function statusClass(adminStatus) {
  return adminStatus?.status === "ok" ? "healthy" : "unhealthy";
}

function boolText(value) {
  return value ? "Açık" : "Kapalı";
}

function formatUrl(host, port) {
  if (!host || !port) return "unknown";
  return `http://${host}:${port}`;
}

function toggle(checked = false) {
  const input = el("input", { attrs: { type: "checkbox" } });
  input.checked = Boolean(checked);
  return {
    input,
    node: el("label", { className: "toggle-switch" }, [
      input,
      el("span", { className: "toggle-track" })
    ])
  };
}

function field(label, control, hint, className = "") {
  return el("div", { className: `proxy-field ${className}`.trim() }, [
    el("div", { className: "proxy-field-label" }, [
      el("span", { text: label }),
      hint ? el("small", { text: hint }) : el("span", { text: "" })
    ]),
    control
  ]);
}

function iconButton(glyph, label, onClick) {
  const button = el("button", { className: "icon-chip", text: glyph, type: "button", title: label });
  button.addEventListener("click", onClick);
  return button;
}

function details(title, subtitle, body, open = false) {
  const node = el("details", { className: "proxy-accordion" }, [
    el("summary", {}, [
      el("div", { className: "proxy-accordion-title" }, [
        el("strong", { text: title }),
        el("span", { text: subtitle })
      ]),
      el("span", { className: "accordion-chevron", text: "⌄" })
    ]),
    el("div", { className: "proxy-accordion-body" }, body)
  ]);
  node.open = open;
  return node;
}

function settingRow(label, value) {
  return el("div", { className: "mini-setting" }, [
    el("span", { text: label }),
    el("strong", { text: value })
  ]);
}

function parseAliases(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Alias map bir JSON nesnesi olmalı");
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => [String(key).trim(), String(value).trim()])
        .filter(([key, value]) => key && value)
    );
  } catch (error) {
    throw new Error(`Alias JSON geçersiz: ${error.message}`);
  }
}

function parseMcpServers(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) {
      throw new Error("MCP server listesi JSON dizi olmalı");
    }
    return parsed.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`MCP server #${index + 1} nesne olmalı`);
      }
      const server = item;
      const id = String(server.id || "").trim();
      if (!id) {
        throw new Error(`MCP server #${index + 1} için id zorunlu`);
      }
      const transport = String(server.transport || "stdio");
      if (!["stdio", "http", "sse"].includes(transport)) {
        throw new Error(`MCP server "${id}" için transport geçersiz`);
      }
      const env = server.env && typeof server.env === "object" && !Array.isArray(server.env)
        ? Object.fromEntries(
          Object.entries(server.env).map(([key, value]) => [String(key), String(value)])
        )
        : {};
      return {
        id,
        enabled: server.enabled !== false,
        transport,
        command: server.command ? String(server.command).trim() : undefined,
        args: Array.isArray(server.args) ? server.args.map((value) => String(value)) : [],
        url: server.url ? String(server.url).trim() : undefined,
        workingDirectory: server.workingDirectory ? String(server.workingDirectory).trim() : undefined,
        env
      };
    });
  } catch (error) {
    throw new Error(`MCP JSON geçersiz: ${error.message}`);
  }
}

function formatAliases(map) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(map).sort(([left], [right]) => left.localeCompare(right))
    ),
    null,
    2
  );
}

function formatMcpServers(servers) {
  return JSON.stringify(servers, null, 2);
}

function targetInput(value = "") {
  const listId = `route-target-options-${targetInputSequence += 1}`;
  const input = el("input", {
    attrs: {
      autocomplete: "off",
      list: listId,
      placeholder: "Model hedefi"
    },
    value
  });
  const suggestions = el(
    "datalist",
    { attrs: { id: listId } },
    ROUTING_TARGET_OPTIONS.map((option) => el("option", { attrs: { value: option } }))
  );
  return {
    input,
    node: el("div", { className: "strategy-target-input" }, [input, suggestions])
  };
}

export function renderApiProxyLoading(target) {
  renderSkeleton(target, 6, "proxy-skeleton");
}

export function renderApiProxy({ gatewayConfig, adminStatus, onRefresh, onStartService, onStopService, onSaveConfig, toast }) {
  const target = document.getElementById("apiProxyRoot");
  clear(target);

  const serviceRunning = adminStatus?.status === "ok";
  const proxyHost = adminStatus?.host || gatewayConfig?.host || "127.0.0.1";
  const proxyPort = adminStatus?.port || gatewayConfig?.port || 8046;
  const gatewayUrl = formatUrl(proxyHost, proxyPort);
  const apiKey = gatewayConfig?.localApiKey || "";
  const lsConfig = gatewayConfig?.ls || {};
  const cloudConfig = gatewayConfig?.cloudCode || {};
  const geminiConfig = gatewayConfig?.gemini || {};
  const zaiConfig = gatewayConfig?.zai || {};
  const mcpConfig = gatewayConfig?.mcp || {};
  const authEnabled = Boolean(apiKey);
  const modelAliases = gatewayConfig?.modelAliases || {};

  const portInput = el("input", { attrs: { value: String(proxyPort) } });
  const timeoutInput = el("input", { attrs: { type: "number", value: String(lsConfig.requestTimeoutMs ?? 120) } });
  const instanceTtlInput = el("input", { attrs: { type: "number", value: String(lsConfig.instanceTtlSeconds ?? 1800) } });
  const maxInstancesInput = el("input", { attrs: { type: "number", value: String(lsConfig.maxInstances ?? 3) } });
  const geminiBaseUrlInput = el("input", { attrs: { value: geminiConfig.baseUrl || "", autocomplete: "off" } });
  const geminiModelSelect = el("select");
  for (const model of [...new Set([geminiConfig.defaultModel || "gemini-2.5-pro", ...GEMINI_MODEL_OPTIONS])]) {
    geminiModelSelect.append(el("option", { text: model, value: model }));
  }
  geminiModelSelect.value = geminiConfig.defaultModel || "gemini-2.5-pro";
  const aliasInput = el("textarea", {
    attrs: { autocomplete: "off", spellcheck: "false" },
    value: formatAliases(modelAliases)
  });
  const presetEditors = new Map();
  const customRows = [];
  let syncingAliasControls = false;
  const authMode = el("select", {}, [
    el("option", { text: "Kapalı (Açık)", value: "off" }),
    el("option", { text: "Açık", value: "on" })
  ]);
  authMode.value = authEnabled ? "on" : "off";

  const apiKeyInput = el("input", { attrs: { value: apiKey, autocomplete: "off" } });
  const passwordInput = el("input", { attrs: { value: apiKey, autocomplete: "off" } });
  const userAgentInput = el("input", { attrs: { value: cloudConfig.userAgent || "antigravity", autocomplete: "off" } });
  const baseUrlsInput = el("textarea", {
    attrs: { autocomplete: "off", spellcheck: "false" },
    value: (cloudConfig.baseUrls || []).join("\n")
  });
  const zaiApiKeyInput = el("input", { attrs: { value: zaiConfig.apiKey || "", autocomplete: "off" } });
  const zaiBaseUrlInput = el("input", { attrs: { value: zaiConfig.baseUrl || "https://api.z.ai/api/paas/v4", autocomplete: "off" } });
  const zaiModelSelect = el("select");
  for (const model of [...new Set([zaiConfig.defaultModel || "glm-4.6", ...ZAI_MODEL_OPTIONS])]) {
    zaiModelSelect.append(el("option", { text: model, value: model }));
  }
  zaiModelSelect.value = zaiConfig.defaultModel || "glm-4.6";
  const mcpTimeoutInput = el("input", { attrs: { type: "number", value: String(mcpConfig.requestTimeoutMs ?? 45000) } });
  const mcpServersInput = el("textarea", {
    attrs: { autocomplete: "off", spellcheck: "false" },
    value: formatMcpServers(mcpConfig.servers || [])
  });
  const refreshSkewInput = el("input", { attrs: { type: "number", value: String(cloudConfig.refreshSkewSeconds ?? 120) } });
  const quarantineInput = el("input", { attrs: { type: "number", value: String(cloudConfig.quarantineSeconds ?? 300) } });
  const transportSelect = el("select", {}, [
    el("option", { text: "stdio", value: "stdio" }),
    el("option", { text: "grpc", value: "grpc" }),
    el("option", { text: "http", value: "http" }),
    el("option", { text: "websocket", value: "websocket" })
  ]);
  transportSelect.value = lsConfig.transport || "stdio";
  const provisionSelect = el("select", {}, [
    el("option", { text: "Auto", value: "Auto" }),
    el("option", { text: "LocalOnly", value: "LocalOnly" }),
    el("option", { text: "ForceRemote", value: "ForceRemote" })
  ]);
  provisionSelect.value = lsConfig.provisionMode || "Auto";
  const autoStartToggle = toggle(Boolean(lsConfig.enabled ?? true));
  const nativeToggle = toggle(Boolean(lsConfig.nativeEnabled));
  const fallbackToggle = toggle(Boolean(lsConfig.providerFallback));
  const authToggle = toggle(authEnabled);
  const cloudEnabledToggle = toggle(Boolean(cloudConfig.enabled ?? true));
  const preserveAvailabilityToggle = toggle(Boolean(cloudConfig.preserveAvailabilityOnError ?? true));
  const projectHeaderToggle = toggle(Boolean(cloudConfig.sendUserProjectHeader));
  const oauthToggle = toggle(Boolean(cloudConfig.oauthEnabled));
  const zaiEnabledToggle = toggle(Boolean(zaiConfig.enabled));
  const mcpEnabledToggle = toggle(Boolean(mcpConfig.enabled));
  const mcpExposeToggle = toggle(Boolean(mcpConfig.exposeViaProxy ?? true));
  const saveConfigButton = el("button", {
    className: "primary-button",
    type: "button",
    text: "Konfigürasyonu Kaydet"
  });
  saveConfigButton.addEventListener("click", async (event) => {
    try {
      setBusy(event.currentTarget, true, "Kaydediliyor");
      const payload = {
        localApiKey: apiKeyInput.value.trim(),
        gemini: {
          baseUrl: geminiBaseUrlInput.value.trim(),
          defaultModel: geminiModelSelect.value
        },
        zai: {
          enabled: zaiEnabledToggle.input.checked,
          apiKey: zaiApiKeyInput.value.trim(),
          apiKeys: zaiApiKeyInput.value.trim() ? [zaiApiKeyInput.value.trim()] : [],
          baseUrl: zaiBaseUrlInput.value.trim(),
          defaultModel: zaiModelSelect.value
        },
        cloudCode: {
          enabled: cloudEnabledToggle.input.checked,
          userAgent: userAgentInput.value.trim(),
          sendUserProjectHeader: projectHeaderToggle.input.checked,
          preserveAvailabilityOnError: preserveAvailabilityToggle.input.checked,
          oauthEnabled: oauthToggle.input.checked,
          refreshSkewSeconds: Number(refreshSkewInput.value || cloudConfig.refreshSkewSeconds || 120),
          quarantineSeconds: Number(quarantineInput.value || cloudConfig.quarantineSeconds || 300),
          accountsDir: cloudConfig.accountsDir,
          baseUrls: baseUrlsInput.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
          oauthRedirectUri: cloudConfig.oauthRedirectUri,
          oauthScopes: cloudConfig.oauthScopes,
          oauthAuthorizationUrl: cloudConfig.oauthAuthorizationUrl,
          oauthUserInfoUrl: cloudConfig.oauthUserInfoUrl,
          tokenUrl: cloudConfig.tokenUrl
        },
        ls: {
          ...lsConfig,
          enabled: autoStartToggle.input.checked,
          nativeEnabled: nativeToggle.input.checked,
          providerFallback: fallbackToggle.input.checked,
          instanceTtlSeconds: Number(instanceTtlInput.value || lsConfig.instanceTtlSeconds || 1800),
          maxInstances: Number(maxInstancesInput.value || lsConfig.maxInstances || 3),
          requestTimeoutMs: Number(timeoutInput.value || lsConfig.requestTimeoutMs || 30000),
          transport: transportSelect.value,
          provisionMode: provisionSelect.value
        },
        mcp: {
          enabled: mcpEnabledToggle.input.checked,
          exposeViaProxy: mcpExposeToggle.input.checked,
          requestTimeoutMs: Number(mcpTimeoutInput.value || mcpConfig.requestTimeoutMs || 45000),
          servers: parseMcpServers(mcpServersInput.value)
        },
        modelAliases: parseAliases(aliasInput.value)
      };
      await onSaveConfig?.(payload);
      toast.success("Gateway config kaydedildi");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(event.currentTarget, false);
    }
  });
  const refreshButton = el("button", {
    className: "secondary-button",
    type: "button",
    text: "Veriyi Yenile"
  });
  refreshButton.addEventListener("click", async (event) => {
    try {
      setBusy(event.currentTarget, true, "Yenileniyor");
      await onRefresh?.();
    } finally {
      setBusy(event.currentTarget, false);
    }
  });

  const startButton = el("button", {
    className: "primary-button service-action",
    type: "button",
    text: "Hizmeti Başlat"
  });
  startButton.disabled = serviceRunning;
  startButton.addEventListener("click", async (event) => {
    try {
      setBusy(event.currentTarget, true, "Başlatılıyor");
      const result = await onStartService?.();
      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.success("Hizmet başlatıldı");
      }
    } finally {
      setBusy(event.currentTarget, false);
    }
  });

  const stopButton = el("button", {
    className: "secondary-button",
    type: "button",
    text: "Hizmeti Durdur"
  });
  stopButton.disabled = !serviceRunning;
  stopButton.addEventListener("click", async (event) => {
    try {
      setBusy(event.currentTarget, true, "Durduruluyor");
      const result = await onStopService?.();
      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.info("Hizmet durduruldu");
      }
    } finally {
      setBusy(event.currentTarget, false);
    }
  });

  const header = el("div", { className: "proxy-header" }, [
    el("div", { className: "proxy-title-wrap" }, [
      el("div", { className: "proxy-title" }, [
        el("span", { className: "proxy-gear", text: "⚙" }),
        el("strong", { text: "Hizmet Yapılandırması" }),
        el("span", { className: `proxy-status-badge ${statusClass(adminStatus)}`, text: statusLabel(adminStatus) })
      ]),
      el("div", { className: "proxy-status-sub" }, [
        el("span", { text: `Dinleme: ${gatewayUrl}` }),
        el("span", { text: `Port: ${proxyPort}` }),
        el("span", { text: `Auth: ${boolText(authEnabled)}` })
      ])
    ]),
    el("div", { className: "proxy-header-actions" }, [refreshButton, startButton, stopButton])
  ]);

  const strategySummary = el("div", { className: "strategy-summary-grid" });
  const presetCardGrid = el("div", { className: "strategy-card-grid" });
  const customAliasList = el("div", { className: "strategy-custom-list" });
  const customAliasEmpty = el("div", {
    className: "strategy-empty-state",
    text: "Preset dışı ek alias yok. Yeni bir route eklemek için satır açın."
  });
  const rawAliasMeta = el("span", { className: "proxy-note" });

  function collectAliasMap() {
    const aliases = {};
    for (const [alias, editor] of presetEditors.entries()) {
      const target = editor.input.value.trim();
      if (target) {
        aliases[alias] = target;
      }
    }
    for (const row of customRows) {
      const alias = row.aliasInput.value.trim();
      const target = row.targetInput.value.trim();
      if (alias && target) {
        aliases[alias] = target;
      }
    }
    return aliases;
  }

  function renderStrategySummary(aliasMap) {
    clear(strategySummary);
    const aliases = Object.keys(aliasMap);
    const geminiTargets = aliases.filter((alias) => String(aliasMap[alias]).startsWith("gemini-")).length;
    const claudeTargets = aliases.filter((alias) => String(aliasMap[alias]).startsWith("claude-")).length;
    strategySummary.append(
      highlightTile("Route sayısı", String(aliases.length)),
      highlightTile("Gemini hedefleri", String(geminiTargets)),
      highlightTile("Claude hedefleri", String(claudeTargets)),
      highlightTile("Varsayılan Gemini", geminiModelSelect.value || "unknown")
    );
  }

  function syncAliasEditor() {
    if (syncingAliasControls) {
      return;
    }
    const aliasMap = collectAliasMap();
    aliasInput.value = formatAliases(aliasMap);
    rawAliasMeta.textContent = `${Object.keys(aliasMap).length} alias etkin`;
    customAliasEmpty.hidden = customRows.some((row) => row.node.isConnected);
    renderStrategySummary(aliasMap);
  }

  function addCustomAliasRow(alias = "", target = "", { skipSync = false } = {}) {
    const aliasField = el("input", {
      attrs: {
        autocomplete: "off",
        placeholder: "örn. claude-3.7-sonnet"
      },
      value: alias
    });
    const targetField = targetInput(target);
    const removeButton = el("button", {
      className: "secondary-button strategy-row-action",
      type: "button",
      text: "Sil"
    });
    const row = {
      aliasInput: aliasField,
      targetInput: targetField.input,
      node: el("div", { className: "strategy-custom-row" }, [
        aliasField,
        targetField.node,
        removeButton
      ])
    };
    removeButton.addEventListener("click", () => {
      row.node.remove();
      const index = customRows.indexOf(row);
      if (index >= 0) {
        customRows.splice(index, 1);
      }
      syncAliasEditor();
    });
    aliasField.addEventListener("input", syncAliasEditor);
    targetField.input.addEventListener("input", syncAliasEditor);
    customRows.push(row);
    customAliasList.append(row.node);
    if (!skipSync) {
      syncAliasEditor();
    }
  }

  function applyAliasMap(aliasMap) {
    syncingAliasControls = true;
    for (const preset of MODEL_STRATEGY_PRESETS) {
      const editor = presetEditors.get(preset.alias);
      if (editor) {
        editor.input.value = aliasMap[preset.alias] || "";
      }
    }
    for (const row of customRows) {
      row.node.remove();
    }
    customRows.splice(0, customRows.length);
    for (const [alias, target] of Object.entries(aliasMap)) {
      if (!PRESET_ALIAS_SET.has(alias)) {
        addCustomAliasRow(alias, target, { skipSync: true });
      }
    }
    aliasInput.value = formatAliases(aliasMap);
    rawAliasMeta.textContent = `${Object.keys(aliasMap).length} alias etkin`;
    customAliasEmpty.hidden = customRows.some((row) => row.node.isConnected);
    renderStrategySummary(aliasMap);
    syncingAliasControls = false;
  }

  for (const preset of MODEL_STRATEGY_PRESETS) {
    const editor = targetInput(modelAliases[preset.alias] || "");
    const badge = el("span", { className: "strategy-card-badge", text: preset.alias });
    const card = el("article", { className: "strategy-card" }, [
      el("div", { className: "strategy-card-head" }, [
        el("strong", { text: preset.label }),
        badge
      ]),
      el("p", { className: "strategy-card-copy", text: preset.note }),
      el("div", { className: "strategy-card-control" }, [
        el("span", { className: "strategy-field-label", text: "Route target" }),
        editor.node
      ])
    ]);
    editor.input.addEventListener("input", syncAliasEditor);
    presetEditors.set(preset.alias, editor);
    presetCardGrid.append(card);
  }

  for (const [alias, target] of Object.entries(modelAliases)) {
    if (!PRESET_ALIAS_SET.has(alias)) {
      addCustomAliasRow(alias, target, { skipSync: true });
    }
  }
  syncAliasEditor();
  geminiModelSelect.addEventListener("change", syncAliasEditor);
  aliasInput.addEventListener("input", () => {
    try {
      applyAliasMap(parseAliases(aliasInput.value));
    } catch (error) {
      rawAliasMeta.textContent = error.message;
    }
  });

  const addAliasButton = el("button", {
    className: "secondary-button",
    type: "button",
    text: "Yeni alias satırı"
  });
  addAliasButton.addEventListener("click", () => addCustomAliasRow());

  const panel = el("section", { className: "proxy-panel" }, [
    el("div", { className: "proxy-highlight-strip" }, [
      highlightTile("Active Gemini", geminiConfig.defaultModel || "unknown"),
      highlightTile("Gemini endpoint", geminiConfig.baseUrl || "unknown"),
      highlightTile("CloudCode accounts", `${adminStatus?.providers?.cloudCode?.accountCount ?? 0}`),
      highlightTile("Fallback", boolText(lsConfig.providerFallback)),
      highlightTile("GLM", zaiEnabledToggle.input.checked ? zaiModelSelect.value : "disabled")
    ]),
    el("div", { className: "proxy-grid" }, [
      field("Dinleme Portu", portInput, "Varsayılan 8046, değişiklik için yeniden başlatma gerekir"),
      field("İstek Zaman Aşımı", timeoutInput, "Varsayılan 120s, aralık 30-7200s"),
      field("Gemini Varsayılan Model", geminiModelSelect, "Yeni istekler için temel Gemini hedefi"),
      field("Gemini Base URL", geminiBaseUrlInput, "Genellikle https://generativelanguage.googleapis.com"),
      field("Uygulama ile Otomatik Başlat", autoStartToggle.node, ""),
      field("LAN Erişimine İzin Ver", toggle(false).node, "Sadece 127.0.0.1 dinleniyor"),
      field("Yetkilendirme", authToggle.node, ""),
      field("Mod", authMode, "İstemciler Authorization: Bearer ile göndermelidir"),
      field(
        "API Anahtarı",
        el("div", { className: "inline-input-actions" }, [
          apiKeyInput,
          iconButton("✎", "Düzenle", () => apiKeyInput.focus()),
          iconButton("↻", "Yenile", () => {
            apiKeyInput.value = apiKey;
          }),
          iconButton("⧉", "Kopyala", async () => {
            await navigator.clipboard.writeText(apiKeyInput.value);
            toast.success("API anahtarı kopyalandı");
          })
        ]),
        "Not: API anahtarınızı güvenli tutun. Paylaşmayın.",
        "full"
      ),
      field(
        "Web UI Yönetici Parolası",
        el("div", { className: "inline-input-actions" }, [
          passwordInput,
          iconButton("✎", "Düzenle", () => passwordInput.focus()),
          iconButton("⧉", "Kopyala", async () => {
            await navigator.clipboard.writeText(passwordInput.value);
            toast.success("Parola kopyalandı");
          })
        ]),
        "Docker/Web dağıtımlarında ayrı bir oturum parolası kullanabilirsiniz.",
        "full"
      ),
      field(
        "User-Agent Override",
        el("div", { className: "proxy-settings-inline" }, [
          el("div", { className: "proxy-mini-settings" }, [
            settingRow("CloudCode", boolText(cloudEnabledToggle.input.checked)),
            settingRow("Project header", boolText(projectHeaderToggle.input.checked)),
            settingRow("Token server", `${lsConfig.tokenServerHost || "127.0.0.1"}:${lsConfig.tokenServerPort || 0}`)
          ]),
          el("div", { className: "proxy-footer-actions" }, [
            el("span", { className: "proxy-note", text: "Aktif" }),
            toggle(Boolean(userAgentInput.value)).node
          ])
        ]),
        "",
        "full"
      ),
      field(
        "Raw Alias JSON",
        aliasInput,
        "Gelişmiş düzenleme için JSON görünümü. Kart editörü bunu otomatik günceller.",
        "full"
      )
    ]),
    el("div", { className: "proxy-footer-actions" }, [saveConfigButton])
  ]);

  const accordions = [
    details("CLI Senkronizasyonu", "Native LS ve fallback davranışı", [
      el("div", { className: "proxy-grid" }, [
        field("Native LS", nativeToggle.node, "Yerel LS akışını aç/kapat"),
        field("Provider fallback", fallbackToggle.node, "Native başarısız olursa Gemini/Claude sağlayıcıya dön"),
        field("Transport", transportSelect, "LS ile konuşma transport tipi"),
        field("Provision mode", provisionSelect, "Binary/cert temini stratejisi"),
        field("Instance TTL (sn)", instanceTtlInput, "Boşta instance yaşam süresi"),
        field("Max instance", maxInstancesInput, "Aynı anda tutulacak LS instance sayısı")
      ]),
      el("div", { className: "proxy-placeholder" }, [
        el("strong", { text: "Claude Code, Gemini CLI ve benzer istemciler bu yerel proxy üzerinden akar." }),
        el("p", { text: "Bu panel, native LS ve fallback davranışını gateway config'e kaydeder." })
      ])
    ]),
    details("z.ai (GLM) Sağlayıcısı", zaiEnabledToggle.input.checked ? zaiModelSelect.value : "Devre dışı", [
      el("div", { className: "proxy-grid" }, [
        field("GLM enabled", zaiEnabledToggle.node, "z.ai sağlayıcısını görünür ve kullanılabilir kıl"),
        field("Varsayılan GLM model", zaiModelSelect, "Yeni route hedefleri için temel GLM modeli"),
        field("GLM base URL", zaiBaseUrlInput, "Varsayılan: https://api.z.ai/api/paas/v4", "full"),
        field(
          "GLM API key",
          el("div", { className: "inline-input-actions" }, [
            zaiApiKeyInput,
            iconButton("✎", "Düzenle", () => zaiApiKeyInput.focus()),
            iconButton("↻", "Temizle", () => {
              zaiApiKeyInput.value = "";
            })
          ]),
          "Tek anahtar girildiğinde `apiKeys` listesi buna göre yazılır.",
          "full"
        )
      ]),
      el("div", { className: "proxy-placeholder" }, [
        el("strong", { text: "GLM sağlayıcısı için kalıcı config alanları aktif." }),
        el("p", { text: `Durum: ${boolText(zaiEnabledToggle.input.checked)} · Hedef model: ${zaiModelSelect.value}` })
      ])
    ]),
    details("MCP Sunucuları (yerel proxy üzerinden)", mcpEnabledToggle.input.checked ? `${(mcpConfig.servers || []).length} kayıt` : "Devre dışı", [
      el("div", { className: "proxy-grid" }, [
        field("MCP enabled", mcpEnabledToggle.node, "Yerel MCP registry ayarlarını aç/kapat"),
        field("Proxy expose", mcpExposeToggle.node, "MCP sunucularını local gateway yüzeyine bağla"),
        field("MCP timeout (ms)", mcpTimeoutInput, "İlk handshake ve request zaman aşımı"),
        field(
          "Server registry",
          mcpServersInput,
          "JSON dizi. Örnek: [{\"id\":\"filesystem\",\"transport\":\"stdio\",\"command\":\"npx\",\"args\":[\"-y\",\"@modelcontextprotocol/server-filesystem\"]}]",
          "full"
        )
      ]),
      el("div", { className: "proxy-placeholder" }, [
        el("strong", { text: "MCP server listesi config dosyasında kalıcı tutulur." }),
        el("p", { text: `${(mcpConfig.servers || []).length} kayıt yüklendi · Proxy expose: ${boolText(mcpExposeToggle.input.checked)}` })
      ])
    ]),
    details("Hesap Rotasyonu ve Zamanlama", "CloudCode davranışı", [
      el("div", { className: "proxy-grid" }, [
        field("CloudCode enabled", cloudEnabledToggle.node, "CloudCode hesap havuzunu aktif tut"),
        field("OAuth enabled", oauthToggle.node, "Desktop OAuth giriş akışını kullan"),
        field("Project header", projectHeaderToggle.node, "x-goog-user-project benzeri header davranışı"),
        field("Availability preserve", preserveAvailabilityToggle.node, "Geçici hatalarda hesabı tamamen düşürme"),
        field("Refresh skew (sn)", refreshSkewInput, "Token expiry öncesi yenileme tamponu"),
        field("Quarantine (sn)", quarantineInput, "Hata sonrası bekleme penceresi"),
        field("CloudCode base URLs", baseUrlsInput, "Her satıra bir base URL", "full")
      ]),
      el("div", { className: "proxy-placeholder" }, [
        el("strong", { text: "Hesaplar kota ve sağlık durumuna göre seçilir." }),
        el("p", { text: "Bu panel, CloudCode token yenileme ve failover davranışını etkileyen gateway ayarlarını kaydeder." })
      ])
    ]),
    details("Gelişmiş Düşünme ve Küresel Yapılandırma", "Varsayılan model davranışı", [
      el("div", { className: "proxy-placeholder" }, [
        el("strong", { text: "Alias preset tabanlı yönlendirme editörü." }),
        el("p", { text: `Transport: ${lsConfig.transport || "stdio"} · User-Agent: ${userAgentInput.value || "antigravity"} · Provider fallback: ${boolText(lsConfig.providerFallback)}` })
      ]),
      strategySummary,
      el("div", { className: "strategy-card-grid-wrap" }, [
        presetCardGrid
      ]),
      el("div", { className: "strategy-custom-section" }, [
        el("div", { className: "proxy-field-label" }, [
          el("span", { text: "Özel alias route'ları" }),
          el("small", { text: "Preset dışındaki model adlarını burada yönetin." })
        ]),
        customAliasList,
        customAliasEmpty,
        el("div", { className: "proxy-footer-actions strategy-footer" }, [addAliasButton])
      ]),
      el("div", { className: "proxy-placeholder" }, [
        el("strong", { text: "Ham alias JSON senkronize tutulur." }),
        rawAliasMeta
      ])
    ])
  ];

  target.append(el("section", { className: "proxy-shell" }, [header, panel, ...accordions]));
}

function highlightTile(label, value) {
  return el("div", { className: "proxy-highlight-tile" }, [
    el("span", { text: label }),
    el("strong", { text: value })
  ]);
}
