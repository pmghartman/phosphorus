'use strict';
// <game>.<GAME_ZONE> to its host's tailnet IP, for the split DNS domain
// mesh.js keeps pointed here

const dgram = require('dgram');

const ZONE = (process.env.GAME_ZONE || 'phosphorus').toLowerCase();
const TTL_S = 5; // short, so a game moving hosts shows up fast
const RETRY_MS = 10000;
const PORT = Number(process.env.GAME_DNS_PORT || 53); // the only port tailscale split DNS speaks

// lowercased qname labels and where the question ends, null if malformed
function readQuestion(msg) {
  if (msg.length < 12 || msg.readUInt16BE(4) < 1) return null;
  const labels = [];
  let off = 12;
  for (;;) {
    if (off >= msg.length) return null;
    const len = msg[off];
    if (len === 0) { off += 1; break; }
    if (len > 63 || off + 1 + len > msg.length) return null;
    labels.push(msg.toString('latin1', off + 1, off + 1 + len).toLowerCase());
    off += 1 + len;
  }
  if (off + 4 > msg.length) return null;
  return { labels, qtype: msg.readUInt16BE(off), end: off + 4 };
}

function reply(msg, q, rcode, ip) {
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2);
  header[2] = 0x80 | (msg[2] & 0x78) | 0x04 | (msg[2] & 0x01); // QR, opcode, AA, RD
  header[3] = rcode;
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(ip ? 1 : 0, 6);
  const question = msg.subarray(12, q.end);
  if (!ip) return Buffer.concat([header, question]);
  const rr = Buffer.alloc(16);
  rr.writeUInt16BE(0xc00c, 0); // name: pointer to the question's
  rr.writeUInt16BE(1, 2); // A
  rr.writeUInt16BE(1, 4); // IN
  rr.writeUInt32BE(TTL_S, 6);
  rr.writeUInt16BE(4, 10);
  ip.split('.').forEach((o, i) => { rr[12 + i] = Number(o); });
  return Buffer.concat([header, question, rr]);
}

function answer(msg, lookup) {
  if (msg.length < 12 || (msg[2] & 0x80)) return null;
  const q = readQuestion(msg);
  if (!q) return null;
  if (msg[2] & 0x78) return reply(msg, q, 4); // NOTIMP: not a plain query
  if (q.labels[q.labels.length - 1] !== ZONE) return reply(msg, q, 5); // REFUSED
  const ip = q.labels.length === 2 ? lookup(q.labels[0]) : '';
  if (!ip) return reply(msg, q, 3); // NXDOMAIN
  // AAAA and the rest: name found, no such record
  return reply(msg, q, 0, q.qtype === 1 || q.qtype === 255 ? ip : '');
}

// lookup(name) -> IPv4 or '', bind(ip) every tick, rebinding on a change
function createGameDns(lookup, note) {
  let sock = null;
  let boundIp = '';
  let failedAt = 0;

  function bind(ip) {
    if (ip === boundIp && (sock || Date.now() - failedAt < RETRY_MS)) return;
    if (sock) { sock.close(); sock = null; }
    boundIp = ip;
    if (!ip) return;
    const s = dgram.createSocket('udp4');
    s.on('message', (msg, rinfo) => {
      let out = null;
      try { out = answer(msg, lookup); } catch {}
      if (out) s.send(out, rinfo.port, rinfo.address);
    });
    s.on('error', (err) => {
      note('dns', `can't serve .${ZONE} names on ${ip}:${PORT}, retrying: ${err.message}`);
      if (sock === s) { sock = null; failedAt = Date.now(); }
      s.close();
    });
    s.bind(PORT, ip, () => note('dns', `serving .${ZONE} names on ${ip}:${PORT}`));
    sock = s;
  }

  return { bind };
}

module.exports = { createGameDns, ZONE };
