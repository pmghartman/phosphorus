import { expect, test } from "bun:test";
import { porkbun, RegistrarError } from "@phosphorus/registrar";

// porkbun's API as a mock: the keys checked on every call, glue and nameservers kept
function mock(opts: { apiAccess?: boolean; oldShape?: boolean } = {}) {
  const glue = new Map<string, string[]>();
  let ns = ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"];
  const calls: string[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname.replace(/^\/v3\//, "");
      const body: any = await req.json();
      calls.push(path);
      const err = (code: string, message: string) => Response.json({ status: "ERROR", code, message }, { status: 400 });
      if (body.apikey !== "pk1_ok" || body.secretapikey !== "sk1_ok")
        return err("INVALID_CREDENTIALS", "Invalid API key.");
      if (path === "ping") return Response.json({ status: "SUCCESS", yourIp: "203.0.113.9" });
      const [, op, domain, sub] = path.split("/");
      if (domain !== "philab.io") return err("DOMAIN_NOT_FOUND", "no such domain");
      if (opts.apiAccess === false) return err("API_ACCESS_DISABLED", "The domain is not opted in to API access.");
      switch (op) {
        case "getNs":
          return Response.json({ status: "SUCCESS", ns });
        case "updateNs":
          ns = body.ns;
          return Response.json({ status: "SUCCESS", warnings: [] });
        case "getGlue": {
          const list = [...glue].map(([host, v4]) => ({ host, v4, v6: [] }));
          return Response.json(
            opts.oldShape
              ? { status: "SUCCESS", hosts: list.map((g) => [g.host, { v4: g.v4, v6: g.v6 }]) }
              : { status: "SUCCESS", glue: list, hosts: [] },
          );
        }
        case "createGlue":
          if (glue.has(`${sub}.${domain}`)) return err("GLUE_EXISTS", "host exists");
          glue.set(`${sub}.${domain}`, body.ips);
          return Response.json({ status: "SUCCESS" });
        case "updateGlue":
          if (!glue.has(`${sub}.${domain}`)) return err("GLUE_MISSING", "no such host");
          glue.set(`${sub}.${domain}`, body.ips);
          return Response.json({ status: "SUCCESS" });
      }
      return err("NOT_FOUND", path);
    },
  });
  return { base: `http://127.0.0.1:${srv.port}/v3`, glue, ns: () => ns, calls, stop: () => srv.stop(true) };
}

const ok = { apikey: "pk1_ok", secretapikey: "sk1_ok" };
const ns = [
  { name: "ns1.philab.io", ip: "203.0.113.1" },
  { name: "ns2.philab.io", ip: "203.0.113.1" },
];

test("the domain pointed at the mesh: glue made, nameservers set; a second run changes nothing", async () => {
  const m = mock();
  try {
    const steps = await porkbun.delegate(ok, "philab.io", ns, m.base);
    expect(steps).toEqual([
      "made the host record ns1.philab.io at 203.0.113.1",
      "made the host record ns2.philab.io at 203.0.113.1",
      "philab.io now uses ns1.philab.io and ns2.philab.io",
    ]);
    expect([...m.glue]).toEqual([
      ["ns1.philab.io", ["203.0.113.1"]],
      ["ns2.philab.io", ["203.0.113.1"]],
    ]);
    expect(m.ns()).toEqual(["ns1.philab.io", "ns2.philab.io"]);
    const again = await porkbun.delegate(ok, "philab.io", ns, m.base);
    expect(again).toEqual([
      "ns1.philab.io already points at 203.0.113.1",
      "ns2.philab.io already points at 203.0.113.1",
      "philab.io already uses them",
    ]);
    // an edge moved: its glue updated in place
    const moved = await porkbun.delegate(
      ok,
      "philab.io",
      [ns[0]!, { name: "ns2.philab.io", ip: "203.0.113.2" }],
      m.base,
    );
    expect(moved[1]).toBe("updated the host record ns2.philab.io at 203.0.113.2");
    expect(m.glue.get("ns2.philab.io")).toEqual(["203.0.113.2"]);
  } finally {
    m.stop();
  }
});

test("the older glue shape read, wrong keys and a domain without API access told plainly", async () => {
  const old = mock({ oldShape: true });
  try {
    await porkbun.delegate(ok, "philab.io", ns, old.base);
    const p = new porkbun.Porkbun(ok, old.base);
    expect((await p.glue("philab.io")).map((g) => g.host)).toEqual(["ns1.philab.io", "ns2.philab.io"]);
    const bad = await porkbun.delegate({ apikey: "x", secretapikey: "y" }, "philab.io", ns, old.base).catch((e) => e);
    expect(bad).toBeInstanceOf(RegistrarError);
    expect(bad.message).toBe("porkbun refused the API key and secret");
  } finally {
    old.stop();
  }
  const off = mock({ apiAccess: false });
  try {
    const e = await porkbun.delegate(ok, "philab.io", ns, off.base).catch((e) => e);
    expect(e.code).toBe("API_ACCESS_DISABLED");
    expect(e.message).toContain("turn on API access for philab.io at porkbun");
    const wrong = await porkbun
      .delegate(ok, "philab.io", [{ name: "ns1.other.io", ip: "203.0.113.1" }], off.base)
      .catch((e) => e);
    expect(wrong.message).toBe("ns1.other.io isn't under philab.io");
  } finally {
    off.stop();
  }
});
