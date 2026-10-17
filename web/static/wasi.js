// a wasi command's console, served sandboxed beside its .wasm: stdout and stderr
// shown, a line of stdin typed, any import it wants past wasi stubbed
(() => {
  const q = new URLSearchParams(location.search);
  const hex = (v, d) => (/^#[0-9a-f]{3,8}$/i.test(v || '') ? v : d);
  document.documentElement.style.setProperty('--bg', hex(q.get('bg'), '#111'));
  document.documentElement.style.setProperty('--fg', hex(q.get('fg'), '#ddd'));
  const url = location.href.split('?')[0];
  const name = decodeURIComponent(location.pathname.split('/').pop());
  document.title = name;
  const out = document.getElementById('out');
  const say = (t, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = t; out.append(s); scrollTo(0, document.body.scrollHeight); };
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let mem;
  let stdin = new Uint8Array(0);
  class Exit { constructor(code) { this.code = code; } }
  const dv = () => new DataView(mem.buffer);
  const u8 = () => new Uint8Array(mem.buffer);
  const args = [name];
  const env = ['TERM=dumb'];
  const strs = (list, ptrs, buf) => {
    let at = buf;
    list.forEach((s, i) => { const b = enc.encode(`${s}\0`); dv().setUint32(ptrs + i * 4, at, true); u8().set(b, at); at += b.length; });
    return 0;
  };
  const sizes = (list, n, sz) => { dv().setUint32(n, list.length, true); dv().setUint32(sz, list.reduce((t, s) => t + enc.encode(s).length + 1, 0), true); return 0; };
  const wasi = {
    args_get: (p, b) => strs(args, p, b), args_sizes_get: (n, s) => sizes(args, n, s),
    environ_get: (p, b) => strs(env, p, b), environ_sizes_get: (n, s) => sizes(env, n, s),
    clock_res_get: (id, p) => { dv().setBigUint64(p, 1000n, true); return 0; },
    clock_time_get: (id, prec, p) => { dv().setBigUint64(p, BigInt(Math.round((id === 0 ? Date.now() : performance.now()) * 1e6)), true); return 0; },
    fd_write: (fd, iovs, n, wrote) => {
      let t = 0;
      for (let i = 0; i < n; i++) {
        const p = dv().getUint32(iovs + i * 8, true);
        const l = dv().getUint32(iovs + i * 8 + 4, true);
        if (fd === 1 || fd === 2) say(dec.decode(u8().slice(p, p + l), { stream: true }), fd === 2 ? 'err' : '');
        t += l;
      }
      dv().setUint32(wrote, t, true);
      return fd === 1 || fd === 2 ? 0 : 8;
    },
    fd_read: (fd, iovs, n, read) => {
      if (fd !== 0) return 8;
      let t = 0;
      for (let i = 0; i < n && stdin.length; i++) {
        const p = dv().getUint32(iovs + i * 8, true);
        const l = Math.min(dv().getUint32(iovs + i * 8 + 4, true), stdin.length);
        u8().set(stdin.subarray(0, l), p);
        stdin = stdin.subarray(l);
        t += l;
      }
      dv().setUint32(read, t, true);
      return 0;
    },
    fd_fdstat_get: (fd, p) => { if (fd > 2) return 8; u8().fill(0, p, p + 24); dv().setUint8(p, 2); return 0; },
    fd_prestat_get: () => 8, fd_prestat_dir_name: () => 8, fd_close: () => 0, fd_seek: () => 70, fd_sync: () => 0,
    path_open: () => 76, random_get: (p, l) => { crypto.getRandomValues(u8().subarray(p, p + l)); return 0; },
    sched_yield: () => 0, poll_oneoff: () => 52,
    proc_exit: (code) => { throw new Exit(code); },
  };
  // past wasi: functions answering ENOSYS, a memory or table where one's asked
  const fill = (i) => (i.kind === 'function' ? (i.module === 'wasi_snapshot_preview1' && wasi[i.name]) || (() => 52)
    : i.kind === 'memory' ? new WebAssembly.Memory({ initial: 256, maximum: 32768 })
      : i.kind === 'table' ? new WebAssembly.Table({ initial: 4096, element: 'anyfunc' }) : undefined);
  const start = async () => {
    out.textContent = '';
    try {
      const mod = await WebAssembly.compile(await (await fetch(url)).arrayBuffer());
      const real = {};
      for (const i of WebAssembly.Module.imports(mod)) (real[i.module] ||= {})[i.name] = fill(i);
      const inst = await WebAssembly.instantiate(mod, real);
      mem = inst.exports.memory || Object.values(real).flatMap(Object.values).find((v) => v instanceof WebAssembly.Memory);
      const main = inst.exports._start || inst.exports.main;
      if (!main) { say('no _start or main to run\n', 'err'); return; }
      const r = main();
      say(`\n[exited ${typeof r === 'number' ? r : 0}]\n`, 'dim');
    } catch (e) {
      if (e instanceof Exit) say(`\n[exited ${e.code}]\n`, 'dim');
      else say(`\n${e}\n`, 'err');
    }
  };
  document.getElementById('in').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    stdin = enc.encode(`${e.target.value}\n`);
    e.target.value = '';
    start();
  });
  start();
})();
