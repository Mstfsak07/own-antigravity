export function modelQuotaEntries(accounts?: Array<any>): Array<{
  name: string;
  displayName?: string;
  provider: string;
  bestPercent: number;
  bestResetTime?: string;
  bestAccount?: string;
  accounts: number;
}>;

export function accountHealthTone(account: any): string;
export function accountHealthLabel(account: any): string;
export function accountQuotaLabel(account: any): string;
export function accountLowQuota(account: any): { name: string; percentage: number } | undefined;
export function collectWarnings(accounts?: Array<any>, summaryWarnings?: string[]): string[];

export function dashboardOverviewView(input: {
  health: any;
  summary: any;
  metrics: any;
}): {
  active: string;
  cards: Array<[string, string, string | number]>;
};

export function providerBadgeView(health: any): Array<[string, boolean]>;

export function activityView(metrics: any): Array<{
  text: string;
  tone: string;
  badge: string;
}>;

export function auditTrailView(metrics: any): Array<any>;

export function healthSnapshotView(input: {
  health: any;
  summary: any;
  accounts: any[];
  accountHealth: any;
  adminStatus: any;
}): {
  warnings: string[];
  providerCards: Array<[string, string, string, string]>;
  problemAccounts: Array<{
    label: string;
    source: string;
    quotaLabel: string;
    tone: string;
    healthLabel: string;
    nextRetryAt?: string;
  }>;
};
