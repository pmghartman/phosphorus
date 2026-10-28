// the process environment, read once where a value is wanted
// k, def when unset or empty
export const env = (k: string, def = "") => process.env[k] || def;

// Number(process.env.X || def), def on a bad number
export function envInt(k: string, def: number): number {
  const v = process.env[k];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}
