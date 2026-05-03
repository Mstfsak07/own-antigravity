import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("desktop UI smoke", () => {
  it("ships Electron entrypoint and account manager UI", () => {
    const main = join(root, "desktop", "main.cjs");
    const html = join(root, "desktop", "index.html");
    const app = join(root, "desktop", "app.js");
    const api = join(root, "desktop", "api", "client.js");
    const accounts = join(root, "desktop", "ui", "accounts.js");

    expect(existsSync(main)).toBe(true);
    expect(existsSync(api)).toBe(true);
    expect(existsSync(accounts)).toBe(true);
    expect(readFileSync(html, "utf8")).toContain("Own Antigravity Manager");
    expect(readFileSync(html, "utf8")).toContain("Login with Google");
    expect(readFileSync(html, "utf8")).toContain("Dashboard");
    expect(readFileSync(html, "utf8")).toContain("Trafik Günlükleri");
    expect(readFileSync(html, "utf8")).toContain("Provider Status");
    expect(readFileSync(html, "utf8")).toContain("Export backup bundle");
    expect(readFileSync(api, "utf8")).toContain("/auth/accounts/import/refresh-token");
    expect(readFileSync(api, "utf8")).toContain("/auth/accounts/export");
    expect(readFileSync(accounts, "utf8")).toContain("Kota bilgisi yok");
    expect(readFileSync(app, "utf8")).not.toContain("access_token:");
  });

  it("keeps settings in renderer storage without Node access", () => {
    const html = readFileSync(join(root, "desktop", "index.html"), "utf8");
    const app = readFileSync(join(root, "desktop", "app.js"), "utf8");
    const settings = readFileSync(join(root, "desktop", "ui", "settings.js"), "utf8");
    const preferences = readFileSync(join(root, "desktop", "state", "preferences.js"), "utf8");

    expect(settings).toContain("Admin API Key");
    expect(settings).toContain("type: \"password\"");
    expect(preferences).toContain("localStorage.setItem(\"ownAg.apiKey\"");
    expect(preferences).toContain("localStorage.setItem(\"ownAg.theme\"");
    expect(app).not.toContain("require(");
  });

  it("ships account and confirmation modals", () => {
    const html = readFileSync(join(root, "desktop", "index.html"), "utf8");
    const accountEvents = readFileSync(join(root, "desktop", "controllers", "accountEvents.js"), "utf8");
    const actions = readFileSync(join(root, "desktop", "controllers", "accountActions.js"), "utf8");

    expect(html).toContain("id=\"accountModal\"");
    expect(html).toContain("id=\"confirmModal\"");
    expect(html).toContain("id=\"jsonDropzone\"");
    expect(accountEvents).toContain("accountModal\").showModal()");
    expect(actions).toContain("confirmModal");
    expect(actions).toContain("modal.showModal()");
  });

  it("exposes only a small safe preload bridge", () => {
    const preload = readFileSync(join(root, "desktop", "preload.cjs"), "utf8");

    expect(preload).toContain("contextBridge.exposeInMainWorld");
    expect(preload).toContain("gatewayUrl");
    expect(preload).toContain("openExternal");
    expect(preload).not.toContain("require(\"fs\")");
    expect(preload).not.toContain("require(\"child_process\")");
  });
});
