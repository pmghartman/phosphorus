// JSON values read as the web client's JS would: String(v || ""), a number
// or none, an object or an empty one
export function str(v: unknown): string {
  if (v === null || v === undefined || v === false || v === "" || (typeof v === "number" && (v === 0 || Number.isNaN(v)))) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((e) => (e === null || e === undefined ? "" : str(e))).join(",");
  if (typeof v === "object") return "[object Object]";
  return String(v);
}

export const num = (v: unknown) => (typeof v === "number" ? v : 0);

export const orObj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});

export const anyList = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// clip s to n code points
export function clip(s: string, n: number): string {
  const r = [...s];
  return r.length > n ? r.slice(0, n).join("") : s;
}

export function lastLine(s: string): string {
  const ls = s.trim().split("\n");
  return clip(ls[ls.length - 1]!.trim(), 500);
}
