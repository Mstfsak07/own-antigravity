export function renderTrafficViewsPanel(
  target: HTMLElement | null | undefined,
  views: any[],
  handlers?: {
    onApply?(view: any): void;
    onRemove?(name: string): void;
  }
): void;

export function renderTrafficColumnsPanel(
  target: HTMLElement | null | undefined,
  visibleColumns: Record<string, boolean>,
  handlers?: {
    onToggle?(key: string, checked: boolean): void;
  }
): void;
