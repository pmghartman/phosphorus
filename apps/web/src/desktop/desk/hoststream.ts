// a host's window app streamed onto its desktop: the app runs on the host on its own
// display, its frames come over one socket to a worker that decodes each the moment it
// lands (WebCodecs, no jitter buffer) and draws it to the canvas off the main thread;
// pointer and keys go back over the same socket. The pointer itself is drawn here, in
// the host's shape, so it never lags

import { el } from '../../lib/dom.ts';
import { dk } from '../../lib/state.ts';
import { type DkWin, dkClose, dkSize, dkTaskIcon, dkWin } from '../windows.ts';
import { api, type Item, iconSrc } from './hosts.ts';
import { dkSay } from './wallpaper.ts';

// the worker: owns the socket and the decoder; nothing here may reach outside it
function streamWorker() {
  const g = self as any;
  let ws: WebSocket | undefined;
  let canvas: OffscreenCanvas | undefined;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  let dec: VideoDecoder | undefined;
  let gen = -1;
  let waitKey = true;
  const sentAt = new Map<number, number>();
  let decodeMs = 0;
  let frames = 0;
  let bytes = 0;
  let dropped = 0;
  // a measuring page's: each frame's size and when it was drawn, on one clock with the page's
  let debug = false;
  const sizes = new Map<number, number>();
  const post = (m: unknown) => g.postMessage(m);
  const reset = () => {
    waitKey = true;
    try {
      ws?.send(JSON.stringify(['key']));
    } catch {}
  };
  const configure = (avcc: Uint8Array, w: number, h: number) => {
    const codec = `avc1.${[1, 2, 3].map((i) => (avcc[i] ?? 0).toString(16).padStart(2, '0')).join('')}`;
    try {
      if (dec && dec.state !== 'closed') dec.close();
    } catch {}
    dec = new VideoDecoder({
      output: (f) => {
        const t = sentAt.get(f.timestamp);
        sentAt.delete(f.timestamp);
        if (t !== undefined) decodeMs = decodeMs * 0.9 + (performance.now() - t) * 0.1;
        if (canvas && (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight)) {
          canvas.width = f.displayWidth;
          canvas.height = f.displayHeight;
        }
        ctx?.drawImage(f, 0, 0);
        if (debug) {
          post({ t: 'drawn', at: performance.timeOrigin + performance.now(), bytes: sizes.get(f.timestamp) ?? 0 });
          sizes.delete(f.timestamp);
        }
        f.close();
        frames++;
      },
      error: (e) => {
        post({ t: 'note', s: `decoder: ${e.message}` });
        dec = undefined;
        gen = -1;
        reset();
      },
    });
    dec.configure({ codec, description: avcc, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
    post({ t: 'size', w, h, codec });
  };
  const onBin = (buf: ArrayBuffer) => {
    const b = new Uint8Array(buf);
    const d = new DataView(buf);
    const g2 = d.getUint16(2, true);
    if (b[0] === 1) {
      gen = g2;
      waitKey = true;
      configure(b.slice(8), d.getUint16(4, true), d.getUint16(6, true));
      return;
    }
    if (b[0] !== 2 || g2 !== gen || !dec || dec.state !== 'configured') return;
    const key = (b[1]! & 1) === 1;
    if (waitKey && !key) return;
    waitKey = false;
    // a decoder falling behind: skip to a fresh keyframe rather than queue
    if (dec.decodeQueueSize > 12) {
      dropped++;
      reset();
      return;
    }
    const seq = d.getUint32(4, true);
    const ts = seq * 1000;
    sentAt.set(ts, performance.now());
    if (sentAt.size > 120) sentAt.clear();
    bytes += b.length - 8;
    if (debug) sizes.set(ts, b.length - 8);
    try {
      dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: b.subarray(8) }));
    } catch (e: any) {
      post({ t: 'note', s: `decode: ${e?.message ?? e}` });
      reset();
    }
  };
  let statT: ReturnType<typeof setInterval> | undefined;
  g.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.t === 'open') {
      canvas = m.canvas ?? canvas;
      debug = !!m.debug;
      ctx ??= canvas?.getContext('2d', { alpha: false, desynchronized: true }) ?? null;
      ws?.close();
      gen = -1;
      const s = new WebSocket(m.url);
      ws = s;
      s.binaryType = 'arraybuffer';
      s.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const j = JSON.parse(ev.data);
            // the round trip on this worker's own clock
            if (j.t === 'pong') j.rtt = Math.round(performance.now() - j.n);
            post(j);
          } catch {}
        } else onBin(ev.data as ArrayBuffer);
      };
      s.onclose = (ev) => ws === s && post({ t: 'closed', code: ev.code });
      s.onopen = () => post({ t: 'open' });
      clearInterval(statT);
      let last = performance.now();
      statT = setInterval(() => {
        const now = performance.now();
        const sec = (now - last) / 1000;
        last = now;
        post({
          t: 'stats',
          fps: Math.round(frames / sec),
          kbps: Math.round((bytes * 8) / sec / 1000),
          decode: Math.round(decodeMs * 10) / 10,
          dropped,
        });
        frames = bytes = 0;
        try {
          if (s.readyState === 1) s.send(JSON.stringify(['p', now]));
        } catch {}
      }, 1000);
    } else if (m.t === 'send') {
      if (ws?.readyState === 1) ws.send(m.s);
    } else if (m.t === 'stop') {
      clearInterval(statT);
      ws?.close();
      try {
        dec?.close();
      } catch {}
      g.close();
    }
  };
}

let workerURL = '';
const newWorker = () => {
  workerURL ||= URL.createObjectURL(new Blob([`(${streamWorker})()`], { type: 'text/javascript' }));
  return new Worker(workerURL);
};

// --- the pointer's shape ------------------------------------------------------------------

const cursorNames: Record<string, string> = {
  left_ptr: 'default',
  arrow: 'default',
  top_left_arrow: 'default',
  xterm: 'text',
  ibeam: 'text',
  hand1: 'pointer',
  hand2: 'pointer',
  pointing_hand: 'pointer',
  watch: 'wait',
  left_ptr_watch: 'progress',
  cross: 'crosshair',
  tcross: 'crosshair',
  fleur: 'move',
  sb_h_double_arrow: 'ew-resize',
  h_double_arrow: 'ew-resize',
  sb_v_double_arrow: 'ns-resize',
  v_double_arrow: 'ns-resize',
  top_left_corner: 'nwse-resize',
  bottom_right_corner: 'nwse-resize',
  top_right_corner: 'nesw-resize',
  bottom_left_corner: 'nesw-resize',
  left_side: 'w-resize',
  right_side: 'e-resize',
  top_side: 'n-resize',
  bottom_side: 's-resize',
  crossed_circle: 'not-allowed',
  question_arrow: 'help',
  openhand: 'grab',
  closedhand: 'grabbing',
  dnd_copy: 'copy',
  blank: 'none',
};

const cssCursor = (m: { name?: string; png?: string; x?: number; y?: number }) => {
  if (m.name) {
    const n = cursorNames[m.name] ?? m.name;
    return CSS.supports('cursor', n) ? n : 'default';
  }
  if (m.png) return `url("data:image/png;base64,${m.png}") ${m.x ?? 0} ${m.y ?? 0}, default`;
  return 'default';
};

// --- the window -----------------------------------------------------------------------------

const mac = /Mac|iPhone|iPad/.test(navigator.platform);
// a Mac's command key is the host's control: its copy, paste and shortcuts where the hand expects them
const swapMeta = (code: string) =>
  !mac
    ? code
    : code.startsWith('Meta')
      ? code.replace('Meta', 'Control')
      : code.startsWith('Control')
        ? code.replace('Control', 'Meta')
        : code;
const swapKey = (key: string) => (!mac ? key : key === 'Meta' ? 'Control' : key === 'Control' ? 'Meta' : key);

const buttonOf = (b: number) => [1, 2, 3, 8, 9][b] ?? 1;
// the pixels encoded: the window's at the screen's ratio, kept to about 1440p's worth
const maxPixels = 2560 * 1440;

const fullOK = (async () => {
  try {
    return !!(await VideoDecoder.isConfigSupported({ codec: 'avc1.f4001f' })).supported;
  } catch {
    return false;
  }
})();

// a streamed app's window key, by the host and the app's id or path
const winKey = (host: string, at: string) => `stream:${host}:${at}`;

// what each stream window shows: the host, the pid it was attached to, the app's windows
const shown = new Map<DkWin, { host: string; pid: number; wids: Set<number> }>();
const streamsChanged = new Set<() => void>();
// told when a stream window opens, learns its app's windows or closes (hosttasks.ts)
export const onStreams = (f: () => void) => void streamsChanged.add(f);
const tellStreams = () => {
  for (const f of streamsChanged) f();
};

// the pids and host windows a host's streams show here already
export function streamedOn(host: string): { pids: Set<number>; wids: Set<number> } {
  const pids = new Set<number>();
  const wids = new Set<number>();
  for (const s of shown.values())
    if (s.host === host) {
      if (s.pid) pids.add(s.pid);
      for (const id of s.wids) wids.add(id);
    }
  return { pids, wids };
}

// a process already running on the host, from its task list: taken up where it runs
export type Attach = { pid: number; started: number; name: string; icon?: string };

// a window app opened, one already open (by its id) taken up again, or one running on the
// host attached to, in a phosphorus window of its own: moved, resized, snapped and minimized
// as any service's, the app sized to it
export function streamWin(host: string, it: Item | { id: string; name: string } | Attach) {
  if (typeof VideoDecoder === 'undefined' || typeof OffscreenCanvas === 'undefined')
    return dkSay('this browser has no WebCodecs: app streaming needs Chrome, Edge, Firefox 130 or Safari 26');
  if (!dk.desk) return;
  const byId = 'id' in it && !('kind' in it) ? it.id : '';
  const path = 'path' in it ? (it.path ?? '') : '';
  const attach = 'pid' in it ? it : undefined;
  const w = dkWin(winKey(host, byId || path || `pid:${attach?.pid}:${attach?.started}`), it.name, host, 'stream');
  if (!w) return;
  const seen = { host, pid: attach?.pid ?? 0, wids: new Set<number>() };
  shown.set(w, seen);
  tellStreams();
  dkSize(w, 960, 600);
  const head = w.head;
  const body = w.body;
  const title = head.querySelector('.tab-label')!;
  const taskTitle = w.task.querySelector('.dk-task-t');
  const named = (t: string) => {
    title.textContent = t;
    if (taskTitle) taskTitle.textContent = t;
    w.task.title = `${t} ${host}`;
  };
  // the app's own icon on its task, the window glyph while there's none
  dkTaskIcon(w.task, 'kind' in it ? iconSrc(host, it) : attach?.icon || '');
  const btns = head.querySelector('.dk-btns')!;
  const btn = (label: string, glyph: string) => {
    const b = Object.assign(el('button', 'dk-out hd-sbtn'), { type: 'button', title: label, ariaLabel: label });
    b.append(el('span', 'hd-w-glyph', glyph));
    btns.prepend(b);
    return b;
  };
  const pick = el('select', 'hd-app-wins');
  pick.hidden = true;
  head.insertBefore(pick, btns);
  const infoBtn = btn('stream stats', 'i');
  const sharpBtn = btn('sharp text: full colour, more cpu', 'Aa');

  const stage = el('div', 'hd-stage');
  stage.tabIndex = -1;
  const canvas = el('canvas', 'hd-canvas');
  const ime = Object.assign(el('textarea', 'hd-ime'), {
    autocapitalize: 'off',
    autocomplete: 'off',
    spellcheck: false,
    ariaLabel: `${it.name} keyboard`,
  });
  const say = el('div', 'hd-stream-say', 'opening');
  const stats = el('div', 'hd-stream-stats');
  stats.hidden = true;
  stage.append(canvas, ime, say, stats);
  body.replaceChildren(stage);

  const worker = newWorker();
  const off = canvas.transferControlToOffscreen();
  let id = byId;
  let streamW = 0;
  let streamH = 0;
  let ended = false;
  let tries = 0;
  let rtt = 0;
  let sharp = false;
  const send = (m: unknown[]) => worker.postMessage({ t: 'send', s: JSON.stringify(m) });

  const size = () => {
    const r = stage.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    const k = Math.min(dpr, Math.sqrt(maxPixels / Math.max(1, r.width * r.height)));
    return { w: Math.round(r.width * k), h: Math.round(r.height * k), k };
  };
  const open = (first: boolean) => {
    const { w, h, k } = size();
    const q: Record<string, string> = id
      ? { id }
      : attach
        ? { pid: String(attach.pid), started: String(attach.started), name: attach.name }
        : { path };
    Object.assign(q, {
      w: String(w),
      h: String(h),
      dpr: String(Math.round(k * 100) / 100),
      sw: String(Math.round(screen.width * k)),
      sh: String(Math.round(screen.height * k)),
      full: sharp ? '1' : '0',
    });
    // a capture rate other than 60, for a display that shows more: localStorage phos.stream.fps
    try {
      const fps = localStorage.getItem('phos.stream.fps');
      if (fps && /^\d{2,3}$/.test(fps)) q.fps = fps;
    } catch {}
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${api(host, 'stream', q)}`;
    const debug = !!(window as any).__phosStream;
    worker.postMessage(first ? { t: 'open', url, canvas: off, debug } : { t: 'open', url, debug }, first ? [off] : []);
  };
  void fullOK.then((ok) => {
    sharpBtn.hidden = !ok;
  });

  // the stream stopped with its window, however it goes
  w.onClose = () => {
    ended = true;
    worker.postMessage({ t: 'stop' });
    ro.disconnect();
    shown.delete(w);
    tellStreams();
  };
  const shut = () => {
    ended = true;
    dkClose(w);
  };
  worker.onmessage = (e) => {
    const m = e.data;
    switch (m.t) {
      case 'opening':
        say.textContent = `starting ${m.name} on ${host}`;
        break;
      case 'ready':
        id = m.id;
        tries = 0;
        say.hidden = true;
        if (m.title) named(m.title);
        // keyed by its id now, so taking it up again finds this window
        if (w.key !== winKey(host, id)) {
          dk.wins.delete(w.key);
          w.key = winKey(host, id);
          dk.wins.set(w.key, w);
        }
        break;
      case 'size':
        streamW = m.w;
        streamH = m.h;
        break;
      case 'title':
        named(m.s || it.name);
        break;
      case 'cursor':
        stage.style.cursor = cssCursor(m);
        break;
      case 'windows': {
        const list = (m.list as [number, string][]) ?? [];
        pick.hidden = list.length < 2;
        pick.replaceChildren(
          ...list.map(([wid, t]) => Object.assign(el('option', '', t || it.name), { value: String(wid) })),
        );
        pick.value = String(m.main);
        seen.wids = new Set(list.map(([wid]) => wid));
        tellStreams();
        break;
      }
      case 'clip':
        void navigator.clipboard?.writeText(m.s).catch(() => {});
        break;
      case 'note':
        dkSay(`${it.name}: ${m.s}`);
        break;
      case 'drawn':
        (window as any).__phosStream?.(m);
        break;
      case 'pong':
        rtt = m.rtt;
        break;
      case 'stats':
        stats.textContent = `${streamW}×${streamH} · ${m.fps} fps · ${(m.kbps / 1000).toFixed(1)} Mb/s · decode ${m.decode} ms · rtt ${rtt} ms${m.dropped ? ` · skipped ${m.dropped}` : ''}`;
        break;
      case 'taken':
        ended = true;
        say.hidden = false;
        say.replaceChildren(el('p', '', `${it.name} was opened in another window`));
        {
          const b = Object.assign(el('button', 'btn', 'show it here'), { type: 'button' });
          b.addEventListener('click', () => {
            ended = false;
            say.textContent = 'opening';
            open(false);
          });
          say.append(b);
        }
        break;
      case 'error':
      case 'exit':
      case 'ended': {
        ended = true;
        const msg = m.t === 'error' ? m.s : m.error || '';
        if (!msg && m.t !== 'error') return shut();
        say.hidden = false;
        say.replaceChildren(el('p', '', msg || `${it.name} closed`));
        if (m.log) say.append(el('pre', 'hd-stream-log', m.log));
        break;
      }
      case 'closed':
        if (ended) return;
        // the link dropped, not the app: back to it while the server keeps it
        if (id && tries++ < 5) {
          say.hidden = false;
          say.textContent = 'reconnecting';
          setTimeout(() => !ended && open(false), 500 * tries);
        } else if (!id) {
          say.hidden = false;
          say.textContent = `${host} didn't open ${it.name}`;
        }
        break;
    }
  };

  // --- input ---------------------------------------------------------------------------
  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.getBoundingClientRect();
    const w = streamW || r.width;
    const h = streamH || r.height;
    return [Math.round(((e.clientX - r.left) * w) / r.width), Math.round(((e.clientY - r.top) * h) / r.height)];
  };
  // each move as the mouse reports it (pointerrawupdate, in a secure page), not batched
  // to the next animation frame as pointermove is: up to a frame sooner on the host. The
  // pointer itself is drawn here from the host's shape; what it hovers answers sooner
  let lastAt = '';
  const move = (e: Event) => {
    const p = at(e as PointerEvent);
    const k = `${p[0]},${p[1]}`;
    if (k === lastAt) return;
    lastAt = k;
    send(['m', ...p]);
  };
  stage.addEventListener('onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove', move);
  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    ime.focus({ preventScroll: true });
    send(['m', ...at(e)]);
    send(['b', buttonOf(e.button), 1]);
  });
  stage.addEventListener('pointerup', (e) => {
    send(['m', ...at(e)]);
    send(['b', buttonOf(e.button), 0]);
  });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  let wx = 0;
  let wy = 0;
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      wx += e.deltaX * k;
      wy += e.deltaY * k;
      const nx = Math.trunc(wx / 100);
      const ny = Math.trunc(wy / 100);
      if (nx || ny) {
        wx -= nx * 100;
        wy -= ny * 100;
        send(['w', nx, ny]);
      }
    },
    { passive: false },
  );

  const held = new Set<string>();
  // a paste's keys held until the page's clipboard is on the host, so the app pastes it
  let pasting: unknown[][] | undefined;
  let pasteT: ReturnType<typeof setTimeout> | undefined;
  const flushPaste = () => {
    clearTimeout(pasteT);
    const q = pasting ?? [];
    pasting = undefined;
    for (const m of q) send(m);
  };
  const keyMsg = (e: KeyboardEvent, down: boolean): unknown[] => {
    const chord = e.ctrlKey || e.metaKey || (e.altKey && !e.getModifierState('AltGraph'));
    return ['k', down ? 1 : 0, swapMeta(e.code), swapKey(e.key), chord ? 1 : 0];
  };
  ime.addEventListener('keydown', (e) => {
    if (e.isComposing || e.key === 'Process' || e.key === 'Unidentified' || e.key === 'Dead') return;
    const paste = e.code === 'KeyV' && (mac ? e.metaKey : e.ctrlKey) && !e.altKey;
    held.add(e.code);
    if (paste) {
      pasting = [keyMsg(e, true)];
      pasteT = setTimeout(flushPaste, 150);
      return;
    }
    e.preventDefault();
    if (pasting) pasting.push(keyMsg(e, true));
    else send(keyMsg(e, true));
  });
  ime.addEventListener('keyup', (e) => {
    if (!held.delete(e.code)) return;
    e.preventDefault();
    if (pasting) pasting.push(keyMsg(e, false));
    else send(keyMsg(e, false));
  });
  ime.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = e.clipboardData?.getData('text/plain') ?? '';
    if (t) send(['clip', t]);
    flushPaste();
  });
  ime.addEventListener('compositionend', (e) => {
    if (e.data) send(['x', e.data]);
    ime.value = '';
  });
  ime.addEventListener('input', (e) => {
    const ie = e as InputEvent;
    // a phone's keyboard, which sends no key codes: its text typed as text
    if (!ie.isComposing && ie.inputType === 'insertText' && ie.data && !held.size) send(['x', ie.data]);
    if (!ie.isComposing) ime.value = '';
  });
  ime.addEventListener('blur', () => {
    for (const c of held) send(['k', 0, swapMeta(c), '', 0]);
    held.clear();
  });

  // --- the window's own buttons --------------------------------------------------------------
  let resizeT: ReturnType<typeof setTimeout> | undefined;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const { w, h } = size();
      if (w > 0 && h > 0) send(['r', w, h]);
    }, 80);
  });
  ro.observe(stage);
  infoBtn.addEventListener('click', () => {
    stats.hidden = !stats.hidden;
  });
  sharpBtn.addEventListener('click', () => {
    sharp = !sharp;
    sharpBtn.classList.toggle('on', sharp);
    send(['full', sharp ? 1 : 0]);
  });
  pick.addEventListener('change', () => {
    send(['raise', Number(pick.value)]);
    ime.focus({ preventScroll: true });
  });
  // the window's own buttons hand the keyboard back to the app
  for (const b of [sharpBtn, infoBtn]) b.addEventListener('click', () => ime.focus({ preventScroll: true }));
  w.onFocus = () => setTimeout(() => ime.focus({ preventScroll: true }), 0);
  body.addEventListener('pointerdown', (e) => {
    if (!(e.target as Element).closest('select')) setTimeout(() => ime.focus({ preventScroll: true }), 0);
  });
  // the close button asks the app to close, as its own would, and it may ask to save first;
  // the window goes anyway when it isn't up yet or doesn't answer. An app attached to was
  // running on the host before: it's let go instead, back on the host's screen, still running
  let asked = false;
  if (attach) w.node.querySelector('.dk-close')?.setAttribute('title', `stop showing it here: it runs on on ${host}`);
  w.holdClose = () => {
    if (ended || !id || asked) return false;
    asked = true;
    send([attach ? 'let-go' : 'close']);
    setTimeout(() => !ended && shut(), 3000);
    return true;
  };
  open(true);
  setTimeout(() => ime.focus({ preventScroll: true }), 0);
}
