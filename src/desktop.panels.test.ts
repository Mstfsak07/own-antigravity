import { describe, expect, it, vi } from "vitest";
import { renderTrafficColumnsPanel, renderTrafficViewsPanel } from "../desktop/ui/trafficPanels.js";

function createTarget() {
  return {
    innerHTML: "",
    children: [] as any[],
    firstElementChild: undefined as any,
    append(node: any) {
      this.children.push(node);
      this.firstElementChild ||= node;
    }
  };
}

function createElement(tag: string) {
  return {
    tagName: tag,
    type: "",
    className: "",
    textContent: "",
    checked: false,
    children: [] as any[],
    listeners: {} as Record<string, Function>,
    append(...nodes: any[]) {
      this.children.push(...nodes);
    },
    addEventListener(name: string, cb: Function) {
      this.listeners[name] = cb;
    }
  };
}

describe("desktop traffic panels", () => {
  it("renders empty and populated traffic views", () => {
    const originalDocument = globalThis.document;
    vi.stubGlobal("document", { createElement });

    const emptyTarget = createTarget();
    renderTrafficViewsPanel(emptyTarget as any, []);
    expect(emptyTarget.firstElementChild.className).toBe("saved-view-empty");

    const apply = vi.fn();
    const remove = vi.fn();
    const target = createTarget();
    renderTrafficViewsPanel(target as any, [{ name: "Errors", filter: "claude", statusFilter: "error", minTokens: 10 }], {
      onApply: apply,
      onRemove: remove
    });
    const row = target.children[0];
    const [title, , removeButton] = row.children;
    title.listeners.click();
    removeButton.listeners.click();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ name: "Errors" }));
    expect(remove).toHaveBeenCalledWith("Errors");

    vi.stubGlobal("document", originalDocument);
  });

  it("renders traffic column toggles", () => {
    const originalDocument = globalThis.document;
    vi.stubGlobal("document", { createElement });

    const onToggle = vi.fn();
    const target = createTarget();
    renderTrafficColumnsPanel(target as any, { status: true, model: false }, { onToggle });

    expect(target.children.length).toBeGreaterThan(0);
    const first = target.children[0];
    const input = first.children[0];
    input.listeners.change();
    expect(onToggle).toHaveBeenCalledWith("status", true);

    vi.stubGlobal("document", originalDocument);
  });
});
