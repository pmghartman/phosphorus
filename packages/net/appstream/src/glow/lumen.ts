// lumen: glow's HTTP(S) side of GameStream against a host's Sunshine or Apollo on
// loopback. serverinfo, the five-step PIN pairing, the app list, and launch, resume
// and cancel, each one call. Written from the protocol's public description and
// what the host answers, nothing taken from Sunshine's or Moonlight's code

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { type Identity, publicKeyOf, signatureOf } from "./cert.ts";

export type Host = {
  addr: string;
  // the plain HTTP port (47989 by default) and its HTTPS one (47984)
  http: number;
  https: number;
  // the host's own certificate once paired, pinned on every HTTPS call
  cert?: string;
};

export type ServerInfo = {
  hostname: string;
  appversion: string;
  uniqueid: string;
  paired: boolean;
  currentgame: number;
  state: string;
  codecs: number;
  httpsPort: number;
  // Apollo's: it makes a virtual display per stream, so a host with no monitor streams
  virtualDisplay: boolean;
  // whose it is, from the serverinfo's own fields
  kind: "sunshine" | "apollo";
};

export type App = { id: number; title: string; hdr: boolean };

export class LumenError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? m[1]! : "";
};
const rootStatus = (xml: string) => {
  const m = /<root[^>]*status_code="(\d+)"[^>]*?(?:status_message="([^"]*)")?/.exec(xml);
  return m ? { code: Number(m[1]), msg: m[2] ?? "" } : { code: 200, msg: "" };
};

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

// one GET, its XML: over https with the client's certificate, the host's pinned
async function get(h: Host, id: Identity, secure: boolean, path: string, q: Record<string, string>, timeoutMs: number) {
  const qs = new URLSearchParams({ uniqueid: id.uniqueid, uuid: randomUUID(), ...q });
  const url = `${secure ? "https" : "http"}://${h.addr}:${secure ? h.https : h.http}${path}?${qs}`;
  const init: Record<string, any> = { signal: AbortSignal.timeout(timeoutMs) };
  // the host's own certificate, once known, the only one trusted: its name never
  // matches an address, so only the certificate itself is checked
  if (secure)
    init.tls = h.cert
      ? { cert: id.cert, key: id.key, ca: h.cert, rejectUnauthorized: true, checkServerIdentity: () => undefined }
      : { cert: id.cert, key: id.key, rejectUnauthorized: false };
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e: any) {
    throw new LumenError(0, `${h.addr}:${secure ? h.https : h.http} didn't answer: ${e?.message ?? e}`);
  }
  const xml = await res.text();
  if (res.status === 401 || res.status === 403)
    throw new LumenError(401, "the host doesn't know this client: pair first");
  if (!res.ok) throw new LumenError(res.status, `the host answered ${res.status}`);
  const st = rootStatus(xml);
  if (st.code !== 200) throw new LumenError(st.code, st.msg || `the host answered ${st.code}`);
  return xml;
}

export async function serverInfo(h: Host, id: Identity, secure = false, timeoutMs = 3000): Promise<ServerInfo> {
  const xml = await get(h, id, secure, "/serverinfo", {}, timeoutMs);
  const apolloish = /<VirtualDisplayCapable>|<VirtualDisplayDriverReady>|Apollo/i.test(xml);
  return {
    hostname: tag(xml, "hostname"),
    appversion: tag(xml, "appversion"),
    uniqueid: tag(xml, "uniqueid"),
    paired: tag(xml, "PairStatus") === "1",
    currentgame: Number(tag(xml, "currentgame")) || 0,
    state: tag(xml, "state"),
    codecs: Number(tag(xml, "ServerCodecModeSupport")) || 0,
    httpsPort: Number(tag(xml, "HttpsPort")) || h.https,
    virtualDisplay:
      /^(1|true)$/i.test(tag(xml, "VirtualDisplayCapable")) ||
      /^(1|true)$/i.test(tag(xml, "VirtualDisplayDriverReady")),
    kind: apolloish ? "apollo" : "sunshine",
  };
}

const aes = (key: Uint8Array, enc: boolean, data: Uint8Array) => {
  const c = enc ? createCipheriv("aes-128-ecb", key, null) : createDecipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
};
const sha256 = (...p: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const x of p) h.update(x);
  return new Uint8Array(h.digest());
};

// pairs this identity with the host under pin. The host holds the first step open
// until someone types the pin into it (its web page, or phosphorus on its behalf),
// so waitMs is long. Answers the host's certificate, to pin from now on
export async function pair(h: Host, id: Identity, pin: string, name = "phosphorus", waitMs = 180_000): Promise<string> {
  const salt = randomBytes(16);
  const key = sha256(salt, new TextEncoder().encode(pin)).slice(0, 16);
  const q = (o: Record<string, string>) => ({ devicename: name, updateState: "1", ...o });
  const unpair = () => get(h, id, false, "/unpair", {}, 3000).catch(() => {});
  // 1: our certificate, the host's back
  const x1 = await get(
    h,
    id,
    false,
    "/pair",
    q({ phrase: "getservercert", salt: hex(salt), clientcert: hex(new TextEncoder().encode(id.cert)) }),
    waitMs,
  );
  if (tag(x1, "paired") !== "1") throw new LumenError(409, "the host turned the pairing down");
  const serverCert = Buffer.from(tag(x1, "plaincert"), "hex").toString("utf8");
  if (!serverCert.includes("BEGIN CERTIFICATE")) {
    await unpair();
    throw new LumenError(409, "the host is already pairing another client");
  }
  const serverSig = signatureOf(serverCert);
  try {
    // 2: our challenge, the host's answer and challenge
    const challenge = randomBytes(16);
    const x2 = await get(h, id, false, "/pair", q({ clientchallenge: hex(aes(key, true, challenge)) }), 10_000);
    if (tag(x2, "paired") !== "1") throw new LumenError(409, "the host broke off the pairing");
    const resp = aes(key, false, unhex(tag(x2, "challengeresponse")));
    const serverHash = resp.slice(0, 32);
    const serverChallenge = resp.slice(32, 48);
    // 3: our answer to its challenge, its secret back
    const secret = randomBytes(16);
    const ours = sha256(serverChallenge, id.sig, secret);
    const x3 = await get(h, id, false, "/pair", q({ serverchallengeresp: hex(aes(key, true, ours)) }), 10_000);
    if (tag(x3, "paired") !== "1") throw new LumenError(409, "the host broke off the pairing");
    const ps = unhex(tag(x3, "pairingsecret"));
    const serverSecret = ps.slice(0, 16);
    const serverSign = ps.slice(16);
    // the host proves it knew the pin and holds its certificate's key
    const want = sha256(challenge, serverSig, serverSecret);
    if (!Buffer.from(want).equals(Buffer.from(serverHash)))
      throw new LumenError(403, "the pin was wrong, or something between here and the host answered");
    if (!verify("sha256", serverSecret, publicKeyOf(serverCert), serverSign))
      throw new LumenError(403, "the host's pairing secret isn't signed by its certificate");
    // 4: our secret, signed
    const signed = sign("sha256", secret, createPrivateKey(id.key));
    const x4 = await get(
      h,
      id,
      false,
      "/pair",
      q({ clientpairingsecret: hex(new Uint8Array(Buffer.concat([secret, signed]))) }),
      10_000,
    );
    if (tag(x4, "paired") !== "1") throw new LumenError(403, "the host didn't accept the pairing");
    // 5: the same over https, as a paired client
    const x5 = await get({ ...h, cert: serverCert }, id, true, "/pair", q({ phrase: "pairchallenge" }), 10_000);
    if (tag(x5, "paired") !== "1") throw new LumenError(403, "the host didn't accept the pairing over https");
  } catch (e) {
    await unpair();
    throw e;
  }
  return serverCert;
}

export async function apps(h: Host, id: Identity): Promise<App[]> {
  const xml = await get(h, id, true, "/applist", {}, 5000);
  const out: App[] = [];
  for (const m of xml.matchAll(/<App>([\s\S]*?)<\/App>/g)) {
    const a = m[1]!;
    out.push({
      id: Number(tag(a, "ID")),
      title: tag(a, "AppTitle")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"),
      hdr: tag(a, "IsHdrSupported") === "1",
    });
  }
  return out;
}

export type LaunchOpts = {
  app: number;
  w: number;
  h: number;
  fps: number;
  // the control stream's AES key and its id, ours for this stream
  rikey: Uint8Array;
  rikeyid: number;
  // ask Apollo for a virtual display sized to the stream: the host may have no monitor
  virtualDisplay?: boolean;
  scale?: number;
  resume?: boolean;
};

// starts (or takes up) the app's stream, answering where its RTSP setup is
export async function launch(h: Host, id: Identity, o: LaunchOpts): Promise<string> {
  const q: Record<string, string> = {
    appid: String(o.app),
    mode: `${o.w}x${o.h}x${o.fps}`,
    additionalStates: "1",
    sops: "0",
    rikey: hex(o.rikey),
    rikeyid: String(o.rikeyid),
    localAudioPlayMode: "0",
    surroundAudioInfo: String((0x3 << 16) | 2),
    remoteControllersBitmap: "0",
    gcmap: "0",
    gcpersist: "0",
  };
  if (o.virtualDisplay) q.virtualDisplay = "1";
  if (o.scale) q.scaleFactor = String(Math.round(o.scale * 100));
  const xml = await get(h, id, true, o.resume ? "/resume" : "/launch", q, 30_000);
  const ok = o.resume ? tag(xml, "resume") : tag(xml, "gamesession");
  if (ok === "0" || ok === "") throw new LumenError(500, `the host didn't ${o.resume ? "resume" : "launch"} the app`);
  return tag(xml, "sessionUrl0") || `rtsp://${h.addr}:48010`;
}

// quits the app the host is streaming
export async function cancel(h: Host, id: Identity): Promise<void> {
  await get(h, id, true, "/cancel", {}, 10_000);
}
