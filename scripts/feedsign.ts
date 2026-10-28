// feedsign: the release's app updates signed for the feed, each FILE's
// signature written to FILE.sig, with the key in UPDATE_SIGNING_KEY; -keygen
// prints a fresh pair for the repo's secret and variable, no password to keep
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { encrypted, generate, parsePublicKey, parseSecretKey } from "@phosphorus/minisign";

const args = process.argv.slice(2);
const die = (msg: string, code = 1): never => {
  console.error("feedsign:", msg);
  process.exit(code);
};
if (args.length === 1 && args[0] === "-keygen") {
  const k = generate();
  console.log(`secret UPDATE_SIGNING_KEY:\n${k.secret}\n\nvariable UPDATE_PUBKEY:\n${k.public}`);
  process.exit(0);
}
if (!args.length) die("usage: feedsign FILE... | feedsign -keygen", 2);
const key = process.env.UPDATE_SIGNING_KEY ?? "";
if (encrypted(key)) die("UPDATE_SIGNING_KEY is password protected; make a new one with feedsign -keygen");
let k;
try {
  k = parseSecretKey(key, "");
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
// the key the installed apps check against, when the release names it
const pub = process.env.FEED_PUBKEY;
if (pub) {
  let ok = false;
  try {
    ok = parsePublicKey(pub).id.equals(k!.id);
  } catch {}
  if (!ok) die("UPDATE_SIGNING_KEY isn't the key UPDATE_PUBKEY names; installed apps would refuse its updates");
}
for (const f of args) {
  try {
    writeFileSync(f + ".sig", k!.sign(readFileSync(f), basename(f)), { mode: 0o644 });
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  console.log("signed", f);
}
