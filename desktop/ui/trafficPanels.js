import { trafficColumnEntries, trafficViewMeta } from "./trafficControls.js";

export function renderTrafficViewsPanel(target, views, handlers = {}) {
  if (!target) return;
  target.innerHTML = "";
  const list = views || [];
  if (!list.length) {
    target.append(document.createElement("div"));
    target.firstElementChild.className = "saved-view-empty";
    target.firstElementChild.textContent = "Henüz kayıtlı görünüm yok.";
    return;
  }

  for (const view of list) {
    const row = document.createElement("div");
    row.className = "saved-view-item";

    const title = document.createElement("button");
    title.type = "button";
    title.className = "saved-view-apply";
    title.textContent = view.name;
    title.addEventListener("click", () => handlers.onApply?.(view));

    const meta = document.createElement("span");
    meta.className = "saved-view-meta";
    meta.textContent = trafficViewMeta(view);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "saved-view-remove";
    remove.textContent = "Sil";
    remove.addEventListener("click", () => handlers.onRemove?.(view.name));

    row.append(title, meta, remove);
    target.append(row);
  }
}

export function renderTrafficColumnsPanel(target, visibleColumns, handlers = {}) {
  if (!target) return;
  target.innerHTML = "";

  for (const [key, label] of trafficColumnEntries()) {
    const item = document.createElement("label");
    item.className = "traffic-column-toggle";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = visibleColumns?.[key] !== false;
    input.addEventListener("change", () => handlers.onToggle?.(key, input.checked));

    const text = document.createElement("span");
    text.textContent = label;

    item.append(input, text);
    target.append(item);
  }
}
