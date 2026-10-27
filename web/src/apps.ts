// each app's module, set up on first use; one bundle holds them all, no fetch

// the modules by name, for an app's call to be typed
export interface AppMods {
  status: typeof import('./apps/status.ts');
  terminal: typeof import('./apps/terminal.ts');
  files: typeof import('./apps/files.ts');
  code: typeof import('./apps/code.ts');
  agents: typeof import('./apps/agents.ts');
  editor: typeof import('./apps/editor.ts');
}
export type AppName = keyof AppMods;

const APPS: { [K in AppName]: () => Promise<AppMods[K]> } = {
  status: () => import('./apps/status.ts'),
  terminal: () => import('./apps/terminal.ts'),
  files: () => import('./apps/files.ts'),
  code: () => import('./apps/code.ts'),
  agents: () => import('./apps/agents.ts'),
  editor: () => import('./apps/editor.ts'),
};
const appMods = new Map<AppName, Promise<any>>();
export function app<K extends AppName>(name: K): Promise<AppMods[K]> {
  if (!appMods.has(name)) appMods.set(name, (APPS[name] as () => Promise<AppMods[K]>)().catch((e) => { appMods.delete(name); throw e; }));
  return appMods.get(name)!;
}
// an app's call: loaded for it when on, skipped when it never was
export function appCall<K extends AppName>(name: K, on: boolean, call: (m: AppMods[K]) => void): void {
  if (on || appMods.has(name)) app(name).then(call, (e) => console.error(`${name} failed to load`, e));
}
// past first paint, so opening one never waits on its setup
addEventListener('load', () => (self.requestIdleCallback || setTimeout)(() => {
  for (const n of Object.keys(APPS) as AppName[]) app(n).catch(() => {});
}));
