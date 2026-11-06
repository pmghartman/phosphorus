// a mesh host's name: a DNS label, lowercase

const nameRe = /^[a-z0-9][a-z0-9-]{0,62}$/;

// a host's name as phosphorus takes it
export const validHost = (h: string) => nameRe.test(h);

// a DNS name's first label, as supervisor.sh derives SELF_HOST
export function hostOf(dns: string): string {
  const s = dns.replace(/\.$/, "").split(".")[0]!.toLowerCase();
  return s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
