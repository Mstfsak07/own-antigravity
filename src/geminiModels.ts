const STABLE_GEMINI_MODELS = [
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro High", family: "pro" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro Low", family: "pro" },
  { id: "gemini-3-flash", label: "Gemini 3 Flash", family: "flash" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", family: "flash-lite" },
  { id: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image", family: "flash-image" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", family: "pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", family: "flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", family: "flash-lite" },
  { id: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", family: "flash-image" },
  { id: "gemini-2.0-flash-001", label: "Gemini 2.0 Flash", family: "flash" },
  { id: "gemini-2.0-flash-lite-001", label: "Gemini 2.0 Flash-Lite", family: "flash-lite" }
] as const;

const GEMINI_COMPATIBILITY_MAP: Record<string, string[]> = {
  "gemini-latest": ["gemini-3.1-pro-high"],
  "gemini-pro-latest": ["gemini-3.1-pro-high"],
  "gemini-3-pro-preview": ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro"],
  "gemini-3.1-pro-preview": ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro"],
  "gemini-3.1-pro-preview-customtools": ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro"],
  "gemini-3-flash-preview": ["gemini-3-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash"],
  "gemini-3.1-flash-lite-preview": ["gemini-3.1-flash-lite", "gemini-3-flash", "gemini-2.5-flash-lite"],
  "gemini-flash-latest": ["gemini-3-flash"],
  "gemini-2.5-pro-latest": ["gemini-3.1-pro-high"],
  "gemini-2.5-flash-latest": ["gemini-3-flash"],
  "gemini-2.5-flash-lite-latest": ["gemini-2.5-flash-lite"],
  "gemini-2.5-flash-image-latest": ["gemini-2.5-flash-image"],
  "gemini-2.5-pro": ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro"],
  "gemini-2.5-flash": [
    "gemini-3-flash",
    "gemini-3-flash-agent",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-thinking",
    "gemini-2.0-flash",
    "gemini-2.0-flash-001"
  ],
  "gemini-2.5-flash-lite": [
    "gemini-3.1-flash-lite",
    "gemini-3-flash",
    "gemini-3-flash-agent",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-thinking",
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash-lite-001"
  ],
  "gemini-2.5-flash-image": ["gemini-3.1-flash-image", "gemini-2.5-flash-image"],
  "gemini-3.1-pro-high": ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro"],
  "gemini-3.1-pro-low": ["gemini-3.1-pro-low", "gemini-3.1-pro-high", "gemini-2.5-pro"],
  "gemini-3-pro": ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro"],
  "gemini-3.1-flash-lite": [
    "gemini-3.1-flash-lite",
    "gemini-3-flash",
    "gemini-3-flash-agent",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-thinking",
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash-lite-001"
  ],
  "gemini-3.1-flash-image": ["gemini-3.1-flash-image", "gemini-2.5-flash-image"],
  "gemini-3-flash": [
    "gemini-3-flash",
    "gemini-3-flash-agent",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-thinking"
  ],
  "gemini-3-flash-agent": [
    "gemini-3-flash-agent",
    "gemini-3-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-thinking"
  ],
  "gemini-2.0-flash": ["gemini-2.0-flash", "gemini-2.0-flash-001", "gemini-2.5-flash"],
  "gemini-2.0-flash-lite": ["gemini-2.0-flash-lite", "gemini-2.0-flash-lite-001", "gemini-2.5-flash-lite"]
};

const GEMINI_CANONICAL_OVERRIDES: Record<string, string> = {
  "gemini-latest": "gemini-3.1-pro-high",
  "gemini-pro-latest": "gemini-3.1-pro-high",
  "gemini-3-pro-preview": "gemini-3.1-pro-high",
  "gemini-3.1-pro-preview": "gemini-3.1-pro-high",
  "gemini-3.1-pro-preview-customtools": "gemini-3.1-pro-high",
  "gemini-3-flash-preview": "gemini-3-flash",
  "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite",
  "gemini-flash-latest": "gemini-3-flash",
  "gemini-2.5-pro-latest": "gemini-3.1-pro-high",
  "gemini-2.5-flash-latest": "gemini-3-flash",
  "gemini-2.5-flash-lite-latest": "gemini-2.5-flash-lite",
  "gemini-2.5-flash-image-latest": "gemini-2.5-flash-image",
  "gemini-3.1-pro-high": "gemini-3.1-pro-high",
  "gemini-3.1-pro-low": "gemini-3.1-pro-low",
  "gemini-3-pro": "gemini-3.1-pro-high",
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite",
  "gemini-3.1-flash-image": "gemini-3.1-flash-image",
  "gemini-3-flash": "gemini-3-flash",
  "gemini-3-flash-agent": "gemini-3-flash-agent",
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-2.5-flash": "gemini-2.5-flash",
  "gemini-2.0-flash": "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite": "gemini-2.0-flash-lite-001"
};

export function stableGeminiModels() {
  return STABLE_GEMINI_MODELS.map((model) => ({ ...model }));
}

export function normalizeGeminiModelName(model: string): string {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");
}

export function canonicalGeminiModel(model: string): string {
  const normalized = normalizeGeminiModelName(model);
  return GEMINI_CANONICAL_OVERRIDES[normalized] ?? normalized;
}

export function geminiCompatibilityCandidates(model: string): string[] {
  const normalized = normalizeGeminiModelName(model);
  const canonical = canonicalGeminiModel(normalized);
  const entries = [
    normalized,
    canonical,
    ...(GEMINI_COMPATIBILITY_MAP[normalized] ?? []),
    ...(GEMINI_COMPATIBILITY_MAP[canonical] ?? [])
  ];
  return [...new Set(entries.map(normalizeGeminiModelName).filter(Boolean))];
}
