export type TrafficColumnKey =
  | "status"
  | "method"
  | "model"
  | "provider"
  | "account"
  | "route"
  | "tokens"
  | "duration"
  | "time";

export type TrafficColumnVisibility = Record<TrafficColumnKey, boolean>;

export type TrafficColumn = {
  key: TrafficColumnKey;
  label: string;
};

export type TrafficRow = {
  at?: string;
  method: string;
  route: string;
  provider: string;
  model: string;
  account?: string;
  statusCode: number;
  durationMs?: number;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
  requestBody?: unknown;
  responseBody?: unknown;
};

export type TrafficMetrics = {
  recentRequests?: TrafficRow[];
  recentErrors?: Array<{
    at?: string;
    route?: string;
    statusCode?: number;
  }>;
};

export const TRAFFIC_COLUMNS: TrafficColumn[];

export function defaultTrafficColumns(): TrafficColumnVisibility;
export function mergeTrafficColumns(snapshot?: unknown): TrafficColumnVisibility;
export function normalizeTrafficRecord(
  record: { requestBody?: unknown; responseBody?: unknown } | undefined,
  formatTrafficPayload: (value: unknown) => string
): {
  system: string;
  prompt: string;
  tools: string;
  thinking: string;
  responseSummary: string;
};
export function selectTrafficRows(metrics?: TrafficMetrics): TrafficRow[];
export function selectTrafficView(
  metrics?: TrafficMetrics,
  options?: {
    visibleColumns?: Partial<TrafficColumnVisibility>;
    filter?: string;
    statusFilter?: string;
    minTokens?: number;
    startAt?: string;
    endAt?: string;
  }
): {
  rows: TrafficRow[];
  filteredRows: TrafficRow[];
  visibleColumns: TrafficColumnVisibility;
  visible: TrafficColumn[];
  total: number;
  failed: number;
  success: number;
};
