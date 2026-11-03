import { describe, expect, test } from "bun:test";
import type { AppDef } from "@phosphorus/wire";
import { check, checkApp, type HostFacts } from "../src/check.ts";
import { envFields } from "../src/manifest.ts";
import { archsOf, clearCache, parseRef } from "../src/registry.ts";
import { json } from "./helpers.ts";

const app = (compose: string, o: Partial<AppDef> = {}): AppDef => ({
  id: "t",
  source: "casaos",
  ref: "T",
  name: "T",
  tagline: "",
  description: "",
  icon: "",
  category: "",
  repo: "",
  licence: "Apache-2.0",
  archs: [],
  compose,
  env: envFields(compose, []),
  manifest: { volumes: [] },
  ...o,
});

const linux: HostFacts = {
  host: "box",
  platform: "linux",
  arch: "amd64",
  docker: { state: "present", version: "27" },
  listening: [22],
};
const pi: HostFacts = { host: "pi", platform: "linux", arch: "arm64", distro: "debian" };
const win: HostFacts = { host: "desk", os: "windows", arch: "amd64" };
const web = "services:\n  web:\n    image: example/web:1\n    ports: ['8080:80']\n";

describe("verdicts", () => {
  test("installable, every host's fit said", () => {
    const r = check(app(web), {}, [linux, pi, win], { "example/web:1": { archs: ["amd64", "arm64"] } });
    expect(r.verdict).toBe("installable");
    expect(r.missing).toEqual([]);
    expect(r.hosts).toEqual([
      { host: "box", ok: true, docker: "present", arch: "amd64" },
      { host: "pi", ok: true, docker: "installable", arch: "arm64" },
      { host: "desk", ok: false, docker: "unsupported", arch: "amd64", why: "needs Linux + Docker" },
    ]);
  });

  test("required env without a default needs input; secrets and defaults don't", () => {
    const c = `services:\n  a:\n    image: x\n    environment:\n      - A=\${ADMIN_EMAIL}\n      - B=\${MODE:-fast}\n      - C=\${DB_PASSWORD}\n`;
    const d = app(c);
    const r = check(d, {}, [linux], { x: { archs: ["amd64"] } });
    expect(r.verdict).toBe("needs-input");
    expect(r.missing).toEqual(["ADMIN_EMAIL"]);
    expect(check(d, { ADMIN_EMAIL: "a@b.c" }, [linux], { x: { archs: ["amd64"] } }).verdict).toBe("installable");
  });

  test("blocked: no compose, an unparsable one, a missing image, a build from a catalogue", () => {
    expect(check(app(""), {}, [linux], {}).items[0]).toEqual({ level: "block", text: "no Docker Compose file" });
    expect(check(app("services: [oops"), {}, [linux], {}).verdict).toBe("blocked");
    const missing = check(app(web), {}, [linux], {
      "example/web:1": { error: "example/web:1 not found", missing: true },
    });
    expect(missing.verdict).toBe("blocked");
    const b = "services:\n  a:\n    build: .\n";
    expect(check(app(b), {}, [linux], {}).items).toContainEqual({
      level: "block",
      text: "a builds from source, which only a repo opened from GitHub can",
    });
    expect(check(app(b, { source: "github" }), {}, [linux], {}).verdict).toBe("installable");
    expect(check(app(b, { source: "phosphorus" }), {}, [linux], {}).verdict).toBe("installable");
  });

  test("no image for any host's arch blocks; one host lacking it is unfit", () => {
    const r = check(app(web), {}, [linux, pi], { "example/web:1": { archs: ["amd64"] } });
    expect(r.verdict).toBe("installable");
    expect(r.hosts[1]).toMatchObject({ host: "pi", ok: false, why: "no arm64 image for example/web:1" });
    const none = check(app(web), {}, [pi], { "example/web:1": { archs: ["amd64"] } });
    expect(none.verdict).toBe("blocked");
    expect(none.items.at(-1)).toEqual({ level: "block", text: "no host on the mesh can run it" });
  });

  test("privileged, host network, devices and capabilities warn; a taken port warns", () => {
    const c =
      "services:\n  a:\n    image: x\n    privileged: true\n    network_mode: host\n    devices: ['/dev/dri']\n    cap_add: [NET_ADMIN]\n    ports: ['22:22']\n";
    const r = check(app(c), {}, [linux], { x: { archs: ["amd64"] } });
    expect(r.verdict).toBe("installable");
    const warns = r.items.filter((i) => i.level === "warn").map((i) => i.text);
    expect(warns).toEqual([
      "a runs privileged",
      "a uses the host's network",
      "a uses host devices",
      "a adds capabilities: NET_ADMIN",
      "port 22 taken on box",
    ]);
    expect(r.hosts[0]).toMatchObject({ ok: true, why: "port 22 taken on box" });
  });

  test("a Linux host without Docker off Debian/Ubuntu is unfit", () => {
    const r = check(app(web), {}, [{ host: "arch", platform: "linux", arch: "amd64", distro: "arch" }], {});
    expect(r.hosts[0]).toMatchObject({ ok: false, docker: "unsupported" });
    expect(r.verdict).toBe("blocked");
  });
});

describe("registry", () => {
  test("refs", () => {
    expect(parseRef("postgres")).toEqual({ host: "registry-1.docker.io", repo: "library/postgres", ref: "latest" });
    expect(parseRef("lscr.io/linuxserver/jellyfin:latest")).toEqual({
      host: "ghcr.io",
      repo: "linuxserver/jellyfin",
      ref: "latest",
    });
    expect(parseRef("quay.io/a/b@sha256:ab")).toEqual({ host: "quay.io", repo: "a/b", ref: "sha256:ab" });
    expect(parseRef("localhost:5000/x:1")).toEqual({ host: "localhost:5000", repo: "x", ref: "1" });
  });

  test("an anonymous token, then the manifest list's linux platforms; cached", async () => {
    clearCache();
    let calls = 0;
    const f = async (url: string, init?: RequestInit) => {
      calls++;
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (url.startsWith("https://auth.test/token")) {
        expect(url).toContain("scope=repository%3Alibrary%2Fnginx%3Apull");
        return json({ token: "t0k" });
      }
      if (!auth)
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer realm="https://auth.test/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
          },
        });
      expect(auth).toBe("Bearer t0k");
      return json({
        manifests: [
          { platform: { os: "linux", architecture: "amd64" } },
          { platform: { os: "linux", architecture: "arm", variant: "v7" } },
          { platform: { os: "unknown", architecture: "unknown" } },
        ],
      });
    };
    expect(await archsOf("nginx:1", f)).toEqual({ archs: ["amd64", "arm"] });
    const n = calls;
    expect(await archsOf("nginx:1", f)).toEqual({ archs: ["amd64", "arm"] });
    expect(calls).toBe(n);
  });

  test("checkApp asks the registry of each image, then checks", async () => {
    clearCache();
    const f = async (url: string) =>
      url.includes("/manifests/") ? new Response(null, { status: 404 }) : new Response(null, { status: 500 });
    const r = await checkApp(app(web), {}, [linux], f);
    expect(r.verdict).toBe("blocked");
    expect(r.items).toContainEqual({ level: "block", text: "example/web:1 not found (or private)" });
  });
});
