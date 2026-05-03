export function createAccountActionsController(options: any): {
  confirmRemove(account: any): Promise<boolean>;
  exportOneAccount(account: any): void;
  runExport(): Promise<void>;
  importManual(): Promise<void>;
  importJson(): Promise<void>;
  isAppBackupBundle(data: unknown): boolean;
};
