/* marshal-writer.js — Écrivain Ruby Marshal 4.8.
 * Miroir exact du lecteur : même ordre d'enregistrement des objets et des symboles,
 * même encodage des entiers, chaînes de flottants et bignums d'origine conservées (raw)
 * => un arbre non modifié est réécrit octet pour octet.
 */
(function (G) {
  'use strict';
  const M = G.MarshalLib;
  const ENC = new TextEncoder();

  class Out {
    constructor() {
      this.a = new Uint8Array(1 << 16);
      this.n = 0;
    }
    grow(k) {
      if (this.n + k <= this.a.length) return;
      let s = this.a.length * 2;
      while (s < this.n + k) s *= 2;
      const b = new Uint8Array(s);
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
    byte(b) {
      this.grow(1);
      this.a[this.n++] = b;
    }
    raw(u8) {
      this.grow(u8.length);
      this.a.set(u8, this.n);
      this.n += u8.length;
    }
    long(x) {
      if (x === 0) return this.byte(0);
      if (x > 0 && x < 123) return this.byte(x + 5);
      if (x < 0 && x > -124) return this.byte((x - 5) & 0xff);
      const buf = [];
      for (let i = 1; i <= 8; i++) {
        buf.push(x & 0xff);
        x = Math.floor(x / 256);
        if (x === 0) { this.byte(i); break; }
        if (x === -1) { this.byte(256 - i); break; }
      }
      for (const b of buf) this.byte(b);
    }
    bytesL(u8) {
      this.long(u8.length);
      this.raw(u8);
    }
    result() {
      return this.a.slice(0, this.n);
    }
  }
  M.Out = Out;

  /** Formatage d'un Float identique à Ruby >= 1.9 (w_float / ruby_dtoa mode 0). */
  M.formatFloat = function (d) {
    if (Number.isNaN(d)) return 'nan';
    if (d === Infinity) return 'inf';
    if (d === -Infinity) return '-inf';
    if (d === 0) return Object.is(d, -0) ? '-0' : '0';
    const neg = d < 0;
    const [mant, e] = Math.abs(d).toExponential().split('e');
    const digits = mant.replace('.', '');
    const decpt = parseInt(e, 10) + 1;
    const digs = digits.length;
    let s = neg ? '-' : '';
    if (decpt < -3 || decpt > digs) {
      s += digits[0];
      if (digs > 1) s += '.' + digits.slice(1);
      s += 'e' + (decpt - 1);
    } else if (decpt > 0) {
      s += digits.slice(0, decpt);
      if (digs > decpt) s += '.' + digits.slice(decpt);
    } else {
      s += '0.' + '0'.repeat(-decpt) + digits;
    }
    return s;
  };

  const FIX_MIN = -1073741824, FIX_MAX = 1073741823;
  M.fitsFixnum = function (v) {
    if (typeof v === 'bigint') return v >= BigInt(FIX_MIN) && v <= BigInt(FIX_MAX);
    return v >= FIX_MIN && v <= FIX_MAX;
  };

  /**
   * Sérialise l'arbre.
   * @param root nœud racine
   * @param opts {track?: Set<node>} -> renvoie {bytes, positions: Map<node,[début,fin]>}
   */
  M.dump = function (root, opts) {
    opts = opts || {};
    const track = opts.track || null;
    const positions = track ? new Map() : null;
    const o = new Out();
    const symTab = new Map();
    const objTab = new Map();
    o.byte(4);
    o.byte(8);

    const reg = (n) => objTab.set(n, objTab.size);

    function wsym(n) {
      const idx = symTab.get(n.name);
      if (idx !== undefined) {
        o.byte(0x3b);
        o.long(idx);
        return;
      }
      symTab.set(n.name, symTab.size);
      if (n.iwrap && n.ivars && n.ivars.length) {
        o.byte(0x49);
        o.byte(0x3a);
        o.bytesL(n.bytes);
        wivars(n.ivars);
      } else {
        o.byte(0x3a);
        o.bytesL(n.bytes);
      }
    }
    function wivars(list) {
      o.long(list.length);
      for (const [k, v] of list) {
        wsym(k);
        w(v);
      }
    }
    function wbig(v) {
      o.byte(0x6c);
      let a = typeof v === 'bigint' ? v : BigInt(v);
      o.byte(a < 0n ? 0x2d : 0x2b);
      if (a < 0n) a = -a;
      const b = [];
      while (a > 0n) {
        b.push(Number(a & 0xffn));
        a >>= 8n;
      }
      if (b.length % 2) b.push(0);
      o.long(b.length / 2);
      o.raw(Uint8Array.from(b));
    }
    function wint(n) {
      if (n.big && n.raw) {
        o.byte(0x6c);
        o.raw(n.raw);
        reg(n);
      } else if (!M.fitsFixnum(n.v)) {
        wbig(n.v);
        reg(n);
      } else {
        o.byte(0x69);
        o.long(Number(n.v));
      }
    }

    function w(n) {
      const start = o.n;
      switch (n.t) {
        case 'nil': o.byte(0x30); break;
        case 'true': o.byte(0x54); break;
        case 'false': o.byte(0x46); break;
        case 'sym': wsym(n); break;
        case 'int':
          if (objTab.has(n)) { o.byte(0x40); o.long(objTab.get(n)); return; }
          wint(n);
          break;
        default:
          if (objTab.has(n)) {
            o.byte(0x40);
            o.long(objTab.get(n));
            return;
          }
          if (n.iwrap) {
            o.byte(0x49);
            if (!wbody(n, true)) wivars(n.ivars || []);
          } else {
            wbody(n, false);
          }
      }
      if (track && track.has(n) && !positions.has(n)) positions.set(n, [start, o.n]);
    }

    /** Écrit le corps d'un objet. Renvoie true si les ivars du préfixe I ont été consommées. */
    function wbody(n, ivp) {
      const hasPrefix = (n.extends && n.extends.length) || n.uclass;
      if (n.extends) for (const m of n.extends) { o.byte(0x65); wsym(m); }
      if (n.uclass) { o.byte(0x43); wsym(n.uclass); }
      switch (n.t) {
        case 'float': {
          reg(n);
          o.byte(0x66);
          o.bytesL(n.raw || ENC.encode(M.formatFloat(n.v)));
          break;
        }
        case 'str':
          reg(n);
          o.byte(0x22);
          o.bytesL(n.bytes);
          break;
        case 'array':
          reg(n);
          o.byte(0x5b);
          o.long(n.items.length);
          for (const it of n.items) w(it);
          break;
        case 'hash':
          reg(n);
          o.byte(n.def !== undefined ? 0x7d : 0x7b);
          o.long(n.entries.length);
          for (const [k, v] of n.entries) { w(k); w(v); }
          if (n.def !== undefined) w(n.def);
          break;
        case 'object':
          reg(n);
          o.byte(0x6f);
          wsym(n.cls);
          wivars(n.ivars);
          break;
        case 'struct':
          reg(n);
          o.byte(0x53);
          wsym(n.cls);
          o.long(n.members.length);
          for (const [k, v] of n.members) { wsym(k); w(v); }
          break;
        case 'userdef':
          o.byte(0x75);
          wsym(n.cls);
          o.bytesL(n.bytes);
          if (ivp && !hasPrefix) {
            wivars(n.ivars || []);
            reg(n);
            return true;
          }
          reg(n);
          break;
        case 'usermarshal':
          reg(n);
          o.byte(0x55);
          wsym(n.cls);
          w(n.data);
          break;
        case 'data':
          reg(n);
          o.byte(0x64);
          wsym(n.cls);
          w(n.data);
          break;
        case 'regexp':
          reg(n);
          o.byte(0x2f);
          o.bytesL(n.bytes);
          o.byte(n.opts & 0xff);
          break;
        case 'class':
          reg(n);
          o.byte(0x63);
          o.bytesL(n.bytes);
          break;
        case 'module':
          reg(n);
          o.byte(n.old ? 0x4d : 0x6d);
          o.bytesL(n.bytes);
          break;
        case 'int':
          wint(n);
          break;
        default:
          throw new Error('Type de nœud inconnu pour l\'écriture : ' + n.t);
      }
      return false;
    }

    w(root);
    const bytes = o.result();
    return track ? { bytes, positions } : bytes;
  };

  /** Fichier complet = préfixe + Marshal + suffixe */
  M.dumpFile = function (doc) {
    const body = M.dump(doc.root);
    const out = new Uint8Array(doc.prefix.length + body.length + doc.suffix.length);
    out.set(doc.prefix, 0);
    out.set(body, doc.prefix.length);
    out.set(doc.suffix, doc.prefix.length + body.length);
    return out;
  };

  /** Vérifie le round-trip : {ok, firstDiff, origLen, newLen} */
  M.roundTrip = function (doc) {
    const out = M.dump(doc.root);
    const a = doc.marshal;
    let firstDiff = -1;
    const n = Math.min(a.length, out.length);
    for (let i = 0; i < n; i++) if (a[i] !== out[i]) { firstDiff = i; break; }
    if (firstDiff < 0 && a.length !== out.length) firstDiff = n;
    return { ok: firstDiff < 0, firstDiff, origLen: a.length, newLen: out.length, bytes: out };
  };

  /* ---------- Export JSON (lecture seule / débogage) ---------- */
  M.toJSON = function (root) {
    const ids = new Map();
    let next = 1;
    function conv(n) {
      switch (n.t) {
        case 'nil': return null;
        case 'true': return true;
        case 'false': return false;
        case 'int': return typeof n.v === 'bigint' ? { $bigint: n.v.toString() } : n.v;
        case 'sym': return ':' + M.symName(n);
      }
      if (ids.has(n)) return { $ref: ids.get(n) };
      const id = next++;
      ids.set(n, id);
      let r;
      switch (n.t) {
        case 'float': r = Number.isFinite(n.v) ? n.v : { $float: M.formatFloat(n.v) }; return r;
        case 'str': {
          if (n.zs) return { $script: n.zs.text };
          const v = M.strView(n);
          return v.mode === 'hex' ? { $bytes: v.text } : v.text;
        }
        case 'array': r = n.items.map(conv); break;
        case 'hash': {
          const allSimple = n.entries.every(([k]) => k.t === 'sym' || k.t === 'str' || k.t === 'int');
          if (allSimple) {
            r = {};
            for (const [k, v] of n.entries) r[k.t === 'sym' ? ':' + M.symName(k) : k.t === 'int' ? String(k.v) : M.strView(k).text] = conv(v);
          } else r = { $hash: n.entries.map(([k, v]) => [conv(k), conv(v)]) };
          if (n.def !== undefined) r = { $hash: r, $default: conv(n.def) };
          break;
        }
        case 'object': {
          r = { $class: M.symName(n.cls), $id: id };
          for (const [k, v] of n.ivars) r[M.symName(k)] = conv(v);
          return r;
        }
        case 'struct': {
          r = { $struct: M.symName(n.cls), $id: id };
          for (const [k, v] of n.members) r[M.symName(k)] = conv(v);
          return r;
        }
        case 'userdef': {
          const d = M.decoderFor(n);
          if (d && d.name !== 'Table') return { $userdef: M.symName(n.cls), values: d.dec.decode(n.bytes) };
          return { $userdef: M.symName(n.cls), $bytes: M.toHex(n.bytes, '') };
        }
        case 'usermarshal': case 'data':
          return { ['$' + n.t]: M.symName(n.cls), data: conv(n.data) };
        case 'regexp': return { $regexp: M.summary(n, 1e9) };
        case 'class': return { $class_ref: M.latin1(n.bytes) };
        case 'module': return { $module_ref: M.latin1(n.bytes) };
      }
      if (n.uclass) r = { $uclass: M.symName(n.uclass), value: r };
      return r;
    }
    return JSON.stringify(conv(root), null, 2);
  };
})(typeof window !== 'undefined' ? window : globalThis);
