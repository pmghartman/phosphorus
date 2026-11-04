// ignite: glow's RTSP setup of a stream the host launched. OPTIONS, DESCRIBE, a SETUP
// each for audio, video and control (their ports, the video ping's payload and the
// control connect's data back), ANNOUNCE with the stream's terms, PLAY. The host
// answers each request on its own TCP connection and closes it

export type Terms = {
  w: number;
  h: number;
  fps: number;
  kbps: number;
  // one RTP payload's size: on loopback as large as the host takes, so a frame is
  // a few datagrams, not hundreds
  packetSize: number;
  // parity packets the host must add per FEC block at least: none on loopback
  minFec: number;
  // full-colour chroma
  yuv444: boolean;
  slices: number;
};

export type Setup = {
  session: string;
  videoPort: number;
  controlPort: number;
  audioPort: number;
  // the bytes the video ping carries, so the host knows the ping is ours
  ping: Uint8Array | undefined;
  // the 32-bit value the control connect carries
  connectData: number;
  // the host's SDP from DESCRIBE, its feature flags in it
  sdp: string;
  // whether the host takes the newer control encryption
  controlV2: boolean;
};

type Res = { status: number; headers: Record<string, string>; body: string };

export function parseResponse(text: string): Res | undefined {
  const end = text.indexOf("\r\n\r\n");
  if (end < 0) return;
  const lines = text.slice(0, end).split("\r\n");
  const m = /^RTSP\/1\.0 (\d+)/.exec(lines[0] ?? "");
  if (!m) throw new Error(`not an RTSP answer: ${lines[0]}`);
  const headers: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  const body = text.slice(end + 4);
  const want = Number(headers["content-length"] ?? -1);
  if (want >= 0 && Buffer.byteLength(body) < want) return;
  return { status: Number(m[1]), headers, body };
}

// one request on its own connection, its answer once the host closes or it's whole
async function request(host: string, port: number, msg: string, timeoutMs = 10_000): Promise<Res> {
  return await new Promise<Res>((ok, no) => {
    let buf = "";
    let done = false;
    const finish = (r: Res | Error) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      r instanceof Error ? no(r) : ok(r);
    };
    const t = setTimeout(() => finish(new Error("the host's RTSP didn't answer")), timeoutMs);
    void Bun.connect({
      hostname: host,
      port,
      socket: {
        open(s) {
          s.setNoDelay(true);
          s.write(msg);
          s.flush();
        },
        data(s, d) {
          buf += Buffer.from(d).toString("utf8");
          try {
            const r = parseResponse(buf);
            if (r && r.headers["content-length"] !== undefined) {
              s.end();
              finish(r);
            }
          } catch (e) {
            s.end();
            finish(e as Error);
          }
        },
        close() {
          try {
            const r = parseResponse(buf.includes("\r\n\r\n") ? buf : `${buf}\r\n\r\n`);
            finish(r ?? new Error("the host closed RTSP without an answer"));
          } catch (e) {
            finish(e as Error);
          }
        },
        error(_s, e) {
          finish(e);
        },
        connectError(_s, e) {
          finish(e);
        },
      },
    }).catch((e) => finish(e));
  });
}

export function announceSdp(t: Terms, addr: string, controlV2: boolean): string {
  const a: [string, string | number][] = [
    ["x-nv-video[0].clientViewportWd", t.w],
    ["x-nv-video[0].clientViewportHt", t.h],
    ["x-nv-video[0].maxFPS", t.fps],
    ["x-nv-video[0].packetSize", t.packetSize],
    ["x-nv-video[0].rateControlMode", 4],
    ["x-nv-video[0].timeoutLengthMs", 7000],
    ["x-nv-video[0].framesWithInvalidRefThreshold", 0],
    ["x-nv-video[0].initialBitrateKbps", t.kbps],
    ["x-nv-video[0].initialPeakBitrateKbps", t.kbps],
    ["x-nv-vqos[0].bw.minimumBitrateKbps", t.kbps],
    ["x-nv-vqos[0].bw.maximumBitrateKbps", t.kbps],
    ["x-ml-video.configuredBitrateKbps", t.kbps],
    ["x-nv-vqos[0].fec.enable", 1],
    ["x-nv-vqos[0].videoQualityScoreUpdateTime", 5000],
    ["x-nv-vqos[0].qosTrafficType", 0],
    ["x-nv-aqos.qosTrafficType", 0],
    ["x-nv-general.featureFlags", 167],
    ["x-ml-general.featureFlags", controlV2 ? 0x3 : 0x1],
    ["x-ss-general.encryptionEnabled", controlV2 ? 0x1 : 0],
    ["x-nv-vqos[0].fec.minRequiredFecPackets", t.minFec],
    ["x-nv-vqos[0].bllFec.enable", 0],
    ["x-nv-vqos[0].drc.enable", 0],
    ["x-nv-general.enableRecoveryMode", 0],
    ["x-nv-video[0].videoEncoderSlicesPerFrame", t.slices],
    ["x-nv-clientSupportHevc", 0],
    ["x-nv-vqos[0].bitStreamFormat", 0],
    ["x-nv-video[0].dynamicRangeMode", 0],
    ["x-nv-video[0].maxNumReferenceFrames", 0],
    ["x-nv-video[0].clientRefreshRateX100", t.fps * 100],
    ["x-ss-video[0].chromaSamplingType", t.yuv444 ? 1 : 0],
    ["x-ss-video[0].intraRefresh", 0],
    ["x-nv-video[0].encoderCscMode", 0],
    ["x-nv-audio.surround.numChannels", 2],
    ["x-nv-audio.surround.channelMask", 3],
    ["x-nv-audio.surround.enable", 0],
    ["x-nv-audio.surround.AudioQuality", 0],
    ["x-nv-aqos.packetDuration", 5],
    ["x-nv-ri.useControlChannel", 1],
  ];
  let s = `v=0\r\no=android 0 14 IN IPv4 ${addr}\r\ns=NVIDIA Streaming Client\r\n`;
  for (const [k, v] of a) s += `a=${k}:${v} \r\n`;
  s += "t=0 0\r\nm=video 47998  \r\n";
  return s;
}

const portOf = (transport: string | undefined) => Number(/server_port=(\d+)/.exec(transport ?? "")?.[1] ?? 0);

// the whole setup against url (rtsp://addr:port), the stream's terms in ANNOUNCE
export async function ignite(url: string, t: Terms): Promise<Setup> {
  const u = /^rtsp:\/\/\[?([^\]/]+?)\]?:(\d+)/.exec(url);
  if (!u) throw new Error(`the host gave an RTSP address glow can't use: ${url}`);
  const host = u[1]!;
  const port = Number(u[2]);
  const base = `rtsp://${host}:${port}`;
  let cseq = 0;
  let session = "";
  const req = async (method: string, target: string, extra: Record<string, string> = {}, body = "") => {
    let m = `${method} ${target} RTSP/1.0\r\nCSeq: ${++cseq}\r\nX-GS-ClientVersion: 14\r\nHost: ${host}\r\n`;
    if (session) m += `Session: ${session}\r\n`;
    for (const [k, v] of Object.entries(extra)) m += `${k}: ${v}\r\n`;
    if (body) m += `Content-type: application/sdp\r\nContent-length: ${Buffer.byteLength(body)}\r\n`;
    m += `\r\n${body}`;
    const r = await request(host, port, m);
    if (r.status !== 200) throw new Error(`the host refused RTSP ${method} ${target}: ${r.status}`);
    return r;
  };
  await req("OPTIONS", base);
  const d = await req("DESCRIBE", base, {
    Accept: "application/sdp",
    "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT",
  });
  // bit 0 of what the host can encrypt: the control stream, under the v2 scheme
  const enc = Number(/x-ss-general\.encryptionSupported:\s*(\d+)/.exec(d.body)?.[1] ?? 0);
  const controlV2 = (enc & 0x1) !== 0;
  const setup = (id: string) =>
    req("SETUP", `streamid=${id}`, {
      Transport: "unicast;X-GS-ClientPort=50000-50001",
      "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT",
    });
  const a = await setup("audio/0/0");
  session = (a.headers.session ?? "").split(";")[0]!.trim();
  const v = await setup("video/0/0");
  const c = await setup("control/13/0");
  const pingHex = v.headers["x-ss-ping-payload"];
  const out: Setup = {
    session,
    audioPort: portOf(a.headers.transport),
    videoPort: portOf(v.headers.transport),
    controlPort: portOf(c.headers.transport),
    ping: pingHex ? new TextEncoder().encode(pingHex) : undefined,
    connectData: Number(c.headers["x-ss-connect-data"] ?? 0) >>> 0,
    sdp: d.body,
    controlV2,
  };
  await req("ANNOUNCE", "streamid=control/13/0", {}, announceSdp(t, host, controlV2));
  await req("PLAY", "/");
  return out;
}
