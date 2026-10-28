// JSON values read as Go's util read them: the page's JS semantics
import { obj } from "@phosphorus/util";

export { obj };
export type Msg = Record<string, any>;

// Go's truthy: false, nil, 0, NaN and "" are false
export const truthy = (v: unknown) => (typeof v === "number" ? v !== 0 && !Number.isNaN(v) : !!v);
// as a JS template literal renders a JSON value
export const jsString = (v: unknown): string =>
  v == null
    ? "null"
    : Array.isArray(v)
      ? v.map((e) => (e == null ? "" : jsString(e))).join(",")
      : typeof v === "object"
        ? "[object Object]"
        : String(v);
export const str = (v: unknown) => (truthy(v) ? jsString(v) : "");
export const num = (v: unknown) => (typeof v === "number" ? v : 0);
export const isFinite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
export const anyList = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// raw JSON as a value, undefined when it isn't JSON
export function decode(raw: string | Uint8Array): any {
  try {
    return JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  } catch {
    return undefined;
  }
}

// the first n code points, as Go's rune slicing
export function clipU(s: string, n: number): string {
  const r = [...s];
  return r.length > n ? r.slice(0, n).join("") : s;
}

// bytes as text, invalid runs replaced
export const utf8 = (b: Uint8Array) => Buffer.from(b).toString("utf8");
