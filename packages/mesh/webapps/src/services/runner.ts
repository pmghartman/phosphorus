// the ssh runner: the host's own sshd as the login, the script fed to sh
import { randomBytes } from "node:crypto";
import { Client, type ClientChannel } from "ssh2";
import { env, envInt, errText, SelfHost } from "@phosphorus/util";
import { seams, type Login } from "./mesh.ts";

export async function addrOf(host: string): Promise<{ host: string; port: number }> {
  if (host === (process.env.SELF_HOST ?? SelfHost)) return { host: env("HOST_SSH_HOST", "127.0.0.1"), port: envInt("HOST_SSH_PORT", 22) || 22 };
  const ip = await seams.ipOf(host);
  if (!ip) throw new Error(`can't find ${host} on the tailnet`);
  return { host: ip, port: 22 };
}

export function dial(host: string, login: Login): Promise<Client> {
  return addrOf(host).then((addr) => new Promise<Client>((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", (e) => {
      c.end();
      const msg = errText(e);
      reject(new Error(/authentication methods failed|unable to authenticate/i.test(msg) ? `the saved login for ${host} was refused` : `ssh to ${host}: ${msg}`));
    });
    c.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => login.pass)));
    c.connect({ host: addr.host, port: addr.port, username: login.user, password: login.pass, tryKeyboard: true, readyTimeout: 10_000 });
  }));
}

export async function sshRun(host: string, login: Login, text: string, onOut: (s: string) => void, timeoutMs: number): Promise<number> {
  const c = await dial(host, login);
  try {
    // the script by heredoc on sh's stdin, nothing of it in argv
    const delim = "PHOS_SVC_" + randomBytes(6).toString("hex");
    const cmd = `sh -s <<'${delim}'\n${text}\n${delim}\n`;
    const st = await new Promise<ClientChannel>((res, rej) => c.exec(cmd, (err, ch) => (err ? rej(err) : res(ch))));
    const dec = new TextDecoder();
    st.on("data", (b: Uint8Array) => onOut(dec.decode(b, { stream: true })));
    st.stderr.on("data", (b: Uint8Array) => onOut(dec.decode(b, { stream: true })));
    return await new Promise<number>((res, rej) => {
      let code = -1;
      const t = setTimeout(() => {
        rej(new Error(`the script ran past ${Math.round(timeoutMs / 1000)}s`));
        st.close();
      }, timeoutMs);
      st.on("exit", (x: unknown) => void (typeof x === "number" && (code = x)));
      st.on("close", (x: unknown) => {
        clearTimeout(t);
        res(typeof x === "number" ? x : code);
      });
    });
  } finally {
    c.end();
  }
}
