// the tray's surface, one implementation per OS
export type TrayItem = { label?: string; enabled?: boolean; separator?: boolean; onClick?: () => void };

export interface Tray {
  setMenu(items: TrayItem[]): void;
  setTooltip(text: string): void;
  setIcon(path: string): void;
  // a left click: the menu when unset
  onClick(f: () => void): void;
  quit(): void;
}
