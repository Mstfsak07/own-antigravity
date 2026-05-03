export function createInitialRendererState(): any;
export function persistApiKey(state: any): void;
export function persistTheme(theme: string): void;
export function persistLanguage(language: string): void;
export function persistTrafficViews(state: any): void;
export function persistTrafficColumns(state: any): void;
export function snapshotDesktopPreferences(state: any): {
  apiKey: string;
  theme: string;
  language: string;
  trafficViews: any[];
  trafficColumns: Record<string, boolean>;
};
export function applyDesktopPreferences(
  state: any,
  snapshot: any,
  actions: { setTheme(theme: string): void; setLanguage(language: string): void; }
): void;
