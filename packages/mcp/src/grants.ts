// what a key may do past its user's name: admin, the hosts it carries a saved
// login for, a forgejo login; its tool list, refusals and instructions follow it
import { type Caller, type Tool, tools } from "./common.ts";
import { forgejoLogin, gitService } from "./forgejo.ts";

type Grants = { admin: boolean; hosts: string[]; forgejo: boolean };

// a key's grants, worked out once per caller object: once per request
const cache = new WeakMap<Caller, Grants>();

export function grantsOf(c: Caller): Grants {
  let g = cache.get(c);
  if (g) return g;
  g = { admin: !!c.admin, hosts: c.hosts ? [...c.hosts()].sort() : [], forgejo: false };
  try {
    forgejoLogin(c);
    g.forgejo = true;
  } catch {}
  cache.set(c, g);
  return g;
}

// sig the grants as a cache key for the tool list they give
export const sig = (g: Grants) => `${g.admin}|${g.forgejo}|${g.hosts.join(",")}`;

// withheld why a key's grants keep a tool off its list, "" when they don't
export function withheld(t: Tool, c: Caller): string {
  const g = grantsOf(c);
  if (t.admin && !g.admin) return "admins only";
  if (t.name === "forgejo" && !g.forgejo) {
    return "needs a forgejo login on the key: save it in the browser's profile as the page login " + gitService + ", then reconnect";
  }
  return "";
}

// keyDescription a tool's description with what this key can do with it
export function keyDescription(t: Tool, c: Caller): string {
  if (t.name !== "terminal_run") return t.description;
  const g = grantsOf(c);
  let d = t.description + " This key's saved logins: ";
  if (!g.hosts.length) d += "none, so only mode tab, in a terminal the person opened and shared.";
  else d += g.hosts.join(", ") + "; any other host takes mode tab only.";
  if (!g.forgejo) d += " git is off: the key carries no forgejo login.";
  return d;
}

// keyNote the key's rights in words, for initialize's instructions
export function keyNote(c: Caller): string {
  const g = grantsOf(c);
  let b = ` This key acts as ${c.user}, ${g.admin ? "an admin" : "a user"}.`;
  if (!g.hosts.length) b += " It carries no saved host logins: terminal_run works only with mode tab, in a terminal the person opened and shared.";
  else b += ` Saved host logins: ${g.hosts.join(", ")}, where terminal_run runs over ssh as that login; any other host takes mode tab only.`;
  if (g.forgejo) b += " A forgejo login is saved: forgejo and terminal_run git work as it.";
  else b += " No forgejo login: forgejo and terminal_run git are off.";
  const off = tools.filter((t) => withheld(t, c) !== "").map((t) => t.name);
  if (off.length) b += ` Off this key: ${off.join(", ")}; never offer them, say who could.`;
  b += " Files follow each share's own r, w and d perms, which files_list shows. Logins saved in the browser reach the key on its next connection.";
  return b;
}
