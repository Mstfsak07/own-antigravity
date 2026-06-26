import { describe, expect, it } from "vitest";
import { canonicalGeminiModel, geminiCompatibilityCandidates, stableGeminiModels } from "./geminiModels.js";
import { geminiModelList } from "./modelCatalog.js";
import { baseTestConfig } from "./testConfig.js";

describe("gemini model helpers", () => {
  it("normalizes latest-style aliases to stable Gemini ids", () => {
    expect(canonicalGeminiModel("models/gemini-2.5-flash-latest")).toBe("gemini-3-flash");
    expect(canonicalGeminiModel("models/gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(canonicalGeminiModel("gemini-3.1-pro-high")).toBe("gemini-3.1-pro-high");
    expect(canonicalGeminiModel("gemini-3-pro")).toBe("gemini-3.1-pro-high");
    expect(canonicalGeminiModel("gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-high");
    expect(canonicalGeminiModel("gemini-3-flash-preview")).toBe("gemini-3-flash");
  });

  it("returns compatibility candidates for cloud code quota matching", () => {
    expect(geminiCompatibilityCandidates("gemini-2.5-flash-latest")).toEqual(
      expect.arrayContaining(["gemini-2.5-flash", "gemini-3-flash", "gemini-3.1-flash-lite"])
    );
    expect(geminiCompatibilityCandidates("gemini-3.1-pro-preview")).toEqual(
      expect.arrayContaining(["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro"])
    );
  });

  it("publishes current stable Gemini models in the catalog", () => {
    const config = baseTestConfig();
    const models = geminiModelList(config).models.map((model) => model.name);

    expect(stableGeminiModels()).toHaveLength(11);
    expect(models).toEqual(
      expect.arrayContaining([
        "models/gemini-3.1-pro-high",
        "models/gemini-3-flash",
        "models/gemini-2.5-pro",
        "models/gemini-2.5-flash",
        "models/gemini-2.5-flash-lite",
        "models/gemini-2.5-flash-image"
      ])
    );
  });
});
