import { el } from "./dom.js";
import { sanitize } from "../api/client.js";

export function createToastSystem(target) {
  return {
    show(message, type = "info") {
      const toast = el("div", { className: `toast ${type}`, text: sanitize(message) });
      target.append(toast);
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(8px)";
        setTimeout(() => toast.remove(), 180);
      }, 3200);
    },
    success(message) {
      this.show(message, "success");
    },
    error(message) {
      this.show(message, "error");
    },
    info(message) {
      this.show(message, "info");
    }
  };
}
