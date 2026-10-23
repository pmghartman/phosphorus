import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('a linked mesh stays beside local files and is cleared on disconnect or switch', async () => {
  const original = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, setTimeout: globalThis.setTimeout };
  const calls = [];
  const sockets = [];
  const timers = [];
  let vault = { hosts: { linux: { user: 'ryan', pass: '' } } };
  class Socket {
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.onclose?.(); }
    state() { this.onmessage({ data: JSON.stringify({ hosts: { linux: { files: { shares: [] } } }, tailnet: [{ name: 'linux', phosphorus: true }] }) }); }
  }
  globalThis.WebSocket = Socket;
  globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/me')) return Response.json({ user: 'ryan', vault });
    if (url.endsWith('/sidecar/mode')) return Response.json({ mode: 'local', server: 'https://another-mesh' });
    return Response.json({ ok: true });
  };
  try {
    const source = "const location = { protocol: 'http:', host: 'localhost' };\n" + (await readFile(new URL('../src/sulfur/host.js', import.meta.url), 'utf8')).replace('__ASSETS__', '{}').replace("import { themeFromStorage } from '../theme.js';", 'const themeFromStorage = () => {};') + '\n//# sourceURL=sulfur-host-fixture.mjs';
    const host = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    host.bootLocal({ mode: 'mesh', host: 'pc', user: 'tester', server: 'https://mesh', info: { files: { shares: [] } } });
    assert.equal(host.selfHost, 'pc');
    assert.deepEqual(host.dkLiveHosts(), ['pc']);
    await host.meshMe();
    sockets[0].state();
    assert.equal(host.hostUrl('pc', '/api/files/pc/read'), '/api/files/pc/read');
    assert.equal(host.hostUrl('linux', '/api/files/linux/read'), '/api/mesh/api/files/linux/read');
    assert.deepEqual(host.homeOnline(), ['pc']);
    assert.deepEqual(host.otherHosts(), ['linux']);
    assert.deepEqual(host.dkLiveHosts(), ['pc', 'linux']);
    await host.standalone.logIn('linux', 'another-login', '');
    assert.ok(calls.some((c) => c.url === '/api/mesh/api/me/vault'));
    vault = host.standalone.meshVault;
    sockets[0].onclose();
    assert.deepEqual(host.otherHosts(), []);
    assert.deepEqual(host.dkLiveHosts(), ['pc']);
    assert.equal(host.hostUrl('linux', '/api/files/linux/read'), '/api/mesh/api/files/linux/read', 'open remote tabs must not fall back to the local filesystem');
    timers.shift()();
    sockets[1].state();
    assert.equal(host.dk.creds.get('linux').user, 'another-login');
    await host.sidecarMode('link', 'https://another-mesh');
    assert.deepEqual(host.dkLiveHosts(), ['pc']);
    assert.equal(host.standalone.meshUser, '');
  } finally { Object.assign(globalThis, original); }
});
