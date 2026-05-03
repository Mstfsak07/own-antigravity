export const $ = (id) => document.getElementById(id);

export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type) node.type = options.type;
  if (options.value !== undefined) node.value = options.value;
  if (options.title) node.title = options.title;
  if (options.ariaLabel) node.setAttribute("aria-label", options.ariaLabel);
  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) {
      node.dataset[key] = value;
    }
  }
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

export function clear(node) {
  node.textContent = "";
}

export function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = String(value ?? "unknown");
}

export function renderSkeleton(target, count, className = "metric-card") {
  clear(target);
  for (let index = 0; index < count; index += 1) {
    target.append(el("div", { className: `${className} skeleton` }));
  }
}

export function setBusy(button, busy, busyText = "Working") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent || "";
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent || "";
    button.disabled = false;
  }
}
