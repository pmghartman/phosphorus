// the game servers' page: every host's games with play and stop and the address
// to join at, over the tailnet; an admin's form for what exists and which login
// each host runs them as
import { followTheme } from "@phosphorus/app-sdk/web";

type Row = {
  host: string;
  name: string;
  port: number;
  status: string;
  controllable: boolean;
  address: string;
  start?: string;
  stop?: string;
};
type List = { admin: boolean; hosts: string[]; logins: Record<string, string>; games: Row[] };

const api = "/api/app/games";
const pollMS = 3000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLUListElement>("games");
const form = $<HTMLFormElement>("form");
const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement;

const busy = new Map<string, string>(); // key -> action, while its press is in flight
const errors = new Map<string, string>(); // key -> the last failed press's message
let last: List = { admin: false, hosts: [], logins: {}, games: [] };
let lastSig = "";
let editing: Row | undefined;

const keyOf = (g: Row) => g.host + "/" + g.name;
// stopping still counted as up, so a press never reshuffles the list
const isUp = (g: Row) => g.status === "online" || g.status === "stopping";

const svgNS = "http://www.w3.org/2000/svg";
function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
function icon(kind: string): SVGSVGElement {
  const s = svg("svg", { viewBox: "0 0 10 10", "aria-hidden": "true" }) as SVGSVGElement;
  if (kind === "play") s.append(svg("path", { d: "M 2.5 1.5 L 8.5 5 L 2.5 8.5 Z" }));
  if (kind === "pause")
    s.append(svg("rect", { x: 2, y: 1.5, width: 2, height: 7 }), svg("rect", { x: 6, y: 1.5, width: 2, height: 7 }));
  if (kind === "busy") s.append(svg("path", { d: "M 5 1.5 A 3.5 3.5 0 1 1 1.5 5", class: "game-spin" }));
  if (kind === "copy")
    s.append(
      svg("rect", { x: 3.5, y: 3.5, width: 5, height: 5, class: "stroke" }),
      svg("path", { d: "M 1.5 6.5 V 1.5 H 6.5", class: "stroke" }),
    );
  if (kind === "check") s.append(svg("path", { d: "M 1.5 5.5 L 4 8 L 8.5 2", class: "stroke" }));
  if (kind === "edit") s.append(svg("path", { d: "M 1.5 8.5 L 2 6.5 L 6.5 2 L 8 3.5 L 3.5 8 Z", class: "stroke" }));
  return s;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

async function post(path: string, body: unknown): Promise<string> {
  try {
    const res = await fetch(api + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return "";
    const b = await res.json().catch(() => null);
    return String(b?.error ?? `status ${res.status}`);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function copy(text: string, btn: HTMLButtonElement) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = el("textarea");
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  btn.replaceChildren(icon("check"));
  setTimeout(() => btn.replaceChildren(icon("copy")), 1200);
}

function card(g: Row): HTMLLIElement {
  const key = keyOf(g);
  const li = el("li");
  const c = el("div", "game-card");
  c.tabIndex = 0;
  c.dataset.key = key;

  // online: pause (stops it), offline: play (starts it), in between: spinner
  const spin = busy.has(key) || g.status === "starting" || g.status === "stopping";
  const action = isUp(g) ? "stop" : "start";
  const reachable = g.status !== "down" && g.status !== "unknown";
  const btn = el("button", `game-btn ${spin ? "busy" : g.status}`);
  btn.type = "button";
  btn.disabled = spin || !g.controllable || !reachable;
  btn.title = spin
    ? `${busy.get(key) || g.status}…`
    : g.status === "down"
      ? `${g.host} is down`
      : !reachable
        ? `${g.host} didn't say`
        : g.controllable
          ? `${g.status}: ${action === "start" ? "play" : "stop"}`
          : `${g.status}: no start/stop lines`;
  btn.append(icon(spin ? "busy" : action === "start" ? "play" : "pause"));
  btn.addEventListener("click", () => press(g, action));

  const info = el("div", "game-info");
  const title = el("div", "", g.name);
  title.append(el("span", "meta", g.host));
  info.append(title);
  if (errors.has(key)) info.append(el("div", "game-error", errors.get(key)));

  const detail = el("div", "game-detail");
  const addr = el("span", "game-addr", g.address);
  addr.title = "join at this address, on the tailnet";
  const cp = el("button", "game-copy");
  cp.type = "button";
  cp.title = cp.ariaLabel = "copy";
  cp.append(icon("copy"));
  cp.addEventListener("click", () => void copy(g.address, cp));
  detail.append(addr, cp);
  if (last.admin) {
    const ed = el("button", "game-edit");
    ed.type = "button";
    ed.title = ed.ariaLabel = "edit";
    ed.append(icon("edit"));
    ed.addEventListener("click", () => openForm(g));
    detail.append(ed);
  }
  c.append(btn, info, detail);
  li.append(c);
  return li;
}

// rebuilt only on change, a rebuild every poll eating clicks mid-press
function render() {
  const games = [...last.games].sort(
    (a, b) => Number(isUp(b)) - Number(isUp(a)) || a.host.localeCompare(b.host) || a.name.localeCompare(b.name),
  );
  const sig = JSON.stringify([last, [...busy], [...errors]]);
  if (sig === lastSig) return;
  lastSig = sig;
  const focused = (document.activeElement?.closest?.(".game-card") as HTMLElement | null)?.dataset.key;
  list.replaceChildren(...(games.length ? games.map(card) : [el("li", "empty", "none yet")]));
  if (focused) [...list.querySelectorAll<HTMLElement>(".game-card")].find((c) => c.dataset.key === focused)?.focus();

  $("admin").hidden = !last.admin;
  if (!last.admin) return;
  const hosts = [...new Set([...last.hosts, ...last.games.map((g) => g.host)])].sort();
  $("hosts").replaceChildren(
    ...hosts.map((h) => {
      const li = el("li");
      const login = last.logins[h] ?? "";
      const up = last.hosts.includes(h);
      li.append(el("span", "", h), el("span", login ? "who" : "who none", login || "not set up"));
      if (up) {
        const b = el("button", "gm-btn", login ? "use my login" : "set up with my login");
        b.type = "button";
        b.title = `play/stop on ${h} run as your own saved login there`;
        b.addEventListener("click", async () => {
          b.disabled = true;
          const why = await post("/allow", { host: h });
          b.disabled = false;
          if (why) alert(`${h}: ${why}`);
          void load();
        });
        li.append(b);
      }
      return li;
    }),
  );
  const sel = field("host") as unknown as HTMLSelectElement;
  const cur = sel.value;
  sel.replaceChildren(...hosts.map((h) => Object.assign(el("option", "", h), { value: h })));
  if (cur && hosts.includes(cur)) sel.value = cur;
}

async function press(g: Row, action: string) {
  const key = keyOf(g);
  busy.set(key, action);
  errors.delete(key);
  render();
  const why = await post("/press", { host: g.host, name: g.name, action });
  if (why) errors.set(key, `${action} failed: ${why}`);
  busy.delete(key);
  await load();
  const shown = errors.get(key);
  if (shown)
    setTimeout(() => {
      if (errors.get(key) !== shown) return;
      errors.delete(key);
      render();
    }, 15000);
}

function openForm(g?: Row) {
  editing = g;
  form.reset();
  $("form-error").hidden = true;
  $("remove").hidden = !g;
  if (g) {
    field("name").value = g.name;
    (field("host") as unknown as HTMLSelectElement).value = g.host;
    field("port").value = String(g.port);
    field("start").value = g.start ?? "";
    field("stop").value = g.stop ?? "";
  }
  form.hidden = false;
  $("add").hidden = true;
  field("name").focus();
}

function closeForm() {
  form.hidden = true;
  $("add").hidden = false;
  editing = undefined;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const g = Object.fromEntries(["name", "host", "port", "start", "stop"].map((n) => [n, field(n).value.trim()]));
  const why = await post("/game", { ...g, was: editing && { host: editing.host, name: editing.name } });
  if (why) {
    $("form-error").textContent = why;
    $("form-error").hidden = false;
    return;
  }
  closeForm();
  void load();
});
$("cancel").addEventListener("click", closeForm);
$("add").addEventListener("click", () => openForm());
$("remove").addEventListener("click", async () => {
  if (!editing || !confirm(`remove ${editing.name} on ${editing.host}?`)) return;
  const why = await post("/remove", { host: editing.host, name: editing.name });
  if (why) {
    $("form-error").textContent = why;
    $("form-error").hidden = false;
    return;
  }
  closeForm();
  void load();
});

async function load() {
  try {
    const res = await fetch(api + "/games");
    $("out").hidden = res.status !== 401;
    if (!res.ok) return;
    last = (await res.json()) as List;
    render();
  } catch {}
}

followTheme();
void load();
setInterval(() => {
  if (document.visibilityState === "visible") void load();
}, pollMS);
