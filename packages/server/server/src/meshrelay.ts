// /mesh/relay: a host whose UDP never reaches the hub sends WireGuard's datagrams
// over this websocket, passed on to the hub's UDP port and its answers back
import * as peers from "@phosphorus/peers";
import { Notes } from "@phosphorus/util";
import { type Conn, type Ctx, upgrade } from "@phosphorus/wsock";
import type { udp } from "bun";
import { selfHost } from "./config.ts";
import { refuse } from "./http.ts";

const notes = new Notes("relay");
const maxRelays = 128;
// a WireGuard datagram is the mtu and its header, never more
const maxDatagram = 2048;
let open = 0;

// where the hub takes datagrams: this host's own port, else the hub's public one
function hubAt(): [string, number] | undefined {
  const c = peers.control.control();
  if (!c) return;
  if (c.host === selfHost) return ["127.0.0.1", peers.registry.WGPort];
  const ep = peers.control.hub(c)?.endpoint ?? "";
  const i = ep.lastIndexOf(":");
  return i > 0 ? [ep.slice(0, i), Number(ep.slice(i + 1))] : undefined;
}

export function meshRelay(c: Ctx): Response | undefined {
  const to = hubAt();
  if (!to) return refuse(503);
  if (open >= maxRelays) return refuse(503);
  const ok = upgrade(c, (ws) => void pipe(ws, to));
  return ok ? undefined : refuse(400);
}

async function pipe(ws: Conn, [host, port]: [string, number]) {
  open++;
  ws.keepAlive();
  let sock: udp.Socket<"uint8array"> | undefined;
  try {
    sock = await Bun.udpSocket<"uint8array">({
      hostname: host === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0",
      binaryType: "uint8array",
      socket: {
        data: (_s, buf) => {
          ws.binary(buf);
        },
      },
    });
  } catch (e) {
    notes.note("udp", `can't open the relay's socket: ${e}`);
    open--;
    ws.close(1011);
    return;
  }
  const s = sock;
  ws.onMessage((d, binary) => {
    if (binary && typeof d !== "string" && d.length <= maxDatagram) s.send(d, port, host);
  });
  ws.onClose(() => {
    open--;
    s.close();
  });
}
