// forgejo as the key's user: its api with the page login saved for git, and
// that login handed to git over https on a host
import { marshal, obj } from "@phosphorus/util";
import { type Caller, errc, object, pressed, src, str, type Tool } from "./common.ts";

// gitService the mesh's forgejo route and its page login's name
export const gitService = "git";

const domainRe = /^[a-z0-9.-]{1,253}$/;

// forgejoLogin the key's page login for forgejo: the one named git, else one
// saved for git.<domain>
export function forgejoLogin(c: Caller | undefined): [user: string, pass: string] {
  if (!c?.pages) throw errc("forbidden", "on a user's key only");
  const pages = c.pages() ?? {};
  let l = obj(pages[gitService]);
  if (!str(l?.user) && src.domain()) {
    const at = "//" + gitService + "." + src.domain();
    for (const v of Object.values(pages)) {
      const p = obj(v);
      if (str(p?.user) && str(p?.url).includes(at)) {
        l = p;
        break;
      }
    }
  }
  if (!str(l?.user)) {
    throw errc("forbidden", `your key carries no forgejo login: save it in the browser's profile as the page login ${gitService}, the key picks it up`);
  }
  return [str(l!.user), str(l!.pass)];
}

// gitCreds a posix shell prefix reading the forgejo login off stdin, git
// handed it for https://git.<domain> alone, and the stdin lines it reads
export function gitCreds(c: Caller | undefined): [prefix: string, stdin: string] {
  const [user, pass] = forgejoLogin(c);
  const d = src.domain();
  if (!domainRe.test(d)) throw errc("unreachable", "the mesh has no domain, so no forgejo");
  if (/[\r\n]/.test(user + pass)) throw errc("bad_input", "the saved forgejo login holds a line break");
  const prefix =
    "IFS= read -r PHOS_GIT_USER; IFS= read -r PHOS_GIT_PASS; " +
    "export PHOS_GIT_USER PHOS_GIT_PASS GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 " +
    "GIT_CONFIG_KEY_0='credential.https://" + gitService + "." + d + ".helper' " +
    `GIT_CONFIG_VALUE_0='!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$PHOS_GIT_USER" "$PHOS_GIT_PASS"; }; f'` + "\n";
  return [prefix, user + "\n" + pass + "\n"];
}

export const forgejoTools = (): Tool[] => [
  {
    name: "forgejo", title: "Forgejo API", scope: "key", open: true, destructive: true,
    description:
      "Call the mesh's Forgejo (git) API as you, signed in with the forgejo login saved in your vault (the page login git): " +
      "repos, branches, files, commits, issues, pull requests, reviews, releases, orgs, anything under /api/v1. " +
      "Returns status and the JSON body, up to 512KB. Clone and push with terminal_run's git, the same login, at clone_url's address. " +
      "GET /user says who you are; GET /repos/search?q= finds repos; GET /repos/{owner}/{repo}/contents/{path} reads a file.",
    schema: object({
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
      path: { type: "string", description: "under /api/v1, with any query, e.g. /repos/me/app/issues?state=open" },
      body: { description: "the JSON body, an object, an array or JSON as text" },
    }, "path"),
    run: async (a, m) => {
      const [user, pass] = forgejoLogin(m.caller);
      const p = "/" + str(a.path).replace(/^\//, "").replace(/^api\/v1\//, "");
      if (p.includes("..")) throw errc("bad_input", "path holds ..");
      const body = a.body === null || a.body === undefined ? "" : typeof a.body === "string" ? a.body : marshal(a.body);
      const method = str(a.method).toUpperCase() || "GET";
      const hs = { Accept: "application/json", Authorization: "Basic " + Buffer.from(user + ":" + pass).toString("base64") };
      const out = await pressed(src.actions.service("", gitService, method, "/api/v1" + p, hs, body));
      const r = obj(out);
      if (r && src.domain()) r.clone_url = "https://" + gitService + "." + src.domain() + "/{owner}/{repo}.git";
      if (r?.status === 401) r.note = "forgejo refused the saved login " + user + ": fix the page login git in your vault";
      return r ?? null;
    },
  },
];
