import { expect, test } from "bun:test";
import { newer } from "@phosphorus/appfeed";

test("newer", () => {
  for (const [a, b, want] of [["0.8.1", "0.8.0", true], ["0.8", "0.8.0", false], ["0.10.0", "0.9.9", true], ["0.7.9", "0.8", false]] as const)
    expect(newer(a, b)).toBe(want);
});
