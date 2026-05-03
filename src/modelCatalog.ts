import type { ProxyConfig } from "./types.js";
import { stableGeminiModels } from "./geminiModels.js";

export function modelCatalog(config: ProxyConfig) {
  const canonical: Array<{
    id: string;
    object: string;
    owned_by: string;
    label?: string;
  }> = [
    ...stableGeminiModels().map((model) => ({
      id: model.id,
      object: "model",
      owned_by: "google",
      label: model.label
    })),
    {
      id: config.gemini.defaultModel,
      object: "model",
      owned_by: "google"
    },
    {
      id: "gemini-2.5-flash",
      object: "model",
      owned_by: "google"
    },
    {
      id: "claude-sonnet-4-5",
      object: "model",
      owned_by: "anthropic"
    },
    {
      id: "claude-haiku-4-5",
      object: "model",
      owned_by: "anthropic"
    },
    {
      id: "claude-opus-4-7",
      object: "model",
      owned_by: "anthropic"
    },
    {
      id: config.zai.defaultModel,
      object: "model",
      owned_by: "zai"
    },
    {
      id: "glm-4.6",
      object: "model",
      owned_by: "zai"
    },
    {
      id: "glm-4.5-air",
      object: "model",
      owned_by: "zai"
    }
  ];

  const aliases = Object.keys(config.modelAliases).map((id) => ({
    id,
    object: "model",
    owned_by:
      id.startsWith("claude")
        ? "anthropic"
        : id.startsWith("glm")
          ? "zai"
          : "google",
    aliasTarget: config.modelAliases[id],
    fallbackInjected: true
  }));

  const byId = new Map([...canonical, ...aliases].map((model) => [model.id, model]));
  return [...byId.values()];
}

export function geminiModelList(config: ProxyConfig) {
  return {
    models: modelCatalog(config)
      .filter((model) => model.owned_by === "google")
      .map((model) => ({
        name: `models/${model.id}`,
        version: "001",
        displayName: ("label" in model && model.label) ? model.label : model.id,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"]
      }))
  };
}
