// the game servers for agents: listed with their status and join address, and
// play or stop pressed as the page's button does
import type { Reply, Tool } from "@phosphorus/app-sdk";
import type { Row } from "./index.ts";

type Ops = {
  list(admin: boolean): Promise<Row[]>;
  press(host: string, name: string, action: string): Promise<Reply>;
  log(host: string, name: string, lines: number): Promise<Reply>;
};

const replied = async (r: Promise<Reply>) => {
  const [code, body] = (await r) as [number, any];
  if (code === 200) return body;
  throw Object.assign(new Error(String(body?.error ?? `status ${code}`)), { code: codes[code] ?? "unreachable" });
};

const codes: Record<number, string> = { 400: "bad_input", 403: "forbidden", 404: "not_found", 409: "conflict" };

export function tools(o: Ops): Tool[] {
  return [
    {
      name: "games",
      title: "List game servers",
      description:
        "Every game server on the mesh: host, name, port, status (online, offline, starting, stopping; down while its host is), " +
        "whether it can be started and stopped, and the address a player joins at over the tailnet. Admins also see the start and stop lines.",
      schema: { type: "object", properties: {} },
      read: true,
      run: async (_a, who) => ({ games: await o.list(who.admin) }),
    },
    {
      name: "game_power",
      title: "Start or stop a game server",
      description:
        "Press play or stop on a game server, as its button does: runs only the start or stop line set for it, on its host as that host's login. " +
        "Check games afterwards; a start shows starting until its port answers.",
      schema: {
        type: "object",
        properties: {
          host: { type: "string", description: "the game's host, as games lists it" },
          name: { type: "string", description: "the game's name" },
          action: { type: "string", enum: ["start", "stop"] },
        },
        required: ["host", "name", "action"],
      },
      destructive: true,
      run: (a) => replied(o.press(String(a.host ?? "").toLowerCase(), String(a.name ?? ""), String(a.action ?? ""))),
    },
    {
      name: "game_log",
      title: "A game server's output",
      description:
        "The last lines its start and stop lines printed on its host, each run headed by when and what ran. " +
        "The first stop when a start fails or a server won't come up. Admins only.",
      schema: {
        type: "object",
        properties: {
          host: { type: "string", description: "the game's host, as games lists it" },
          name: { type: "string", description: "the game's name" },
          lines: { type: "integer", description: "how many, up to 500", default: 50 },
        },
        required: ["host", "name"],
      },
      read: true,
      admin: true,
      run: (a) => replied(o.log(String(a.host ?? "").toLowerCase(), String(a.name ?? ""), Number(a.lines) || 50)),
    },
  ];
}
