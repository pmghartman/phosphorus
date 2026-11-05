// structured values as bytes, the same on the app's main process, the server and the page:
// what Electron's IPC carries (structured clone, less cycles), typed arrays copied once

function phosCodec(isNode) {
  const te = new TextEncoder();
  const td = new TextDecoder();
  const kinds = [
    Uint8Array,
    ArrayBuffer,
    null,
    Int8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    typeof BigInt64Array === "undefined" ? null : BigInt64Array,
    typeof BigUint64Array === "undefined" ? null : BigUint64Array,
    DataView,
  ];
  const NodeBuffer = isNode && typeof Buffer !== "undefined" ? Buffer : null;

  class Writer {
    constructor(n) {
      this.b = new Uint8Array(n || 256);
      this.d = new DataView(this.b.buffer);
      this.n = 0;
    }
    room(k) {
      if (this.n + k <= this.b.length) return;
      let len = this.b.length * 2;
      while (len < this.n + k) len *= 2;
      const nb = new Uint8Array(len);
      nb.set(this.b.subarray(0, this.n));
      this.b = nb;
      this.d = new DataView(nb.buffer);
    }
    u8(v) {
      this.room(1);
      this.b[this.n++] = v;
    }
    u32(v) {
      this.room(4);
      this.d.setUint32(this.n, v, true);
      this.n += 4;
    }
    f64(v) {
      this.room(8);
      this.d.setFloat64(this.n, v, true);
      this.n += 8;
    }
    str(s) {
      const max = s.length * 3;
      this.room(max + 4);
      const at = this.n;
      this.n += 4;
      let len;
      if (s.length < 64) {
        // short ascii, the common case, without the encoder's call
        len = 0;
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i);
          if (c > 127) {
            len = -1;
            break;
          }
          this.b[this.n + len++] = c;
        }
        if (len < 0) len = te.encodeInto(s, this.b.subarray(this.n)).written;
      } else len = te.encodeInto(s, this.b.subarray(this.n)).written;
      this.d.setUint32(at, len, true);
      this.n += len;
    }
    bytes(u8) {
      this.u32(u8.byteLength);
      this.room(u8.byteLength);
      this.b.set(u8, this.n);
      this.n += u8.byteLength;
    }
    done() {
      return this.b.subarray(0, this.n);
    }
  }

  function put(w, v, depth) {
    if (depth > 400) throw new Error("too deep to send, or circular");
    switch (typeof v) {
      case "undefined":
        return w.u8(0);
      case "boolean":
        return w.u8(v ? 3 : 2);
      case "number":
        if ((v | 0) === v && !(v === 0 && 1 / v < 0)) {
          w.u8(4);
          w.room(4);
          w.d.setInt32(w.n, v, true);
          w.n += 4;
          return;
        }
        w.u8(5);
        return w.f64(v);
      case "string":
        w.u8(6);
        return w.str(v);
      case "bigint":
        w.u8(15);
        return w.str(v.toString());
      case "function":
      case "symbol":
        // dropped as structured clone would refuse them; undefined keeps the call going
        return w.u8(0);
    }
    if (v === null) return w.u8(1);
    if (Array.isArray(v)) {
      w.u8(7);
      w.u32(v.length);
      for (let i = 0; i < v.length; i++) put(w, v[i], depth + 1);
      return;
    }
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
      let k = 0;
      if (v instanceof ArrayBuffer) k = 1;
      else if (NodeBuffer && NodeBuffer.isBuffer(v)) k = 0;
      else {
        k = kinds.indexOf(v.constructor);
        if (k < 0) k = 0;
      }
      w.u8(9);
      w.u8(k);
      w.bytes(k === 1 ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      return;
    }
    if (v instanceof Date) {
      w.u8(10);
      return w.f64(v.getTime());
    }
    if (v instanceof Map) {
      w.u8(11);
      w.u32(v.size);
      for (const [k, x] of v) {
        put(w, k, depth + 1);
        put(w, x, depth + 1);
      }
      return;
    }
    if (v instanceof Set) {
      w.u8(12);
      w.u32(v.size);
      for (const x of v) put(w, x, depth + 1);
      return;
    }
    if (v instanceof Error) {
      w.u8(13);
      w.str(String(v.name || "Error"));
      w.str(String(v.message || ""));
      w.str(String(v.stack || ""));
      return;
    }
    if (v instanceof RegExp) {
      w.u8(14);
      w.str(v.source);
      w.str(v.flags);
      return;
    }
    if (typeof v.toJSON === "function" && !isPlain(v)) return put(w, v.toJSON(), depth + 1);
    w.u8(8);
    const keys = Object.keys(v);
    w.u32(keys.length);
    for (let i = 0; i < keys.length; i++) {
      w.str(keys[i]);
      put(w, v[keys[i]], depth + 1);
    }
  }

  const isPlain = (v) => {
    const p = Object.getPrototypeOf(v);
    return p === null || p === Object.prototype;
  };

  class Reader {
    constructor(b, at) {
      this.b = b;
      this.d = new DataView(b.buffer, b.byteOffset, b.byteLength);
      this.n = at || 0;
    }
    u8() {
      return this.b[this.n++];
    }
    u32() {
      const v = this.d.getUint32(this.n, true);
      this.n += 4;
      return v;
    }
    f64() {
      const v = this.d.getFloat64(this.n, true);
      this.n += 8;
      return v;
    }
    str() {
      const len = this.u32();
      const at = this.n;
      this.n += len;
      if (len < 64) {
        let s = "";
        for (let i = at; i < at + len; i++) {
          const c = this.b[i];
          if (c > 127) return td.decode(this.b.subarray(at, at + len));
          s += String.fromCharCode(c);
        }
        return s;
      }
      return td.decode(this.b.subarray(at, at + len));
    }
  }

  function get(r) {
    const t = r.u8();
    switch (t) {
      case 0:
        return undefined;
      case 1:
        return null;
      case 2:
        return false;
      case 3:
        return true;
      case 4: {
        const v = r.d.getInt32(r.n, true);
        r.n += 4;
        return v;
      }
      case 5:
        return r.f64();
      case 6:
        return r.str();
      case 7: {
        const n = r.u32();
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = get(r);
        return a;
      }
      case 8: {
        const n = r.u32();
        const o = {};
        for (let i = 0; i < n; i++) {
          const k = r.str();
          o[k] = get(r);
        }
        return o;
      }
      case 9: {
        const k = r.u8();
        const len = r.u32();
        const copy = r.b.slice(r.n, r.n + len);
        r.n += len;
        if (k === 0 || k === 2) return NodeBuffer ? NodeBuffer.from(copy.buffer, 0, len) : copy;
        if (k === 1) return copy.buffer;
        const C = kinds[k] || Uint8Array;
        return C === DataView ? new DataView(copy.buffer) : new C(copy.buffer, 0, len / C.BYTES_PER_ELEMENT);
      }
      case 10:
        return new Date(r.f64());
      case 11: {
        const n = r.u32();
        const m = new Map();
        for (let i = 0; i < n; i++) {
          const k = get(r);
          m.set(k, get(r));
        }
        return m;
      }
      case 12: {
        const n = r.u32();
        const s = new Set();
        for (let i = 0; i < n; i++) s.add(get(r));
        return s;
      }
      case 13: {
        const name = r.str();
        const e = new Error(r.str());
        e.name = name;
        e.stack = r.str();
        return e;
      }
      case 14:
        return new RegExp(r.str(), r.str());
      case 15:
        return BigInt(r.str());
    }
    throw new Error(`bad value tag ${t}`);
  }

  // a frame: op, the webContents it's for, an id, then values
  const Head = 9;
  function frame(op, wc, id, values, size) {
    const w = new Writer(size || 64);
    w.room(Head);
    w.b[0] = op;
    w.d.setUint32(1, wc >>> 0, true);
    w.d.setUint32(5, id >>> 0, true);
    w.n = Head;
    if (values !== undefined) put(w, values, 0);
    return w.done();
  }
  function head(b) {
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { op: b[0], wc: d.getUint32(1, true), id: d.getUint32(5, true) };
  }
  function body(b) {
    if (b.byteLength <= Head) return undefined;
    return get(new Reader(b, Head));
  }
  // a frame whose body is raw bytes, a resource's
  function raw(op, wc, id, bytes) {
    const b = new Uint8Array(Head + bytes.byteLength);
    const d = new DataView(b.buffer);
    b[0] = op;
    d.setUint32(1, wc >>> 0, true);
    d.setUint32(5, id >>> 0, true);
    b.set(bytes, Head);
    return b;
  }

  return {
    Head,
    frame,
    head,
    body,
    raw,
    encode(v) {
      const w = new Writer();
      put(w, v, 0);
      return w.done();
    },
    decode(b) {
      return get(new Reader(b, 0));
    },
  };
}
