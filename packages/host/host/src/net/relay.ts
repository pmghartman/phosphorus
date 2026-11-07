// WireGuard's datagrams over wss://<domain>/mesh/relay, for a host whose UDP
// never reaches the hub; opened on first use, closed after a quiet minute
export class Relay {
  private ws?: WebSocket;
  private open = false;
  private used = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private url: () => string,
    private onMessage: (msg: Uint8Array) => void,
  ) {}

  send(msg: Uint8Array) {
    this.used = Date.now();
    if (this.ws && this.open) {
      this.ws.send(msg as Uint8Array<ArrayBuffer>);
      return;
    }
    // a handshake retries every few seconds, so nothing is queued meanwhile
    if (!this.ws) this.connect();
  }

  get up() {
    return this.open;
  }

  private connect() {
    const url = this.url();
    if (!url) return;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.onMessage(new Uint8Array(e.data));
    };
    ws.onclose = ws.onerror = () => {
      if (this.ws === ws) {
        this.ws = undefined;
        this.open = false;
      }
    };
    this.timer ??= setInterval(() => {
      if (this.ws && Date.now() - this.used > 60_000) this.close();
    }, 15_000);
  }

  close() {
    const ws = this.ws;
    this.ws = undefined;
    this.open = false;
    try {
      ws?.close();
    } catch {}
  }
}
