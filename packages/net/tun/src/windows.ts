// windows: a wintun adapter and its session; the dll pinned beside phosphorus's tools
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { ADAPTER_GUID, guidBytes, RING_CAPACITY, type Setup, windowsScript } from "./layout.ts";
import { type Device, run } from "./run.ts";

const { u32, ptr: P, void: V } = FFIType;

const libs = new Map<string, ReturnType<typeof load>>();
const load = (dll: string) =>
  dlopen(dll, {
    WintunCreateAdapter: { args: [P, P, P], returns: P },
    WintunCloseAdapter: { args: [P], returns: V },
    WintunGetAdapterLUID: { args: [P, P], returns: V },
    WintunStartSession: { args: [P, u32], returns: P },
    WintunEndSession: { args: [P], returns: V },
    WintunGetReadWaitEvent: { args: [P], returns: P },
    WintunAllocateSendPacket: { args: [P, u32], returns: P },
    WintunSendPacket: { args: [P, P], returns: V },
  }).symbols;
const wintun = (dll: string) => {
  let l = libs.get(dll);
  if (!l) libs.set(dll, (l = load(dll)));
  return l;
};

const wstr = (s: string) => Buffer.from(s + "\0", "utf16le");

export async function openWindows(s: Setup & { dll: string; port: number }): Promise<Device> {
  let w: ReturnType<typeof load>;
  try {
    w = wintun(s.dll);
  } catch (e) {
    throw new Error(`couldn't load ${s.dll}: ${(e as Error).message}`);
  }
  const adapter = w.WintunCreateAdapter(wstr(s.name), wstr("Phosphorus"), guidBytes(ADAPTER_GUID));
  if (!adapter) throw new Error(`couldn't make the wintun adapter ${s.name} (needs admin)`);
  let session: ReturnType<typeof w.WintunStartSession> = null;
  try {
    session = w.WintunStartSession(adapter, RING_CAPACITY);
    if (!session) throw new Error("couldn't start a wintun session");
    const event = w.WintunGetReadWaitEvent(session);
    if (!event) throw new Error("wintun gave no read event");
    const luid = new BigUint64Array(1);
    w.WintunGetAdapterLUID(adapter, luid);
    const script = windowsScript({ ...s, luid: luid[0]! });
    const name = (await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script])) || s.name;
    const sess = session;
    return {
      name,
      reader: { os: "win32", lib: s.dll, session: Number(sess), event: Number(event) },
      unwrap: (b) => b,
      write(pkt) {
        // a full ring drops the packet, as any link would
        const p = w.WintunAllocateSendPacket(sess, pkt.length);
        if (!p) return false;
        new Uint8Array(toArrayBuffer(p, 0, pkt.length)).set(pkt);
        w.WintunSendPacket(sess, p);
        return true;
      },
      close() {
        w.WintunEndSession(sess);
        w.WintunCloseAdapter(adapter);
      },
    };
  } catch (e) {
    if (session) w.WintunEndSession(session);
    w.WintunCloseAdapter(adapter);
    throw e;
  }
}
