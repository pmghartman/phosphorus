import "./env.ts";
import { expect, test } from "bun:test";

const { driveShell, errShellTimeout, readLines } = await import("@phosphorus/server");

// a local /bin/sh, its stderr folded into stdout as the ssh session's is
function localShell() {
  const p = Bun.spawn(["/bin/sh", "-c", "exec /bin/sh 2>&1"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const stdin = {
    write: async (s: string) => {
      p.stdin.write(s);
      await p.stdin.flush();
    },
  };
  return { p, stdin, lines: readLines(p.stdout as unknown as AsyncIterable<Uint8Array>) };
}

// driveShell driven against a local /bin/sh, the same io a persistent ssh
// shell gives: state kept across commands, exit codes read, stdin fed
test.skipIf(process.platform === "win32")("drive shell", async () => {
  const { p, stdin, lines } = localShell();
  try {
    let n = 0;
    const run = async (cmd: string, feed: string): Promise<[string, number]> => {
      n++;
      const tag = n > 1 ? "__t" + "x".repeat(n) + " 0 " : "__t 0 ";
      const [o, code, err] = await driveShell(stdin, lines, cmd, feed, tag, 5000);
      expect(err).toBeUndefined();
      return [o, code];
    };
    expect(await run("echo hello", "")).toEqual(["hello", 0]);
    // stderr folded in
    expect((await run("echo oops 1>&2", ""))[0]).toBe("oops");
    // exit code carried
    expect(await run("false", "")).toEqual(["", 1]);
    // state kept: cd then pwd, env set then read
    await run("cd /tmp && A=42", "");
    expect((await run("pwd; echo $A", ""))[0]).toBe("/tmp\n42");
    // stdin fed to a reader
    expect((await run("cat", "fed line"))[0]).toBe("fed line");
    // output with no trailing newline
    expect((await run("printf nonl", ""))[0]).toBe("nonl");
  } finally {
    p.kill();
  }
});

test.skipIf(process.platform === "win32")("drive shell timeout", async () => {
  const { p, stdin, lines } = localShell();
  try {
    const [, , err] = await driveShell(stdin, lines, "sleep 5", "", "__to 0 ", 300);
    expect(err).toBe(errShellTimeout);
  } finally {
    p.kill();
  }
});
