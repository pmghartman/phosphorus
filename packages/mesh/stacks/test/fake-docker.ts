// a fake docker, its folder its first argument: each argv logged as a JSON line to
// docker.log there; compose up marks the project's services running in <project>.json,
// down and stop clear them, ps reads them back; a subcommand named in fail exits 1;
// compose's version the one in compose-version there, else 2.29.7
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.argv[2]!;
const argv = process.argv.slice(3);
appendFileSync(join(home, "docker.log"), JSON.stringify(argv) + "\n");

if (argv[0] === "version") {
  console.log("27.3.1");
  process.exit(0);
}
if (argv[0] !== "compose") process.exit(1);
if (argv[1] === "version") {
  const v = join(home, "compose-version");
  console.log(existsSync(v) ? readFileSync(v, "utf8").trim() : "2.29.7");
  process.exit(0);
}

const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const project = opt("-p")!;
const file = opt("-f");
// the subcommand: the first word after the global options
let i = 1;
while (i < argv.length && argv[i]!.startsWith("-")) i += 2;
const cmd = argv[i];
const fail = join(home, "fail");
if (existsSync(fail) && cmd === readFileSync(fail, "utf8").trim()) {
  console.error(`${cmd} failed`);
  process.exit(1);
}
const state = join(home, project + ".json");
const services = (): string[] =>
  file && existsSync(file) ? Object.keys((Bun.YAML.parse(readFileSync(file, "utf8")) as any).services) : [];

switch (cmd) {
  case "up":
    writeFileSync(state, JSON.stringify(services().map((s) => ({ Service: s, State: "running", Health: "" }))));
    console.log("started");
    break;
  case "down":
  case "stop":
    writeFileSync(state, "[]");
    break;
  case "ps":
    for (const r of existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : []) console.log(JSON.stringify(r));
    break;
  default:
    console.log(`${cmd} ok`);
}
