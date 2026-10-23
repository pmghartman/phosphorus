const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const MATCHERS = [
  // C:\p\a.cpp(12,5): error C2065: 'x': undeclared identifier [C:\p\a.vcxproj]
  { re: /^\s*(.+?)\((\d+)(?:,(\d+))?(?:,\d+,\d+)?\)\s*:\s*(fatal error|error|warning)\s+([A-Z]+\d+)\s*:\s*(.*?)(?:\s+\[[^\]]+\])?\s*$/, f: 1, l: 2, c: 3, s: 4, code: 5, m: 6 },
  // src/a.c:12:5: error: expected ';' (gcc, clang, and go's file:line:col: msg)
  { re: /^(.+?\.[A-Za-z0-9+]+):(\d+):(\d+):\s*(fatal error|error|warning|note)?:?\s*(.*)$/, f: 1, l: 2, c: 3, s: 4, m: 5 },
  // CMake Error at CMakeLists.txt:12 (add_executable):
  { re: /^CMake (Error|Warning)(?: \(dev\))? at (.+?):(\d+)/, f: 2, l: 3, s: 1, m: 0 },
];

export function createBuildProblemMatcher({ host, absRoot, root, windows: win, onProblem = () => {} }) {
  const seen = new Set();
  const problems = [];
  let buf = '';
  let rustSev = '';
  let rustMsg = '';
  let cmakeAt = null;
  const norm = (p) => (win ? p.replace(/\//g, '\\').toLowerCase() : p);
  const base = norm(absRoot).replace(/[\\/]+$/, '');
  const sep = win ? '\\' : '/';
  // a path as the workspace names it, or null for one outside it
  const toRel = (p) => {
    let a = p.trim();
    if (!(win ? /^[A-Za-z]:[\\/]/.test(a) : a.startsWith('/'))) a = `${absRoot}${sep}${a}`;
    const n = norm(a);
    if (n !== base && !n.startsWith(base + sep)) return null;
    const rest = a.slice(base.length + 1).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
    const out = [];
    for (const s of rest) { if (s === '..') out.pop(); else out.push(s); }
    return out.length ? `${root}/${out.join('/')}` : null;
  };
  const push = (x) => {
    if (!x.rel) return;
    const sev = /error/i.test(x.sev || '') ? 'error' : /warn/i.test(x.sev || '') ? 'warning' : x.sev === 'note' ? 'info' : 'error';
    const key = `${x.rel}:${x.line}:${x.col}:${x.msg}`;
    if (seen.has(key)) return;
    seen.add(key);
    const problem = { rel: x.rel, line: x.line, col: x.col || 1, sev, msg: x.msg, code: x.code || '', host };
    problems.push(problem); onProblem(problem);
  };
  const line = (raw) => {
    const s = raw.replace(ANSI_RE, '').replace(/\r$/, '');
    // rust: "error[E0425]: msg" then "  --> src/main.rs:3:5"
    const rh = s.match(/^(error|warning)(\[\w+\])?: (.*)$/);
    if (rh) { rustSev = rh[1]; rustMsg = `${rh[2] ? `${rh[2].slice(1, -1)}: ` : ''}${rh[3]}`; return; }
    const ra = s.match(/^\s*--> (.+?):(\d+):(\d+)$/);
    if (ra && rustSev) { push({ rel: toRel(ra[1]), line: +ra[2], col: +ra[3], sev: rustSev, msg: rustMsg }); rustSev = ''; return; }
    if (cmakeAt && s.trim()) { push({ ...cmakeAt, msg: s.trim() }); cmakeAt = null; return; }
    for (const m of MATCHERS) {
      const x = s.match(m.re);
      if (!x) continue;
      if (m.m === 0) { cmakeAt = { rel: toRel(x[m.f]), line: +x[m.l], col: 1, sev: x[m.s] }; return; }
      if (m.s === 4 && m.re === MATCHERS[1].re && !x[m.s] && !/\.go$/.test(x[m.f])) return;
      push({ rel: toRel(x[m.f]), line: +x[m.l], col: +(x[m.c] || 1), sev: x[m.s] || 'error', code: m.code ? x[m.code] : '', msg: x[m.m] });
      return;
    }
  };
  return {
    problems,
    feed: (text) => {
      buf += text;
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const p of parts) line(p);
    },
    end: () => { if (buf) line(buf); buf = ''; },
  };
}

