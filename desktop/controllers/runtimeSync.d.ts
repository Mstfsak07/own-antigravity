export function createRuntimeSyncController(options: any): {
  refreshTraffic(): Promise<void>;
  refreshData(): Promise<void>;
  startTrafficPolling(): void;
  stopTrafficPolling(): void;
};
