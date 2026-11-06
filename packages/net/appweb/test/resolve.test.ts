import { expect, test } from "bun:test";
import { execWords, inspectable, winWords } from "../src/resolve.ts";

test("fuses: the inspector on unless the fourth is off or removed; none before fuses", () => {
  expect(inspectable("")).toBe(true);
  expect(inspectable("0111111")).toBe(true);
  expect(inspectable("0110")).toBe(false);
  expect(inspectable("011r111")).toBe(false);
  expect(inspectable("01")).toBe(true);
});

test("a desktop entry's Exec as words, field codes dropped", () => {
  expect(execWords("/usr/bin/code --unity-launch %F")).toEqual(["/usr/bin/code", "--unity-launch"]);
  expect(execWords('env X=1 "/opt/My App/app" --a=%%b')).toEqual(["env", "X=1", "/opt/My App/app", "--a=%b"]);
});

test("a Windows command line's words", () => {
  expect(winWords('--processStart "slack.exe" --a')).toEqual(["--processStart", "slack.exe", "--a"]);
  expect(winWords('"C:\\Program Files\\x y\\a.exe" b')).toEqual(["C:\\Program Files\\x y\\a.exe", "b"]);
});
