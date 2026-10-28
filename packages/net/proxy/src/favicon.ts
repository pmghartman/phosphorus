// a service's own icon: its page's links, its manifest's, then the usual paths,
// each looked up on the service directly and kept a while
import { baseDomain, everyRoute, notes, type Route, strip, under } from "./index.ts";

const iconMax = 256 * 1024;
const iconKeepMs = 3600_000;
const iconMissMs = 600_000;
// a miss when the service didn't answer at all: a host restarting, asked again soon
const iconDownMs = 30_000;

// a service's own icon
export type Icon = { type: string; body: Uint8Array };
type Grabbed = { typ: string; body: Uint8Array; path: string };
// answered: set once the service gives any response
type GrabOpts = { page?: boolean; hops: number; trace?: string[]; answered?: { yes: boolean } };

const held = new Map<string, { done: Promise<Icon | undefined>; until: number }>();

function unpack(body: Uint8Array, enc: string): Uint8Array | undefined {
  const l = enc.toLowerCase();
  try {
    if (/\bgzip\b/.test(l)) return Bun.gunzipSync(body as Uint8Array<ArrayBuffer>);
    if (/\bdeflate\b/.test(l)) {
      try {
        return Bun.inflateSync(body.subarray(2) as Uint8Array<ArrayBuffer>);
      } catch {
        return Bun.inflateSync(body as Uint8Array<ArrayBuffer>);
      }
    }
  } catch {
    return;
  }
  return body;
}

async function grab(rt: Route, p: string, max: number, o: GrabOpts): Promise<Grabbed | undefined> {
  const say = (what: string) => o.trace?.push(p + " " + what);
  const host = rt.domain || baseDomain;
  const servername = rt.scheme === "https" && host && !/^[\d.]+$|:/.test(host) ? host : undefined;
  let res: Response;
  try {
    res = await fetch(`${rt.scheme}://${rt.ip.includes(":") ? `[${rt.ip}]` : rt.ip}:${rt.port}${p}`, {
      headers: {
        ...(host ? { Host: host } : {}),
        Accept: o.page ? "text/html,*/*;q=0.8" : "image/*,*/*;q=0.8",
        "Accept-Encoding": "identity",
        "User-Agent": "Mozilla/5.0 (phosphorus icons)",
        "X-Forwarded-Host": host,
        "X-Forwarded-Proto": rt.proto,
        "X-Forwarded-Prefix": rt.prefix,
      },
      redirect: "manual",
      decompress: false,
      tls: { rejectUnauthorized: false, serverName: servername },
      signal: AbortSignal.timeout(4000),
    });
  } catch (e: any) {
    say(e?.name === "TimeoutError" ? "timed out" : (e?.message ?? String(e)));
    return;
  }
  if (o.answered) o.answered.yes = true;
  const loc = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && loc) {
    const next = o.hops > 0 ? iconPath(rt, loc, p) : "";
    say(`${res.status} to ${loc}${next ? "" : ", not followed"}`);
    return next && next !== p ? grab(rt, next, max, { ...o, hops: o.hops - 1 }) : undefined;
  }
  const ct = res.headers.get("content-type") ?? "";
  const enc = res.headers.get("content-encoding") ?? "";
  say(`${res.status} ${ct || "no type"}${enc ? " " + enc : ""}`);
  if (res.status !== 200 && !(o.page && res.status >= 400 && res.status < 500)) return;
  let body = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (body.length > max) {
    if (!o.page) return;
    body = body.subarray(0, max);
  }
  const b = unpack(body, enc);
  return b && { typ: ct, body: b, path: p };
}

function iconPath(rt: Route, href: string, from: string): string {
  let u: URL;
  try {
    u = new URL(href.replaceAll("&amp;", "&"), new URL(from, "http://upstream/"));
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const own = [rt.domain || baseDomain, rt.ip, "localhost", "127.0.0.1"];
  if (u.host !== "upstream" && !own.includes(u.hostname)) return "";
  let p = u.pathname;
  if (rt.prefix && under(p, rt.prefix)) p = strip(p, rt.prefix);
  return p + u.search;
}

const svgRe = /^﻿?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i;
const ascii = (b: Uint8Array, a: number, z: number) => String.fromCharCode(...b.subarray(a, z));

function sniff(b: Uint8Array): string {
  if (b.length >= 4 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return "image/png";
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  if (b.length >= 3 && ascii(b, 0, 3) === "GIF") return "image/gif";
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  return svgRe.test(new TextDecoder().decode(b.subarray(0, 1024))) ? "image/svg+xml" : "";
}

function asImage(g: Grabbed | undefined): Icon | undefined {
  if (!g || g.body.length < 4) return;
  const named = (g.typ.split(";")[0] ?? "").trim().toLowerCase();
  const t = sniff(g.body) || (named.startsWith("image/") ? named : "");
  return t ? { type: t, body: g.body } : undefined;
}

function fromData(href: string): Icon | undefined {
  const m = /^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is.exec(href);
  if (!m) return;
  try {
    return {
      type: m[1]!.toLowerCase(),
      body: m[2] ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!)),
    };
  } catch {}
}

async function manifestIcons(rt: Route, href: string, from: string, trace?: string[]): Promise<string[]> {
  const p = iconPath(rt, href, from);
  if (!p) return [];
  const g = await grab(rt, p, iconMax, { hops: 4, trace });
  if (!g) return [];
  let icons: any[];
  try {
    icons = JSON.parse(new TextDecoder().decode(g.body)).icons ?? [];
  } catch {
    return [];
  }
  const size = (i: any) =>
    Math.max(
      0,
      ...String(i.sizes ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((x) => parseInt(x.toLowerCase().split("x")[0]!, 10) || (x === "any" ? 1024 : 0)),
    );
  return icons
    .filter((i) => typeof i?.src === "string")
    .sort((a, b) => size(b) - size(a))
    .map((i) => iconPath(rt, i.src, p))
    .filter(Boolean);
}

const usualIcons = [
  "/favicon.ico",
  "/favicon.png",
  "/favicon.svg",
  "/apple-touch-icon.png",
  "/static/favicon.ico",
  "/static/favicon.png",
  "/assets/favicon.ico",
  "/.client/favicon.png",
  "/.client/logo.png",
  "/logo.png",
  "/icon.png",
];

function hrefOf(tag: string): string {
  const d = /\bhref\s*=\s*"([\s\S]*?)"/i.exec(tag);
  const s = /\bhref\s*=\s*'([\s\S]*?)'/i.exec(tag);
  if (d && (!s || d.index < s.index)) return d[1]!;
  if (s) return s[1]!;
  return /\bhref\s*=\s*([^\s"'>]+)/i.exec(tag)?.[1] ?? "";
}

async function lookIcon(rt: Route, trace?: string[], answered?: { yes: boolean }): Promise<Icon | undefined> {
  const page = await grab(rt, "/", iconMax * 4, { page: true, hops: 4, trace, answered });
  let html = "";
  if (page && (/html/.test(page.typ) || /^\s*</.test(new TextDecoder().decode(page.body.subarray(0, 64)))))
    html = new TextDecoder().decode(page.body);
  let from = page?.path ?? "/";
  const base = /<base\b[^>]*\bhref\s*=\s*(["'])([^"']*)["']/i.exec(html);
  if (base?.[2]) {
    const x = iconPath(rt, base[2].endsWith("/") ? base[2] + "_" : base[2], page?.path ?? "/");
    if (x) from = x;
  }
  const icons: string[] = [],
    touch: string[] = [];
  let manifest = "";
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const lr = (/\brel\s*=\s*["']?([^"'>]*)/i.exec(tag)?.[1] ?? "").toLowerCase();
    const href = hrefOf(tag);
    if (href && /\bmanifest\b/.test(lr) && !manifest) manifest = href.trim();
    if (!lr.includes("icon") || lr.includes("mask-icon") || !href) continue;
    (lr.includes("apple-touch") ? touch : icons).push(href.trim());
  }
  const all = [...icons, ...touch];
  for (const h of all)
    if (h.startsWith("data:")) {
      const d = fromData(h);
      if (d) return d;
    }
  const paths = all
    .filter((h) => !h.startsWith("data:"))
    .map((h) => iconPath(rt, h, from))
    .filter(Boolean);
  trace?.push(
    "page names " + (paths.length ? paths.join(", ") : "no icons") + (manifest ? ", manifest " + manifest : ""),
  );
  if (manifest) paths.push(...(await manifestIcons(rt, manifest, from, trace)));
  for (const p of new Set([...paths, ...usualIcons])) {
    const r = asImage(await grab(rt, p, iconMax, { hops: 4, trace }));
    if (r) return r;
  }
}

const findRoute = (host: string, name: string) => everyRoute().find((r) => r.host === host && r.name === name);

// a service's icon, undefined when it has none, kept a while
export function favicon(host: string, name: string): Promise<Icon | undefined> {
  const key = host + "/" + name;
  const h = held.get(key);
  if (h && Date.now() < h.until) return h.done;
  const rt = findRoute(host, name);
  if (!rt) return Promise.resolve(undefined);
  const entry = { until: Date.now() + iconKeepMs, done: undefined as any as Promise<Icon | undefined> };
  const answered = { yes: false };
  entry.done = lookIcon(rt, undefined, answered)
    .catch(() => undefined)
    .then((icon) => {
      if (!icon && !answered.yes) {
        entry.until = Date.now() + iconDownMs;
        notes.log(`no icon for ${key} yet: ${rt.scheme}://${rt.ip}:${rt.port} didn't answer`);
      } else if (!icon) {
        entry.until = Date.now() + iconMissMs;
        notes.log(`no icon found for ${key} at ${rt.scheme}://${rt.ip}:${rt.port}, its page and the usual paths tried`);
      }
      return icon;
    });
  held.set(key, entry);
  return entry.done;
}

// every step of a fresh lookup
export async function faviconWhy(host: string, name: string) {
  const rt = findRoute(host, name);
  if (!rt) return { route: null, steps: [`no route for ${host}/${name}`] };
  const steps: string[] = [];
  const icon = await lookIcon(rt, steps);
  return {
    route: `${rt.scheme}://${rt.ip}:${rt.port}, host ${rt.domain || baseDomain}, prefix ${rt.prefix || "/"}`,
    found: icon ? `${icon.type}, ${icon.body.length} bytes` : null,
    steps,
  };
}
