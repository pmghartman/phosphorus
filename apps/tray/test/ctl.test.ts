import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, reply } from "../src/ctl.ts";

test("a reply is the daemon's last line, a dropped one without it", () => {
  expect(reply('{"ok":true,"running":true}\n')).toEqual({ ok: true, running: true });
  expect(reply('noise\n{"ok":false,"error":"not allowed"}\n')).toEqual({ ok: false, error: "not allowed" });
  for (const t of ["", "half a line", '{"running":true}', "null"])
    expect(reply(t)).toEqual({ ok: false, dropped: true, error: "phosphorus's daemon didn't answer" });
});

test("no daemon: a dropped reply, not a hang", async () => {
  const r = await call({ op: "status" }, 2000, join(mkdtempSync(join(tmpdir(), "phos-ctl-")), "none.sock"));
  expect(r.ok).toBe(false);
  expect(r.dropped).toBe(true);
});

test.skipIf(process.platform === "win32")("one line asked, one answered", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "phos-ctl-")), "d.sock");
  const got: string[] = [];
  const srv = Bun.listen({
    unix: path,
    socket: {
      data(s, d) {
        got.push(d.toString());
        s.end(JSON.stringify({ ok: true, running: false }) + "\n");
      },
    },
  });
  try {
    expect(await call({ op: "status" }, 5000, path)).toEqual({ ok: true, running: false });
    expect(got).toEqual(['{"op":"status"}\n']);
  } finally {
    srv.stop(true);
  }
});
