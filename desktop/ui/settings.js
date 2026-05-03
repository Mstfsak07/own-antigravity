import { clear, el } from "./dom.js";

export function renderSettings({ gatewayUrl, apiKey, theme, language, geminiConfig, cloudCodeConfig, onSave }) {
  const target = document.getElementById("settingsRoot");
  clear(target);

  const gatewayInput = el("input", { attrs: { readonly: "", value: gatewayUrl } });
  const keyInput = el("input", { attrs: { type: "password", autocomplete: "off", value: apiKey } });
  const themeSelect = el("select", {}, [
    el("option", { text: "Dark", value: "dark" }),
    el("option", { text: "Light", value: "light" })
  ]);
  themeSelect.value = theme;
  const languageSelect = el("select", {}, [
    el("option", { text: "English", value: "en" }),
    el("option", { text: "Turkce", value: "tr" })
  ]);
  languageSelect.value = language;
  const saveButton = el("button", { text: "Save settings", type: "button" });

  saveButton.addEventListener("click", () => {
    onSave({
      apiKey: keyInput.value,
      theme: themeSelect.value,
      language: languageSelect.value
    });
  });

  target.append(el("div", { className: "settings-grid" }, [
    el("section", { className: "card settings-form" }, [
      el("div", { className: "settings-section-title" }, [
        el("strong", { text: "Desktop Preferences" }),
        el("span", { text: "Renderer-side values saved in local storage" })
      ]),
      field("Gateway URL", gatewayInput),
      field("Admin API Key", keyInput),
      field("Theme", themeSelect),
      field("Language", languageSelect),
      saveButton
    ]),
    el("aside", { className: "card settings-sidecard" }, [
      el("div", { className: "settings-section-title" }, [
        el("strong", { text: "Provider Defaults" }),
        el("span", { text: "Read-only snapshot from the local gateway" })
      ]),
      metaStat("Gemini model", geminiConfig?.defaultModel || "unknown"),
      metaStat("Gemini base URL", geminiConfig?.baseUrl || "unknown"),
      metaStat("CloudCode OAuth", cloudCodeConfig?.oauthEnabled ? "enabled" : "disabled"),
      metaStat("Project header", cloudCodeConfig?.sendUserProjectHeader ? "enabled" : "disabled")
    ])
  ]));
}

function field(label, input) {
  return el("label", { className: "field" }, [
    el("span", { text: label }),
    input
  ]);
}

function metaStat(label, value) {
  return el("div", { className: "settings-meta-row" }, [
    el("span", { text: label }),
    el("strong", { text: value })
  ]);
}
