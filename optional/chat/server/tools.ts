// the chat's tools for the mesh's MCP server: read it, wait on it, post, edit,
// and who's on; every one on a user's key, as that user
import type { Caller, Tool } from "@phosphorus/app-sdk";
import { allPresence, chatEditAs, knownPerson, mergedChat, postAs } from "./log.ts";
import { jsString, num, obj, str } from "./util.ts";

const chatMax = 50;
const chatWaitMax = 300;

const fail = (code: string, msg: string) => Object.assign(new Error(msg), { code });
const notKnown = (to: string) => fail("not_found", `no one called ${to}; people lists who's on, any user's name works`);
// [status, body] as a tool's result, its error thrown
function pressed([st, body]: [number, any]): unknown {
  if (st === 200) return body;
  const msg = str(obj(body)?.error) || `failed (${st})`;
  throw fail(st === 404 ? "not_found" : st === 403 ? "forbidden" : st === 400 ? "bad_input" : "failed", msg);
}

const object = (props: Record<string, unknown> = {}, ...required: string[]) => ({
  type: "object",
  properties: props,
  ...(required.length ? { required } : {}),
});

// the chat as me may read it: channels, and their own direct messages
export function chatRows(me: string, want: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const all = mergedChat;
  // edits and deletes folded in, each by its own author only
  const authors = new Map<string, unknown>();
  for (const x of all) authors.set(`${jsString(x.host)}:${jsString(x.seq)}`, x.name);
  const gone = new Set<string>();
  const edited = new Map<string, string>();
  for (const x of all) {
    const ref = str(x.ref);
    if (authors.get(ref) !== x.name) continue;
    if (str(x.kind) === "delete") gone.add(ref);
    else if (str(x.kind) === "edit") edited.set(ref, str(x.text));
  }
  for (const x of all) {
    const k = str(x.kind);
    if (k && k !== "model" && k !== "dm") continue;
    let ch = str(x.ch) || "mesh";
    const dm = str(x.dm);
    if (dm) {
      if (!me || (dm !== me && str(x.name) !== me)) continue;
      ch = "dm:" + (dm === me ? str(x.name) : dm);
    }
    if (want && ch !== want) continue;
    const ts = Math.trunc(num(x.timestamp));
    const ref = `${jsString(x.host)}:${jsString(x.seq)}`;
    if (gone.has(ref)) continue;
    const row: Record<string, any> = {
      at: new Date(ts).toISOString(),
      ms: ts,
      channel: ch,
      name: x.name,
      text: x.text,
      ref,
    };
    const t = edited.get(ref);
    if (t !== undefined) {
      row.text = t;
      row.edited = true;
    }
    const v = str(x.via);
    if (v) row.via = v;
    if (Array.isArray(x.files)) row.files = x.files.map((f: unknown) => obj(f)?.name ?? null);
    out.push(row);
  }
  return out;
}

// throws unless want is blank, mesh, a known person's dm or a channel with lines
function channelKnown(me: string, want: string) {
  if (!want || want === "mesh") return;
  if (want.startsWith("dm:")) {
    const p = want.slice(3);
    if (knownPerson(p)) return;
    throw fail("not_found", `no one called ${p}`);
  }
  const seen = new Set(["mesh"]);
  for (const r of chatRows(me, "")) seen.add(str(r.channel));
  if (seen.has(want)) return;
  throw fail("not_found", `no channel ${want}; there are ${[...seen].join(", ")}, or dm:<name>`);
}

// lines after since in want, as soon as one lands or after wait_s with none
async function chatWait(a: Record<string, any>, me: string, want: string): Promise<Record<string, any>> {
  // only a missing since means now, 0 the whole history
  let since = Date.now();
  if (a.since !== undefined && a.since !== null) since = Math.trunc(Number(a.since));
  const wait = Number(a.wait_s);
  const end = Date.now() + Math.min(chatWaitMax, Math.max(1, Number.isFinite(wait) ? wait : 60)) * 1000;
  for (;;) {
    const fresh = chatRows(me, want).filter((r) => r.ms > since);
    if (fresh.length || Date.now() > end) return { lines: fresh, now: Date.now() };
    await Bun.sleep(1000);
  }
}

export function tools(): Tool[] {
  return [
    {
      name: "chat_history",
      title: "Read chat",
      read: true,
      description:
        "The last chat lines, oldest first: channels (mesh is the main one), and your own direct messages as dm:<name>. " +
        "Each line has its ms. wait_s waits for lines newer than since (that ms), returning as soon as one lands: " +
        "for a reply after send_message.",
      schema: object({
        limit: { type: "integer", description: `lines, at most ${chatMax}`, default: 20 },
        channel: { type: "string", description: "one channel only: mesh for the main one, or dm:<name>" },
        wait_s: {
          type: "integer",
          description: `wait up to this many seconds (max ${chatWaitMax}) for lines newer than since`,
          default: 0,
        },
        since: { type: "integer", description: "with wait_s: only lines after this ms, default now" },
      }),
      run: async (a, who: Caller) => {
        const want = str(a.channel).replace(/^#/, "");
        channelKnown(who.user, want);
        if (Number(a.wait_s) > 0) return chatWait(a, who.user, want);
        let n = 20;
        if ("limit" in a) {
          const x = Number(a.limit);
          if (Number.isNaN(x) || x < 1 || x > chatMax) throw fail("bad_input", `limit is 1 to ${chatMax}`);
          n = Math.trunc(x);
        }
        const lines = chatRows(who.user, want);
        return lines.length > n ? lines.slice(lines.length - n) : lines;
      },
    },
    {
      name: "send_message",
      title: "Send a chat message",
      description:
        "Post as yourself to the mesh group chat, or as a direct message to one person by their chat name, " +
        "for when the asker wants someone else told something. Never needed to answer the asker.",
      schema: object(
        {
          text: { type: "string", description: "the message, markdown" },
          to: { type: "string", description: "a person's chat name for a direct message, blank for the group chat" },
        },
        "text",
      ),
      run: async (a, who) => {
        const to = str(a.to).trim().replace(/^@/, "");
        if (to && !knownPerson(to)) throw notKnown(to);
        return pressed(postAs(who.user, to, str(a.text), who.via));
      },
    },
    {
      name: "chat_edit",
      title: "Edit or withdraw a chat line",
      description: "Edit or delete one of your own chat lines by its ref from chat_history.",
      schema: object(
        {
          ref: { type: "string", description: "host:seq, from chat_history" },
          action: { type: "string", enum: ["edit", "delete"] },
          text: { type: "string", description: "edit only: the new text" },
        },
        "ref",
        "action",
      ),
      run: async (a, who) => pressed(chatEditAs(who.user, str(a.ref), str(a.action), str(a.text))),
    },
    {
      name: "people",
      title: "People online",
      read: true,
      description: "Who is on the chat right now: each person, the host serving them, and whether they are typing.",
      schema: object(),
      run: async () =>
        allPresence().map((p) => {
          const row: Record<string, any> = { name: p.name ?? null, host: p.host ?? null };
          const t = str(p.typing);
          if (t) row.typing = t.startsWith("dm:") ? "a direct message" : t;
          return row;
        }),
    },
  ];
}
