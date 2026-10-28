// the claude skill for the mesh's own Code sessions, dropped in their skills
// folder: the plugin's files, its domain filled in as Claude Code fills the
// plugin's; no key in it, the connector doing the calling
import { deflateRawSync } from "node:zlib";
// each file imported so a compiled binary carries it; the test checks the list against the folder
import skillMD from "../../../plugin/skills/phosphorus/SKILL.md" with { type: "file" };
import chatMD from "../../../plugin/skills/phosphorus/references/chat.md" with { type: "file" };
import diagnoseMD from "../../../plugin/skills/phosphorus/references/diagnose.md" with { type: "file" };
import filesMD from "../../../plugin/skills/phosphorus/references/files.md" with { type: "file" };
import gitMD from "../../../plugin/skills/phosphorus/references/git.md" with { type: "file" };
import runMD from "../../../plugin/skills/phosphorus/references/run.md" with { type: "file" };
import serviceMD from "../../../plugin/skills/phosphorus/references/service.md" with { type: "file" };
import statusMD from "../../../plugin/skills/phosphorus/references/status.md" with { type: "file" };
import updateMD from "../../../plugin/skills/phosphorus/references/update.md" with { type: "file" };

// skillFiles each file's name in the zip and where it lives
export const skillFiles: Record<string, string> = {
  "phosphorus/SKILL.md": skillMD,
  "phosphorus/references/chat.md": chatMD,
  "phosphorus/references/diagnose.md": diagnoseMD,
  "phosphorus/references/files.md": filesMD,
  "phosphorus/references/git.md": gitMD,
  "phosphorus/references/run.md": runMD,
  "phosphorus/references/service.md": serviceMD,
  "phosphorus/references/status.md": statusMD,
  "phosphorus/references/update.md": updateMD,
};

// skill the zip for the mesh at base: the phosphorus folder at its root
export async function skill(base: string): Promise<Uint8Array> {
  const domain = base.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const files: Record<string, string> = {};
  for (const [name, path] of Object.entries(skillFiles)) files[name] = (await Bun.file(path).text()).replaceAll("${user_config.domain}", domain);
  return zipOf(files);
}

// zipOf files by name, deflated, dated now, as archive/zip wrote them
function zipOf(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts: Uint8Array[] = [], cd: Uint8Array[] = [];
  let off = 0;
  const hdr = (sig: number, n: number) => {
    const b = new Uint8Array(n);
    new DataView(b.buffer).setUint32(0, sig, true);
    return b;
  };
  for (const [name, body] of Object.entries(files)) {
    const data = enc.encode(body), nm = enc.encode(name);
    const packed = new Uint8Array(deflateRawSync(data));
    const fill = (b: Uint8Array, o: number) => {
      const v = new DataView(b.buffer);
      v.setUint16(o, 20, true);
      v.setUint16(o + 2, 0x800, true);
      v.setUint16(o + 4, 8, true);
      v.setUint16(o + 6, dosTime, true);
      v.setUint16(o + 8, dosDate, true);
      v.setUint32(o + 10, Bun.hash.crc32(data), true);
      v.setUint32(o + 14, packed.length, true);
      v.setUint32(o + 18, data.length, true);
      v.setUint16(o + 22, nm.length, true);
    };
    const lh = hdr(0x04034b50, 30), ch = hdr(0x02014b50, 46);
    fill(lh, 4);
    fill(ch, 6);
    new DataView(ch.buffer).setUint32(42, off, true);
    cd.push(ch, nm);
    parts.push(lh, nm, packed);
    off += 30 + nm.length + packed.length;
  }
  const cdLen = cd.reduce((n, b) => n + b.length, 0);
  const end = hdr(0x06054b50, 22);
  const v = new DataView(end.buffer);
  v.setUint16(8, cd.length / 2, true);
  v.setUint16(10, cd.length / 2, true);
  v.setUint32(12, cdLen, true);
  v.setUint32(16, off, true);
  return Buffer.concat([...parts, ...cd, end]);
}
