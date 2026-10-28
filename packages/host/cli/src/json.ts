// json as the api sends it, read loosely: a path into it, a map, a list of
// maps, and values as a template literal would print them
export type J = Record<string, any>;

export function get(v: any, ...path: string[]): any {
  for (const p of path) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    v = v[p];
  }
  return v;
}

export const obj = (v: any): J | undefined => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);

export const objs = (v: any): J[] => (Array.isArray(v) ? v.filter((x) => obj(x) !== undefined) : []);

export const anys = (v: any): any[] => (Array.isArray(v) ? v : []);

export const strs = (v: any): string[] => anys(v).map(str);

// nothing for null
export const str = (v: any): string => (v == null ? "" : String(v));

export function num(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

export const truthy = (v: any): boolean => !!v;

export const indexOf = (xs: string[], x: string) => xs.indexOf(x);

// the first non-blank
export const or = (...xs: string[]) => xs.find((x) => x !== "") ?? "";
