// a stand-in afterglow for tests: the link's server end on a real loopback socket,
// recording what it was sent and answering as afterglow would. Its frame and config
// builders lay out messages as host/src/wire.rs writes them

import { In, LinkReader, message, Out } from "./afterglow/link.ts";

const u16 = (v: number) => [v & 0xff, v >> 8];

export const jsonMessage = (type: number, v: unknown) => message(type, JSON.stringify(v));

// a frame message as afterglow's shaper makes it: [type][key][gen][pad 4] AVCC
export const frameMessage = (gen: number, key: boolean, avcc: number[]) =>
  message(Out.frame, new Uint8Array([key ? 1 : 0, ...u16(gen), 0, 0, 0, 0, ...avcc]));

// a config message: [type][pad][gen][w][h] avcC
export const configMessage = (gen: number, w: number, h: number, avcc: number[]) =>
  message(Out.config, new Uint8Array([0, ...u16(gen), ...u16(w), ...u16(h), ...avcc]));

// a size message: [type][pad][gen][w][h]
export const sizeMessage = (gen: number, w: number, h: number) =>
  message(Out.size, new Uint8Array([0, ...u16(gen), ...u16(w), ...u16(h)]));

// a rect message: [type][flags][gen][seq u32][x][y][w][h] then the pixels
export const rectMessage = (gen: number, seq: number, r: [number, number, number, number], px: number[], flags = 0) =>
  message(
    Out.rect,
    new Uint8Array([
      flags,
      ...u16(gen),
      seq & 0xff,
      (seq >> 8) & 0xff,
      (seq >> 16) & 0xff,
      seq >>> 24,
      ...r.flatMap(u16),
      ...px,
    ]),
  );

// a cursor message: [type][visible][hot x][hot y][w][h] then the PNG
export const cursorMessage = (visible: boolean, x: number, y: number, w: number, h: number, png: number[]) =>
  message(Out.cursor, new Uint8Array([visible ? 1 : 0, ...u16(x), ...u16(y), ...u16(w), ...u16(h), ...png]));

export class FakeAfterglow {
  readonly server: Bun.TCPSocketListener<undefined>;
  readonly got: { type: number; body: Uint8Array }[] = [];
  private sock?: { write(b: Uint8Array): number };
  // the token the client said first
  hello = "";

  constructor(
    readonly token: string,
    private onMsg: (f: FakeAfterglow, type: number, body: Uint8Array) => void,
  ) {
    this.server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (s) => {
          this.sock = s;
        },
        data: (_s, d) => this.reader.feed(d),
      },
    });
  }

  get port() {
    return this.server.port;
  }

  private reader = new LinkReader((m) => {
    const type = m[0]!;
    const body = m.subarray(1);
    this.got.push({ type, body });
    if (type === In.hello) {
      this.hello = new TextDecoder().decode(body);
      // a wrong token gets no answer, as afterglow gives none
      if (this.hello !== this.token) return;
      this.send(jsonMessage(Out.ready, { version: "test", virtual_display: true, hostname: "box", running: false }));
      return;
    }
    this.onMsg(this, type, body);
  });

  send(m: Uint8Array) {
    this.sock?.write(m);
  }

  // the bodies of what it was sent of one type, in order
  sent(type: number) {
    return this.got.filter((g) => g.type === type);
  }

  stop() {
    this.server.stop(true);
  }
}
