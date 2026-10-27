// a harness started on a host: setup run under sh -s first, then the command
// with its env on stdin; swapped for a local one by the tests
import { Claude, missing } from "./harness.ts";
import type { Creds } from "./script.ts";
import { dial, exec, exit, type Proc, run, Tail } from "./ssh.ts";

export type Spawner = (host: string, c: Creds, setup: string, command: string, env: string) => Promise<Proc>;

export async function sshSpawn(host: string, c: Creds, setup: string, command: string, env: string): Promise<Proc> {
  const cl = await dial(host, c.user, c.pass);
  const r = await run(cl, "sh -s", setup, 60_000);
  if (r.error || r.code !== 0) {
    cl.end();
    throw setupErr(host, r.code, r.out, r.error);
  }
  let st;
  try {
    st = await exec(cl, command);
  } catch (e) {
    cl.end();
    throw e;
  }
  const errs = new Tail();
  st.stderr.on("data", (d: Uint8Array) => errs.write(d));
  const done = exit(st);
  st.write(env);
  let killed = false;
  return {
    in: { write: (s) => void st.write(s), end: () => st.end() },
    out: st,
    errs,
    wait: () => done.then((code) => (cl.end(), code)),
    kill: () => {
      if (killed) return;
      killed = true;
      st.end();
      try {
        st.signal("TERM");
      } catch {}
      // a claude ignoring its closed stdin gone with the connection
      setTimeout(() => cl.end(), 5000).unref();
    },
  };
}

export let spawn: Spawner = sshSpawn;
// setSpawn another spawner in sshSpawn's place, the tests' local one
export const setSpawn = (f?: Spawner) => void (spawn = f ?? sshSpawn);

// setupErr why setup failed, a Windows host's shell named
export function setupErr(host: string, code: number, out: string, error?: string): Error {
  const low = out.toLowerCase();
  if (code === 127 && !low.includes("not found") && !low.includes("not recognized")) return new Error(missing(Claude, host));
  if (low.includes("not recognized") || low.includes("commandnotfound")) return new Error(`${host} runs Windows, which Code doesn't support yet`);
  if (error) return new Error(`setting up claude on ${host}: ${error}`);
  if (out.length > 400) out = out.slice(-400);
  return new Error(`setting up claude on ${host} failed (exit ${code}): ${out}`);
}
