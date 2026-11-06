// Porkbun's API: the domain's nameservers and glue records, enough to point a
// domain at the mesh's own edge hosts in one step

export const PorkbunAPI = "https://api.porkbun.com/api/json/v3";

export type Keys = { apikey: string; secretapikey: string };
export type Glue = { host: string; v4: string[]; v6: string[] };
export type Nameserver = { name: string; ip: string };

export class RegistrarError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const why = (code: string, message: string, domain: string) => {
  if (code === "API_ACCESS_DISABLED")
    return `turn on API access for ${domain} at porkbun first: domain management, the domain's details, API access`;
  if (code === "INVALID_CREDENTIALS" || /invalid api key/i.test(message))
    return "porkbun refused the API key and secret";
  return message || code || "porkbun said no";
};

export class Porkbun {
  constructor(
    private keys: Keys,
    private base = PorkbunAPI,
    private fetcher: typeof fetch = fetch,
  ) {}

  // one call, the keys in the body as the API takes them; an ERROR thrown with its code
  private async call(path: string, body: Record<string, unknown> = {}, domain = ""): Promise<Record<string, any>> {
    let r: Response;
    try {
      r = await this.fetcher(`${this.base}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apikey: this.keys.apikey, secretapikey: this.keys.secretapikey, ...body }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new RegistrarError("unreachable", `porkbun not answering: ${(e as Error).message}`);
    }
    let o: Record<string, any> = {};
    try {
      o = (await r.json()) as Record<string, any>;
    } catch {}
    if (!r.ok || o.status !== "SUCCESS") {
      const code = typeof o.code === "string" ? o.code : `http ${r.status}`;
      throw new RegistrarError(code, why(code, typeof o.message === "string" ? o.message : "", domain));
    }
    return o;
  }

  // the keys checked, the address porkbun saw them from
  async ping(): Promise<string> {
    const o = await this.call("ping");
    return typeof o.yourIp === "string" ? o.yourIp : "";
  }

  async nameservers(domain: string): Promise<string[]> {
    const o = await this.call(`domain/getNs/${domain}`, {}, domain);
    return (Array.isArray(o.ns) ? o.ns : []).map((n: unknown) => String(n).toLowerCase().replace(/\.$/, ""));
  }

  async setNameservers(domain: string, ns: string[]): Promise<void> {
    await this.call(`domain/updateNs/${domain}`, { ns }, domain);
  }

  // the glue records, read from the new shape or the older host pairs
  async glue(domain: string): Promise<Glue[]> {
    const o = await this.call(`domain/getGlue/${domain}`, {}, domain);
    const out: Glue[] = [];
    const ips = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    if (Array.isArray(o.glue))
      for (const g of o.glue)
        if (g && typeof g.host === "string") out.push({ host: g.host.toLowerCase(), v4: ips(g.v4), v6: ips(g.v6) });
    if (!out.length && Array.isArray(o.hosts))
      for (const h of o.hosts)
        if (Array.isArray(h) && typeof h[0] === "string")
          out.push({ host: h[0].toLowerCase(), v4: ips(h[1]?.v4), v6: ips(h[1]?.v6) });
    return out;
  }

  // a host record made or replaced: sub the label under the domain, ns1 for ns1.<domain>
  async setGlue(domain: string, sub: string, ips: string[], exists: boolean): Promise<void> {
    await this.call(`domain/${exists ? "updateGlue" : "createGlue"}/${domain}/${sub}`, { ips }, domain);
  }
}

// the domain pointed at the mesh: a glue record per nameserver, then the
// nameservers themselves; what was done, a line each, for the page
export async function delegate(k: Keys, domain: string, ns: Nameserver[], base?: string, fetcher?: typeof fetch) {
  const p = new Porkbun(k, base, fetcher);
  const steps: string[] = [];
  const suffix = `.${domain}`;
  for (const n of ns) if (!n.name.endsWith(suffix)) throw new RegistrarError("name", `${n.name} isn't under ${domain}`);
  await p.ping();
  const have = new Map((await p.glue(domain)).map((g) => [g.host, g]));
  for (const n of ns) {
    const cur = have.get(n.name);
    if (cur && cur.v4.length === 1 && cur.v4[0] === n.ip) {
      steps.push(`${n.name} already points at ${n.ip}`);
      continue;
    }
    await p.setGlue(domain, n.name.slice(0, -suffix.length), [n.ip], !!cur);
    steps.push(`${cur ? "updated" : "made"} the host record ${n.name} at ${n.ip}`);
  }
  const want = ns.map((n) => n.name);
  const cur = await p.nameservers(domain);
  if (want.every((n) => cur.includes(n)) && cur.length === want.length) steps.push(`${domain} already uses them`);
  else {
    await p.setNameservers(domain, want);
    steps.push(`${domain} now uses ${want.join(" and ")}`);
  }
  return steps;
}
