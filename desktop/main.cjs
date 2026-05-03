const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { appendFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let gatewayServer;
let gatewayUrl;
let gatewayOwned = false;
let isQuitting = false;
let mainWindow;
let gatewayConfig;

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

function log(message, error) {
  try {
    const dir = app.getPath("userData");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "desktop.log"),
      `${new Date().toISOString()} ${message}${error ? ` ${error.stack || error.message || String(error)}` : ""}\n`,
      "utf8"
    );
  } catch {}
}

function serverUrl() {
  return gatewayUrl || `http://${process.env.OWN_AG_HOST || "127.0.0.1"}:${process.env.OWN_AG_PORT || "8046"}`;
}

async function existingGatewayIsReachable(url) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startGateway() {
  if (gatewayServer) {
    gatewayOwned = true;
    return { running: true, owned: true, url: serverUrl() };
  }
  process.env.OWN_AG_HOST = process.env.OWN_AG_HOST || "127.0.0.1";
  const appRoot = path.join(__dirname, "..");
  const [{ loadConfig }, { buildServer }] = await Promise.all([
    import(pathToFileURL(path.join(appRoot, "dist", "config.js")).href),
    import(pathToFileURL(path.join(appRoot, "dist", "server.js")).href)
  ]);
  const config = loadConfig();
  gatewayConfig = config;
  const configuredUrl = `http://${config.host}:${config.port}`;
  if (await existingGatewayIsReachable(configuredUrl)) {
    gatewayUrl = configuredUrl;
    gatewayOwned = false;
    log(`using existing gateway ${gatewayUrl}`);
    return { running: true, owned: false, url: gatewayUrl };
  }
  gatewayServer = buildServer(config);
  try {
    await gatewayServer.listen({ host: config.host, port: config.port });
  } catch (error) {
    gatewayServer = undefined;
    if (error && error.code === "EADDRINUSE" && await existingGatewayIsReachable(configuredUrl)) {
      gatewayUrl = configuredUrl;
      gatewayOwned = false;
      log(`using existing gateway after EADDRINUSE ${gatewayUrl}`);
      return { running: true, owned: false, url: gatewayUrl };
    }
    throw error;
  }
  gatewayUrl = configuredUrl;
  gatewayOwned = true;
  log(`gateway started ${gatewayUrl}`);
  return { running: true, owned: true, url: gatewayUrl };
}

async function stopGateway() {
  if (!gatewayServer) {
    return {
      running: false,
      owned: gatewayOwned,
      url: gatewayUrl || serverUrl()
    };
  }
  const server = gatewayServer;
  gatewayServer = undefined;
  gatewayUrl = undefined;
  gatewayOwned = false;
  await server.close();
  log("gateway stopped");
  return {
    running: false,
    owned: false,
    url: serverUrl()
  };
}

function gatewayStatus() {
  return {
    running: Boolean(gatewayServer || gatewayUrl),
    owned: gatewayOwned,
    url: gatewayUrl || serverUrl()
  };
}

async function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  let gatewayStartError;
  try {
    await startGateway();
  } catch (error) {
    gatewayStartError = error;
    log("gateway start failed", error);
  }
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Own Antigravity Manager",
    backgroundColor: "#101414",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.once("closed", () => {
    mainWindow = undefined;
  });
  await mainWindow.loadFile(path.join(__dirname, "index.html"));
  if (gatewayStartError) {
    dialog.showErrorBox(
      "Own Antigravity gateway failed",
      `The desktop window opened, but the local gateway could not start.\n\n${gatewayStartError.message || String(gatewayStartError)}\n\nLog: ${join(app.getPath("userData"), "desktop.log")}`
    );
  }
}

ipcMain.handle("gateway:url", () => serverUrl());
ipcMain.handle("gateway:status", () => gatewayStatus());
ipcMain.handle("gateway:start", async () => startGateway());
ipcMain.handle("gateway:stop", async () => {
  if (!gatewayOwned) {
    return {
      running: Boolean(gatewayServer || gatewayUrl),
      owned: false,
      url: gatewayUrl || serverUrl(),
      error: "Gateway is not owned by this desktop instance"
    };
  }
  return stopGateway();
});
ipcMain.handle("gateway:config", async () => {
  if (!gatewayConfig) {
    const appRoot = path.join(__dirname, "..");
    const { loadConfig } = await import(pathToFileURL(path.join(appRoot, "dist", "config.js")).href);
    gatewayConfig = loadConfig();
  }
  return {
    host: gatewayConfig.host,
    port: gatewayConfig.port,
    localApiKey: gatewayConfig.localApiKey || "",
    dataDir: gatewayConfig.dataDir,
    modelAliases: gatewayConfig.modelAliases,
    ls: {
      enabled: gatewayConfig.ls.enabled,
      nativeEnabled: gatewayConfig.ls.nativeEnabled,
      providerFallback: gatewayConfig.ls.providerFallback,
      instanceTtlSeconds: gatewayConfig.ls.instanceTtlSeconds,
      maxInstances: gatewayConfig.ls.maxInstances,
      requestTimeoutMs: gatewayConfig.ls.requestTimeoutMs,
      transport: gatewayConfig.ls.transport,
      provisionMode: gatewayConfig.ls.provisionMode,
      tokenServerHost: gatewayConfig.ls.tokenServerHost,
      tokenServerPort: gatewayConfig.ls.tokenServerPort,
      endpoint: gatewayConfig.ls.endpoint,
      initMethod: gatewayConfig.ls.initMethod,
      requestMethod: gatewayConfig.ls.requestMethod,
      streamMethod: gatewayConfig.ls.streamMethod
    },
    cloudCode: {
      enabled: gatewayConfig.cloudCode.enabled,
      userAgent: gatewayConfig.cloudCode.userAgent,
      sendUserProjectHeader: gatewayConfig.cloudCode.sendUserProjectHeader,
      preserveAvailabilityOnError: gatewayConfig.cloudCode.preserveAvailabilityOnError,
      refreshSkewSeconds: gatewayConfig.cloudCode.refreshSkewSeconds,
      quarantineSeconds: gatewayConfig.cloudCode.quarantineSeconds,
      oauthEnabled: gatewayConfig.cloudCode.oauthEnabled,
      accountsDir: gatewayConfig.cloudCode.accountsDir,
      baseUrls: gatewayConfig.cloudCode.baseUrls,
      oauthRedirectUri: gatewayConfig.cloudCode.oauthRedirectUri,
      oauthScopes: gatewayConfig.cloudCode.oauthScopes,
      oauthAuthorizationUrl: gatewayConfig.cloudCode.oauthAuthorizationUrl,
      oauthUserInfoUrl: gatewayConfig.cloudCode.oauthUserInfoUrl,
      tokenUrl: gatewayConfig.cloudCode.tokenUrl
    },
    gemini: {
      baseUrl: gatewayConfig.gemini.baseUrl,
      defaultModel: gatewayConfig.gemini.defaultModel
    },
    anthropic: {
      baseUrl: gatewayConfig.anthropic.baseUrl,
      version: gatewayConfig.anthropic.version
    },
    zai: {
      enabled: gatewayConfig.zai.enabled,
      baseUrl: gatewayConfig.zai.baseUrl,
      defaultModel: gatewayConfig.zai.defaultModel,
      apiKey: gatewayConfig.zai.apiKey || "",
      apiKeys: gatewayConfig.zai.apiKeys
    },
    mcp: {
      enabled: gatewayConfig.mcp.enabled,
      exposeViaProxy: gatewayConfig.mcp.exposeViaProxy,
      requestTimeoutMs: gatewayConfig.mcp.requestTimeoutMs,
      servers: gatewayConfig.mcp.servers
    }
  };
});
ipcMain.handle("gateway:config:import", async (_event, incoming) => {
  const appRoot = path.join(__dirname, "..");
  const { loadConfig, writeConfigPatch } = await import(pathToFileURL(path.join(appRoot, "dist", "config.js")).href);
  const patch = incoming && typeof incoming === "object" ? incoming : {};
  writeConfigPatch({
    host: patch.host,
    port: patch.port,
    localApiKey: patch.localApiKey,
    dataDir: patch.dataDir,
    modelAliases: patch.modelAliases,
    ls: patch.ls,
    cloudCode: patch.cloudCode,
    gemini: patch.gemini,
    anthropic: patch.anthropic,
    zai: patch.zai,
    mcp: patch.mcp
  });
  gatewayConfig = loadConfig();
  return { ok: true };
});
ipcMain.handle("open:external", async (_event, url) => {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported URL");
  }
  await shell.openExternal(url);
});

app.whenReady().then(createWindow).catch((error) => {
  log("window creation failed", error);
  dialog.showErrorBox("Own Antigravity failed to open", error.message || String(error));
});

app.on("second-instance", () => {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async (event) => {
  if (!gatewayServer || isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  const server = gatewayServer;
  gatewayServer = undefined;
  try {
    await server.close();
  } catch (error) {
    log("gateway close failed", error);
  }
  app.quit();
});
