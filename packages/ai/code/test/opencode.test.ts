import { expect, test } from "bun:test";
import { sleep } from "@phosphorus/util";
import { of } from "../src/claude.ts";
import { create, ocConfig, ocLaunch, ocTool, send, setRunDir, setSpawn, Tail } from "../src/index.ts";
import { FakeConn, tmp } from "./fake.ts";

test("oc tool", () => {
  let [n, input] = ocTool("edit", { filePath: "/w/a.c", oldString: "x", newString: "y" });
  expect(n).toBe("Edit");
  expect([input.file_path, input.old_string, input.new_string, input.replace_all]).toEqual(["/w/a.c", "x", "y", false]);
  [n, input] = ocTool("write", { filePath: "/w/b.c", content: "z" });
  expect([n, input.content]).toEqual(["Write", "z"]);
  expect(ocTool("edit", { path: "/w/c.c", oldString: "a", newString: "b" })[1].file_path).toBe("/w/c.c");
  expect(ocTool("mystery", {})[0]).toBe("mystery");
  const [, me] = ocTool("multiedit", { path: "/w/d.c", edits: [{ oldString: "a", newString: "b", replaceAll: true }] });
  expect(me.edits).toEqual([{ old_string: "a", new_string: "b", replace_all: true }]);
});

test("oc launch", () => {
  const l = ocLaunch("~/proj", "mesh", "default", "ses_1", "fix it's bug");
  expect(ocLaunch("~/p", "mesh", "plan", "", "x")).not.toContain("--auto");
  expect(l).toContain("--auto");
  for (const want of ["opencode run --format json", `--session '\\''ses_1'\\''`, "OPENCODE_CONFIG=", `-- '\\''fix it'\\''\\'\\'''\\''s bug'\\''`]) expect(l).toContain(want);
  const c = ocConfig("http://10.0.0.1:8090", "mesh", "plan");
  expect(c).toContain('"edit":"deny"');
  expect(c).toContain('"model":"phosphorus/agent-opencode"');
  expect(JSON.parse(c).mcp.phosphorus.headers.Authorization).toBe("Bearer {env:PHOSPHORUS_MCP_KEY}");
});

// a run: opencode's events in, claude's out, its session id kept for the next
test("oc run", async () => {
  setRunDir(tmp("ocrun"));
  const cmds: string[] = [];
  setSpawn(async (_host, _c, _setup, command) => {
    cmds.push(command);
    const out = `{"type":"step_start","sessionID":"ses_1","part":{}}` + "\n" +
      `{"type":"text","sessionID":"ses_1","part":{"text":"Fixed it."}}` + "\n" +
      `{"type":"tool_use","sessionID":"ses_1","part":{"id":"t1","tool":"edit","state":{"status":"completed","input":{"path":"/w/a.c","oldString":"x","newString":"y"},"output":"done"}}}` + "\n" +
      `{"type":"step_finish","sessionID":"ses_1","part":{"tokens":{"input":10,"output":5,"cache":{"read":2,"write":0}},"cost":0}}` + "\n";
    return { in: { write() {}, end() {} }, out: [new TextEncoder().encode(out)], errs: new Tail(), wait: async () => 0, kill() {} };
  });
  try {
    const creds = () => ({ user: "u", pass: "", key: "k", base: "http://b", token: "" });
    const [st, b] = await create("ryan", { host: "razer", dir: "~/w", model: "mesh", harness: "opencode" }, creds);
    expect(st, JSON.stringify(b)).toBe(200);
    const id = b.id;
    const s = of("ryan", id)!;
    const f = new FakeConn();
    f.id = id;
    s.subs.set(f, { c: f, ready: true, backlog: [], seqs: [] });
    await send("ryan", id, { text: "fix the bug" }, creds);
    await f.wait("the result", 5000, (m) => m.ev?.type === "result" && m.ev?.subtype === "success");
    expect(f.find((m) => m.ev?.message?.content?.length === 1 && m.ev.message.content[0].name === "Edit")).toBeDefined();
    expect([s.rec.claudeSID, s.rec.status, s.rec.usage.in]).toEqual(["ses_1", "idle", 12]);
    await send("ryan", id, { text: "again" }, creds);
    await sleep(200);
    expect(cmds.length).toBe(2);
    expect(cmds[1]).toContain("ses_1");
    expect(cmds[0]).not.toContain("--session");
  } finally {
    setSpawn();
  }
});

test("oc refuses anthropic", async () => {
  const [st] = await create("ryan", { host: "razer", dir: "~/w", model: "opus", harness: "opencode" }, () => {
    throw new Error("creds asked");
  });
  expect(st).toBe(400);
});
