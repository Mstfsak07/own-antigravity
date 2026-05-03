export function openTrafficDetailModal(options: {
  record: any;
  getNode(id: string): any;
  formatTrafficPayload(value: unknown): string;
  toast: { info(message: string): void };
}): void;
