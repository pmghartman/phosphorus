import { expect, test } from "bun:test";
import { createHash, createPublicKey, verify } from "node:crypto";
import { AcmeError, Client, csr, newAccountKey, thumbprint } from "@phosphorus/acme";

// a self-signed certificate for example.com and *.example.com, the chain the mock CA hands out
const pem = `-----BEGIN CERTIFICATE-----
MIIBqDCCAU6gAwIBAgIUFRDsMmzXIQHAqYom2FWRCFQBXDowCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLZXhhbXBsZS5jb20wHhcNMjYxMTA2MTkwNTEwWhcNMjcwMjA0
MTkwNTEwWjAWMRQwEgYDVQQDDAtleGFtcGxlLmNvbTBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABH1ZaqM4FcyYKM602Jvnxse0a2BfGgt5hjIEEQtrMlfJ0XD1Md6A
TDR9IG9iVErlF0UM+oV8yWLgQn987IExU0OjejB4MB0GA1UdDgQWBBQPPJvhXwQC
9TaeCcDmQvcnx7bLITAfBgNVHSMEGDAWgBQPPJvhXwQC9TaeCcDmQvcnx7bLITAP
BgNVHRMBAf8EBTADAQH/MCUGA1UdEQQeMByCC2V4YW1wbGUuY29tgg0qLmV4YW1w
bGUuY29tMAoGCCqGSM49BAMCA0gAMEUCIQDcT10khEYhq46AIK6GZysq1G3hIxon
e7yVi6x7OkWSngIgGH4i8t6HWh1E/xWB5OxTGSZOehdCliUCIK2Sle3+7IU=
-----END CERTIFICATE-----
`;

const b64 = (s: string) => Buffer.from(s, "base64url");

// a DER TLV: [tag, body, rest]
function tlv(b: Uint8Array): [number, Uint8Array, Uint8Array] {
  const tag = b[0]!;
  let n = b[1]!;
  let i = 2;
  if (n & 0x80) {
    const k = n & 0x7f;
    n = 0;
    for (let j = 0; j < k; j++) n = (n << 8) | b[2 + j]!;
    i = 2 + k;
  }
  return [tag, b.subarray(i, i + n), b.subarray(i + n)];
}

test("the request: a signed PKCS#10 with the names as subjectAltName", () => {
  const { privateKey } = require("node:crypto").generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = csr(privateKey, ["example.com", "*.example.com"]);
  const [tag, body] = tlv(der);
  expect(tag).toBe(0x30);
  const [, info, rest1] = tlv(body);
  const [, , rest2] = tlv(rest1);
  const [, sigBits] = tlv(rest2);
  // the info, tag and length included, is what was signed
  const signed = body.subarray(0, body.length - rest1.length);
  expect(verify("sha256", signed, createPublicKey(privateKey), sigBits.subarray(1))).toBe(true);
  const text = Buffer.from(info).toString("latin1");
  expect(text).toContain("example.com");
  expect(text).toContain("*.example.com");
});

test("thumbprint is RFC 7638's", () => {
  const jwk = { kty: "EC", crv: "P-256", x: "a", y: "b", d: "secret" };
  const want = Buffer.from(createHash("sha256").update('{"crv":"P-256","kty":"EC","x":"a","y":"b"}').digest()).toString(
    "base64url",
  );
  expect(thumbprint(jwk)).toBe(want);
});

// the mock CA: nonces checked, every JWS verified, dns-01 proven against what the client served
function mockCA() {
  const nonces = new Set<string>();
  const accounts = new Map<string, Record<string, string>>();
  let orders = 0;
  const challenges = new Map<string, { token: string; ident: string; status: string; kid: string }>();
  const authzs = new Map<string, { ident: string; chal: string; status: string }>();
  const orderStates = new Map<string, { authz: string[]; status: string; finalized: boolean }>();
  let served: Record<string, string[]> = {};
  let badNonceOnce = true;
  let port = 0;
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${port}`;
      const nonce = () => {
        const n = Math.random().toString(36).slice(2);
        nonces.add(n);
        return n;
      };
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json", "Replay-Nonce": nonce(), ...headers },
        });
      if (url.pathname === "/dir")
        return json(200, { newNonce: `${base}/nonce`, newAccount: `${base}/acct`, newOrder: `${base}/order` });
      if (url.pathname === "/nonce") return new Response(null, { status: 200, headers: { "Replay-Nonce": nonce() } });
      if (req.method !== "POST") return json(405, { type: "urn:ietf:params:acme:error:malformed" });
      const jws: any = await req.json();
      const prot = JSON.parse(b64(jws.protected).toString());
      expect(prot.alg).toBe("ES256");
      expect(prot.url).toBe(req.url);
      if (!nonces.delete(prot.nonce)) return json(400, { type: "urn:ietf:params:acme:error:badNonce" });
      // one stale nonce injected to see the client try again
      if (badNonceOnce && url.pathname === "/order") {
        badNonceOnce = false;
        return json(400, { type: "urn:ietf:params:acme:error:badNonce", detail: "stale" });
      }
      const jwk = prot.jwk ?? accounts.get(prot.kid);
      if (!jwk) return json(401, { type: "urn:ietf:params:acme:error:accountDoesNotExist" });
      const ok = verify(
        "sha256",
        Buffer.from(`${jws.protected}.${jws.payload}`),
        { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        b64(jws.signature),
      );
      if (!ok) return json(401, { type: "urn:ietf:params:acme:error:malformed", detail: "bad signature" });
      const payload = jws.payload ? JSON.parse(b64(jws.payload).toString()) : undefined;
      if (url.pathname === "/acct") {
        expect(payload.termsOfServiceAgreed).toBe(true);
        const kid = `${base}/acct/${accounts.size + 1}`;
        accounts.set(kid, prot.jwk);
        return json(201, { status: "valid" }, { Location: kid });
      }
      if (url.pathname === "/order") {
        const id = String(++orders);
        const authz = (payload.identifiers as { value: string }[]).map((i, k) => {
          const a = `${base}/authz/${id}-${k}`;
          const c = `${base}/chal/${id}-${k}`;
          challenges.set(c, { token: `tok-${id}-${k}`, ident: i.value, status: "pending", kid: prot.kid });
          authzs.set(a, { ident: i.value, chal: c, status: "pending" });
          return a;
        });
        orderStates.set(`${base}/order/${id}`, { authz, status: "pending", finalized: false });
        return json(
          201,
          { status: "pending", authorizations: authz, finalize: `${base}/order/${id}/finalize` },
          { Location: `${base}/order/${id}` },
        );
      }
      if (url.pathname.startsWith("/authz/")) {
        const a = authzs.get(req.url)!;
        return json(200, {
          status: a.status,
          identifier: { type: "dns", value: a.ident },
          challenges: [
            { type: "http-01", url: `${base}/nope`, token: "x" },
            { type: "dns-01", url: a.chal, token: challenges.get(a.chal)!.token, status: a.status },
          ],
        });
      }
      if (url.pathname.startsWith("/chal/")) {
        const c = challenges.get(req.url)!;
        const want = Buffer.from(
          createHash("sha256")
            .update(`${c.token}.${thumbprint(accounts.get(c.kid)!)}`)
            .digest(),
        ).toString("base64url");
        const name = `_acme-challenge.${c.ident.replace(/^\*\./, "")}`;
        const got = served[name] ?? [];
        c.status = got.includes(want) ? "valid" : "invalid";
        for (const a of authzs.values()) if (a.chal === req.url) a.status = c.status;
        return json(200, { type: "dns-01", status: c.status, url: req.url, token: c.token });
      }
      if (url.pathname.endsWith("/finalize")) {
        const o = orderStates.get(req.url.replace(/\/finalize$/, ""))!;
        expect(o.authz.every((a) => authzs.get(a)!.status === "valid")).toBe(true);
        const der = b64(payload.csr);
        expect(der[0]).toBe(0x30);
        expect(der.toString("latin1")).toContain("example.com");
        o.finalized = true;
        o.status = "processing";
        setTimeout(() => (o.status = "valid"), 50);
        return json(200, { status: o.status });
      }
      if (url.pathname.startsWith("/order/")) {
        const o = orderStates.get(req.url)!;
        return json(200, {
          status: o.status,
          authorizations: o.authz,
          ...(o.status === "valid" ? { certificate: `${base}/cert` } : {}),
        });
      }
      if (url.pathname === "/cert")
        return new Response(pem, {
          headers: { "Content-Type": "application/pem-certificate-chain", "Replay-Nonce": nonce() },
        });
      return json(404, { type: "urn:ietf:params:acme:error:malformed", detail: url.pathname });
    },
  });
  port = srv.port ?? 0;
  return {
    url: `http://127.0.0.1:${srv.port}/dir`,
    serve: (txt: Record<string, string[]>) => void (served = txt),
    stop: () => srv.stop(true),
    accounts,
  };
}

test("an order end to end: account, dns-01 for the apex and the wildcard, finalize, the chain", async () => {
  const ca = mockCA();
  try {
    const c = new Client(ca.url, { key: newAccountKey() });
    const acct = await c.register();
    expect(acct.kid).toMatch(/\/acct\/1$/);
    let presented: Record<string, string[]> = {};
    let cleaned = false;
    const got = await c.order(["example.com", "*.example.com"], {
      async present(txt) {
        presented = txt;
        ca.serve(txt);
      },
      cleanup() {
        cleaned = true;
      },
    });
    // both names prove at one TXT name, two values
    expect(Object.keys(presented)).toEqual(["_acme-challenge.example.com"]);
    expect(presented["_acme-challenge.example.com"]).toHaveLength(2);
    expect(cleaned).toBe(true);
    expect(got.cert).toContain("BEGIN CERTIFICATE");
    expect(got.key).toContain("BEGIN PRIVATE KEY");
    expect(got.names).toEqual(["example.com", "*.example.com"]);
    expect(new Date(got.notAfter).toISOString()).toBe("2027-02-04T19:05:10.000Z");
    // the same account again by its key and kid, no new registration
    const c2 = new Client(ca.url, acct);
    await c2.order(["example.com"], {
      present: async (txt) => ca.serve(txt),
    });
    expect(ca.accounts.size).toBe(1);
  } finally {
    ca.stop();
  }
});

test("a challenge the DNS never serves fails with the CA's word", async () => {
  const ca = mockCA();
  try {
    const c = new Client(ca.url, { key: newAccountKey() });
    const err = await c
      .order(["example.com"], { present: async () => ca.serve({}) })
      .then(() => undefined)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AcmeError);
    expect(String(err.message)).toContain("authorization failed");
  } finally {
    ca.stop();
  }
});
