// an ACME client for DNS-01: the account, an order over names, the challenge
// texts handed out to be served, the certificate chain back

import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject, sign, X509Certificate } from "node:crypto";
import { b64url, csr } from "./der.ts";

export const LetsEncrypt = "https://acme-v02.api.letsencrypt.org/directory";
export const LetsEncryptStaging = "https://acme-staging-v02.api.letsencrypt.org/directory";

// the account's key as a private JWK and its URL at the CA
export type Account = { key: Record<string, string>; kid: string };

export type Issued = { cert: string; key: string; names: string[]; notBefore: number; notAfter: number };

export type Hooks = {
  // the texts to serve at each _acme-challenge name, returned once they are served
  present(txt: Record<string, string[]>): Promise<void>;
  cleanup?(): Promise<void> | void;
  log?(m: string): void;
};

type Directory = { newNonce: string; newAccount: string; newOrder: string };

export class AcmeError extends Error {
  constructor(
    public status: number,
    public type: string,
    detail: string,
  ) {
    super(detail || type || `status ${status}`);
  }
}

const challengeName = (ident: string) => `_acme-challenge.${ident.replace(/^\*\./, "")}`;

export function newAccountKey(): Record<string, string> {
  return generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }) as Record<
    string,
    string
  >;
}

// RFC 7638: the public members in order, hashed
export function thumbprint(jwk: Record<string, string>): string {
  const pub = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64url(createHash("sha256").update(pub).digest());
}

export class Client {
  private dir?: Directory;
  private nonces: string[] = [];
  private key: KeyObject;
  private jwk: Record<string, string>;
  kid: string;

  constructor(
    public directoryURL: string,
    account: { key: Record<string, string>; kid?: string },
    private fetcher: typeof fetch = fetch,
  ) {
    this.jwk = account.key;
    this.key = createPrivateKey({ key: account.key, format: "jwk" });
    this.kid = account.kid ?? "";
  }

  private async directory(): Promise<Directory> {
    if (this.dir) return this.dir;
    const r = await this.fetcher(this.directoryURL, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new AcmeError(r.status, "directory", `${this.directoryURL}: status ${r.status}`);
    const d = (await r.json()) as Directory;
    if (!d.newNonce || !d.newAccount || !d.newOrder) throw new AcmeError(0, "directory", "directory incomplete");
    this.dir = d;
    return d;
  }

  private async nonce(): Promise<string> {
    const n = this.nonces.pop();
    if (n) return n;
    const r = await this.fetcher((await this.directory()).newNonce, {
      method: "HEAD",
      signal: AbortSignal.timeout(20_000),
    });
    const got = r.headers.get("replay-nonce");
    if (!got) throw new AcmeError(r.status, "nonce", "no nonce from the CA");
    return got;
  }

  // a signed POST, payload undefined for POST-as-GET; a stale nonce tried once more
  private async post(url: string, payload: unknown, jwkHeader = false, again = true): Promise<Response> {
    const protect: Record<string, unknown> = { alg: "ES256", nonce: await this.nonce(), url };
    if (jwkHeader) protect.jwk = { crv: this.jwk.crv, kty: this.jwk.kty, x: this.jwk.x, y: this.jwk.y };
    else protect.kid = this.kid;
    const p = b64url(JSON.stringify(protect));
    const body = payload === undefined ? "" : b64url(JSON.stringify(payload));
    const sig = sign("sha256", Buffer.from(`${p}.${body}`), { key: this.key, dsaEncoding: "ieee-p1363" });
    const r = await this.fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/jose+json" },
      body: JSON.stringify({ protected: p, payload: body, signature: b64url(sig) }),
      signal: AbortSignal.timeout(30_000),
    });
    const n = r.headers.get("replay-nonce");
    if (n) this.nonces.push(n);
    if (!r.ok) {
      let e: any = {};
      try {
        e = await r.json();
      } catch {}
      const type = String(e?.type ?? "");
      if (again && type.endsWith(":badNonce")) {
        this.nonces = [];
        return this.post(url, payload, jwkHeader, false);
      }
      throw new AcmeError(r.status, type.replace(/^urn:ietf:params:acme:error:/, ""), String(e?.detail ?? ""));
    }
    return r;
  }

  // the account made, or found again by its key
  async register(): Promise<Account> {
    const r = await this.post((await this.directory()).newAccount, { termsOfServiceAgreed: true }, true);
    const kid = r.headers.get("location");
    if (!kid) throw new AcmeError(r.status, "account", "no account URL from the CA");
    this.kid = kid;
    return { key: this.jwk, kid };
  }

  // a certificate over names, each proven by DNS-01 through hooks
  async order(names: string[], hooks: Hooks): Promise<Issued> {
    const log = hooks.log ?? (() => {});
    if (!this.kid) await this.register();
    const d = await this.directory();
    const made = await this.post(d.newOrder, { identifiers: names.map((n) => ({ type: "dns", value: n })) });
    const orderURL = made.headers.get("location") ?? "";
    let order: any = await made.json();
    const txt: Record<string, string[]> = {};
    const pending: { url: string; authz: string }[] = [];
    const print = thumbprint(this.jwk);
    for (const a of order.authorizations as string[]) {
      const authz: any = await (await this.post(a, undefined)).json();
      if (authz.status === "valid") continue;
      const ch = (authz.challenges as any[]).find((c) => c.type === "dns-01");
      if (!ch) throw new AcmeError(0, "challenge", `no dns-01 challenge for ${authz.identifier?.value}`);
      const name = challengeName(String(authz.identifier.value));
      const value = b64url(createHash("sha256").update(`${ch.token}.${print}`).digest());
      (txt[name] ??= []).push(value);
      pending.push({ url: ch.url, authz: a });
    }
    try {
      if (pending.length) {
        log(`serving ${Object.keys(txt).join(", ")} for the CA`);
        await hooks.present(txt);
        for (const p of pending) await this.post(p.url, {});
        for (const p of pending) await this.until(p.authz, "authorization");
      }
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const req = csr(privateKey, names);
      await this.post(order.finalize, { csr: b64url(req) });
      order = await this.until(orderURL, "order");
      const certURL = String(order.certificate ?? "");
      if (!certURL) throw new AcmeError(0, "order", "the order is valid but names no certificate");
      const pem = await (await this.post(certURL, undefined)).text();
      const leaf = new X509Certificate(pem);
      return {
        cert: pem.trim() + "\n",
        key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
        names,
        notBefore: Date.parse(leaf.validFrom),
        notAfter: Date.parse(leaf.validTo),
      };
    } finally {
      await hooks.cleanup?.();
    }
  }

  // an object polled until it is valid, a failed one thrown with its error
  private async until(url: string, what: string): Promise<any> {
    for (let i = 0; i < 60; i++) {
      const o: any = await (await this.post(url, undefined)).json();
      if (o.status === "valid") return o;
      if (o.status === "invalid") {
        const err = (o.challenges as any[] | undefined)?.find((c) => c.error)?.error ?? o.error;
        throw new AcmeError(0, what, err?.detail ? `${what} failed: ${err.detail}` : `${what} failed`);
      }
      await new Promise((r) => setTimeout(r, i < 5 ? 1000 : 3000));
    }
    throw new AcmeError(0, what, `${what} still pending after 3 minutes`);
  }
}
