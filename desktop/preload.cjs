const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ownAg", {
  gatewayUrl: () => ipcRenderer.invoke("gateway:url"),
  gatewayStatus: () => ipcRenderer.invoke("gateway:status"),
  gatewayStart: () => ipcRenderer.invoke("gateway:start"),
  gatewayStop: () => ipcRenderer.invoke("gateway:stop"),
  gatewayConfig: () => ipcRenderer.invoke("gateway:config"),
  gatewayConfigImport: (config) => ipcRenderer.invoke("gateway:config:import", config),
  openExternal: (url) => ipcRenderer.invoke("open:external", url)
});
