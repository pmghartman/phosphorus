// JSON values read as the page's JS reads them, and the files the chat keeps
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export type Msg = Record<string, any>;

export const obj = (v: unknown): Msg | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Msg) : undefined;
// false, null, 0, NaN and "" are false
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
export const now = () => Date.now();

export function marshal(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return "null";
  }
}

// the first n code points
export function clipU(s: string, n: number): string {
  const r = [...s];
  return r.length > n ? r.slice(0, n).join("") : s;
}

export function readJSON(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// temp then rename, a reader never sees half a file
export function writeJSON(file: string, v: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, marshal(v), { mode: 0o644 });
  renameSync(tmp, file);
}

// a file written a moment after its last change, every change in between folded in;
// flush() writes what's waiting
export function soon(file: string, failed: (e: unknown) => void, ms = 500) {
  let due: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
    try {
      writeJSON(file, due);
    } catch (e) {
      failed(e);
    }
  };
  return {
    write(v: unknown) {
      due = v;
      timer ??= setTimeout(flush, ms);
    },
    flush,
  };
}
