// what the tests share: a socket collecting what it's sent, a temp dir for the records
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "@phosphorus/util";
import { get, logFile } from "../src/index.ts";

export const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `phos-code-${tag}-`));

// FakeConn a socket collecting what it's sent
export class FakeConn {
  msgs: Record<string, any>[] = [];
  id = "";
  text(s: string) {
    this.msgs.push(JSON.parse(s));
    return true;
  }
  open() {
    return true;
  }
  queued() {
    return 0;
  }
  close() {}

  find(pred: (m: Record<string, any>) => boolean) {
    return this.msgs.find(pred);
  }

  // wait for a message pred takes, what's missing thrown past ms with everything seen logged
  async wait(what: string, ms: number, pred: (m: Record<string, any>) => boolean): Promise<Record<string, any>> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = this.find(pred);
      if (m) return m;
      await sleep(50);
    }
    for (const m of this.msgs) console.log(JSON.stringify(m).slice(0, 400));
    console.log("record", JSON.stringify(get("pmh", this.id)[1]));
    try {
      console.log(await Bun.file(logFile(this.id)).text());
    } catch {}
    throw new Error(`no ${what}`);
  }
}
