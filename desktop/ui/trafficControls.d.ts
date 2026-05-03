export function getTrafficFilterState(getElement: (id: string) => any): {
  filter: string;
  statusFilter: string;
  minTokens: number;
  startAt: string;
  endAt: string;
};
export function applyTrafficView(getElement: (id: string) => any, view: any): void;
export function saveTrafficView(views: any[], current: any, name: string): any[] | undefined;
export function removeTrafficView(views: any[], name: string): any[];
export function trafficViewMeta(view: any): string;
export function accountFingerprint(accounts?: any[]): string;
export function trafficColumnEntries(): Array<[string, string]>;
