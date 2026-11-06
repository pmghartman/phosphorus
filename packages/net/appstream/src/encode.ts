// the encoder: ffmpeg grabbing the app's display, tuned for the shortest path from
// a changed pixel to a decoded one. No B-frames, no lookahead, a one-frame VBV so no
// frame waits on the rate control, one IDR per start and none after (a viewer that
// needs a picture gets a fresh encoder), each packet flushed the moment it's muxed

import { protoOfFeatures, protoOK, versionCmp } from "@phosphorus/afterglow";

export type Encoder = "nvenc" | "vaapi" | "x264";

export type Caps = {
  xvfb: boolean;
  ffmpeg: boolean;
  // the host's phosphorus (or a bun) that runs the agent, "" when none
  bun: string;
  dbus: boolean;
  encoders: Encoder[];
  // afterglow on the host, the path of one that serves --stdio: what streams its apps
  // when it's there (linuxsource.ts), the agent and ffmpeg when it isn't
  afterglow: string;
};

// where afterglow is on a Linux host: the home's afterglow updates, the release's seed
// in the home, then the package's
export const afterglowPaths = [
  "/var/lib/phosphorus/afterglow-update/*/afterglow",
  "/var/lib/phosphorus/afterglow/afterglow",
  "/usr/lib/phosphorus/afterglow/afterglow",
];

// where phosphorus is on a Linux host, the package's first; a bun of its own runs the agent as well
export const bunPaths = ["/usr/lib/phosphorus/bin/phosphorus", "/var/lib/phosphorus/bin/phosphorus"];

// what the host has, one shell line's answer
export const probeCmd = [
  "for c in Xvfb ffmpeg dbus-run-session; do command -v $c >/dev/null 2>&1 && echo have:$c; done",
  `for b in ${bunPaths.join(" ")} $(command -v phosphorus phos bun 2>/dev/null); do [ -x "$b" ] && { echo "bun:$b"; break; }; done`,
  "command -v ffmpeg >/dev/null 2>&1 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -oE 'h264_(nvenc|vaapi)' | sed 's/^/enc:/'",
  "[ -r /dev/dri/renderD128 ] && [ -w /dev/dri/renderD128 ] && echo dri",
  "command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1 && echo nvidia",
  // every afterglow's own word on what it serves (one built for another arch or a newer
  // glibc says nothing)
  `for a in ${afterglowPaths.join(" ")}; do [ -x "$a" ] && f=$("$a" --features 2>/dev/null) && echo "afterglow:$a $f"; done`,
  "true",
].join("; ");

export function parseCaps(out: string): Caps {
  const l = new Set(out.split(/\r?\n/).map((s) => s.trim()));
  const encoders: Encoder[] = [];
  if (l.has("enc:h264_nvenc") && l.has("nvidia")) encoders.push("nvenc");
  if (l.has("enc:h264_vaapi") && l.has("dri")) encoders.push("vaapi");
  encoders.push("x264");
  // afterglow:<path> afterglow <version> <features...>: the newest serving stdio in a
  // protocol this phosphorus speaks, one that doesn't left for ffmpeg
  let afterglow = "";
  let best = "";
  for (const line of l) {
    const m = /^afterglow:(\S+) afterglow (\S+) (.*)$/.exec(line);
    const words = m?.[3]!.split(/\s+/) ?? [];
    if (!m || !words.includes("stdio") || !protoOK(protoOfFeatures(words))) continue;
    if (!afterglow || versionCmp(m[2]!, best) > 0) {
      afterglow = m[1]!;
      best = m[2]!;
    }
  }
  return {
    xvfb: l.has("have:Xvfb"),
    ffmpeg: l.has("have:ffmpeg"),
    bun: [...l].find((s) => s.startsWith("bun:"))?.slice(4) ?? "",
    dbus: l.has("have:dbus-run-session"),
    encoders,
    afterglow,
  };
}

// what the host lacks, said as what to install, "" when nothing: the agent needs Xvfb and
// phosphorus (ffmpeg only for video), afterglow Xvfb alone
export function missing(c: Caps): string {
  const need = [!c.xvfb && "xvfb", !c.bun && !c.afterglow && "phosphorus"].filter(Boolean);
  if (!need.length) return "";
  return `app streaming needs ${need.join(" and ")} on the host${c.xvfb ? "" : " (apt install xvfb)"}`;
}

export type EncodeOpts = {
  display: string;
  auth: string;
  w: number;
  h: number;
  fps: number;
  kbps: number;
  enc: Encoder;
  // full-colour chroma: sharp text, software encode and decode only
  full: boolean;
};

export function ffmpegArgs(o: EncodeOpts): string[] {
  const w = o.w & ~1;
  const h = o.h & ~1;
  const vbv = Math.max(64, Math.round(o.kbps / o.fps));
  const a = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"];
  if (o.enc === "vaapi") a.push("-vaapi_device", "/dev/dri/renderD128");
  a.push(
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-f",
    "x11grab",
    "-draw_mouse",
    "0",
    "-framerate",
    String(o.fps),
    "-video_size",
    `${w}x${h}`,
    "-i",
    `${o.display}+0,0`,
  );
  const gop = ["-g", "100000", "-bf", "0", "-sc_threshold", "0"];
  switch (o.enc) {
    case "nvenc":
      a.push("-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-zerolatency", "1", "-delay", "0");
      a.push("-rc", "cbr", "-b:v", `${o.kbps}k`, "-maxrate", `${o.kbps}k`, "-bufsize", `${vbv}k`, "-forced-idr", "1");
      a.push("-pix_fmt", "yuv420p", ...gop);
      break;
    case "vaapi":
      a.push("-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-rc_mode", "CBR");
      a.push("-b:v", `${o.kbps}k`, "-maxrate", `${o.kbps}k`, "-bufsize", `${vbv}k`, ...gop);
      break;
    default:
      a.push("-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency");
      a.push("-pix_fmt", o.full ? "yuv444p" : "yuv420p", "-crf", "23");
      a.push("-maxrate", `${o.kbps}k`, "-bufsize", `${vbv}k`, ...gop);
  }
  a.push("-flush_packets", "1", "-flvflags", "no_duration_filesize+no_metadata", "-f", "flv", "-");
  return a;
}

// one word for sh, quoted when it must be
export const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// the encoder as one ssh command line
export const encodeCmd = (o: EncodeOpts) =>
  `exec env DISPLAY=${shq(o.display)} XAUTHORITY=${shq(o.auth)} ${ffmpegArgs(o).map(shq).join(" ")}`;
