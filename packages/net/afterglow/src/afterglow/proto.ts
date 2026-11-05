// the link protocol's version: afterglow says its own in ready and in --features
// (proto=N), this client the range it speaks; one past it refused, never half spoken

export const protoRange = { min: 1, max: 1 } as const;

// afterglow's protocol: one without a number is 1, as every release before it was
export const protoOf = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 1);

// --features' words: proto=N among them, 1 without
export const protoOfFeatures = (words: string[]): number =>
  protoOf(Number(words.find((w) => w.startsWith("proto="))?.slice(6)));

export const protoOK = (n: number) => n >= protoRange.min && n <= protoRange.max;

// what to tell a person when afterglow and phosphorus don't speak the same protocol
export function protoWhy(n: number, version = ""): string {
  const who = version ? `afterglow ${version}` : "afterglow";
  return n > protoRange.max
    ? `${who} speaks protocol ${n}, newer than this phosphorus (${protoRange.max}): update phosphorus`
    : `${who} speaks protocol ${n}, older than this phosphorus needs (${protoRange.min}): update afterglow`;
}
