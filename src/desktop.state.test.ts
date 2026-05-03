import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDesktopPreferences,
  createInitialRendererState,
  snapshotDesktopPreferences
} from "../desktop/state/preferences.js";
import {
  accountFingerprint,
  applyTrafficView,
  getTrafficFilterState,
  removeTrafficView,
  saveTrafficView,
  trafficColumnEntries,
  trafficViewMeta
} from "../desktop/ui/trafficControls.js";

const storage = new Map<string, string>();

function setLocalStorageMock() {
  vi.stubGlobal("localStorage", {
    getItem(key: string) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key: string, value: string) {
      storage.set(key, String(value));
    }
  });
}

afterEach(() => {
  storage.clear();
  vi.unstubAllGlobals();
});

describe("desktop state helpers", () => {
  it("creates initial renderer state from local storage", () => {
    storage.set("ownAg.apiKey", "abc");
    storage.set("ownAg.theme", "dark");
    storage.set("ownAg.lang", "en");
    storage.set("ownAg.trafficViews", JSON.stringify([{ name: "Errors" }]));
    storage.set("ownAg.trafficColumns", JSON.stringify({ account: false }));
    setLocalStorageMock();

    const state = createInitialRendererState();
    expect(state.apiKey).toBe("abc");
    expect(state.theme).toBe("dark");
    expect(state.language).toBe("en");
    expect(state.trafficViews).toHaveLength(1);
    expect(state.trafficColumns.account).toBe(false);
    expect(state.trafficColumns.status).toBe(true);
  });

  it("snapshots and reapplies desktop preferences", () => {
    setLocalStorageMock();
    const state = createInitialRendererState();
    state.apiKey = "seed";
    state.theme = "light";
    state.language = "tr";
    state.trafficViews = [{ name: "All" }];
    state.trafficColumns = { status: true, account: false };

    const snapshot = snapshotDesktopPreferences(state);
    const nextState = createInitialRendererState();
    const actions = {
      setTheme: vi.fn((theme: string) => {
        nextState.theme = theme;
      }),
      setLanguage: vi.fn((language: string) => {
        nextState.language = language;
      })
    };

    applyDesktopPreferences(nextState, snapshot, actions);

    expect(nextState.apiKey).toBe("seed");
    expect(nextState.trafficViews).toEqual([{ name: "All" }]);
    expect(nextState.trafficColumns.account).toBe(false);
    expect(actions.setTheme).toHaveBeenCalledWith("light");
    expect(actions.setLanguage).toHaveBeenCalledWith("tr");
  });
});

describe("desktop traffic control helpers", () => {
  it("reads, writes, and formats traffic views", () => {
    const nodes: Record<string, { value: any }> = {
      trafficFilter: { value: "claude" },
      trafficStatus: { value: "error" },
      trafficMinTokens: { value: "42" },
      trafficStart: { value: "2026-04-27T01:00" },
      trafficEnd: { value: "2026-04-27T02:00" },
      globalSearch: { value: "" }
    };
    const getElement = (id: string) => nodes[id];

    expect(getTrafficFilterState(getElement)).toMatchObject({
      filter: "claude",
      statusFilter: "error",
      minTokens: 42
    });

    applyTrafficView(getElement, {
      filter: "gemini",
      statusFilter: "success",
      minTokens: 12,
      startAt: "2026-04-27T03:00",
      endAt: "2026-04-27T04:00"
    });
    expect(nodes.trafficFilter.value).toBe("gemini");
    expect(nodes.trafficStatus.value).toBe("success");

    const saved = saveTrafficView([], { filter: "gemini", statusFilter: "all", minTokens: 0 }, "Default");
    expect(saved).toEqual([{ name: "Default", filter: "gemini", statusFilter: "all", minTokens: 0 }]);
    expect(removeTrafficView(saved || [], "Default")).toEqual([]);
    expect(trafficViewMeta({ filter: "gemini", statusFilter: "error", minTokens: 50 })).toContain("durum:error");
  });

  it("generates stable column and account metadata", () => {
    expect(trafficColumnEntries()).toContainEqual(["status", "Durum"]);
    expect(accountFingerprint([
      { accountId: "b", active: true, updatedAt: "2", quota: [] },
      { accountId: "a", active: false, updatedAt: "1", quota: [{}, {}] }
    ])).toContain("\"id\":\"a\"");
  });
});
