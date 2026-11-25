/* marshal-reader.js — Lecteur Ruby Marshal 4.8 générique + fonctions utilitaires du modèle.
 *
 * Modèle de données (objets JS mutables, l'identité d'objet = identité Ruby) :
 *   {t:'nil'} {t:'true'} {t:'false'}
 *   {t:'int', v:number|bigint, big?:bool, raw?:Uint8Array}    ('i' ou 'l')
 *   {t:'float', v:number, raw?:Uint8Array}                     ('f', raw = chaîne d'origine)
 *   {t:'str', bytes:Uint8Array}
 *   {t:'sym', bytes:Uint8Array, name:string(latin1 des octets)}
 *   {t:'array', items:[node]}
 *   {t:'hash', entries:[[k,v]], def?:node}
 *   {t:'object', cls:sym, ivars:[[sym,node]]}
 *   {t:'struct', cls:sym, members:[[sym,node]]}
 *   {t:'userdef', cls:sym, bytes:Uint8Array}                   ('u', _dump/_load)
 *   {t:'usermarshal', cls:sym, data:node}                      ('U')
 *   {t:'data', cls:sym, data:node}                             ('d')
 *   {t:'regexp', bytes, opts}  {t:'class', bytes}  {t:'module', bytes, old?}
 * Attributs communs facultatifs :
 *   ivars + iwrap:true  -> variables d'instance portées par un préfixe 'I'
 *   uclass:sym          -> préfixe 'C' (sous-classe de String/Array/Hash/Regexp)
 *   extends:[sym]       -> préfixes 'e'
 *   refs:n              -> nombre de références (objlink '@')
 *   _o/_e               -> offsets début/fin dans le flux Marshal d'origine
 *   zs:{text, orig}     -> script zlib décompressé (Scripts.rxdata)
 */
(function (G) {
  'use strict';
  const M = (G.MarshalLib = G.MarshalLib || {});

  class MarshalError extends Error {
    constructor(message, offset, typeByte) {
      super(message);
      this.name = 'MarshalError';
      this.offset = offset;
      this.typeByte = typeByte;
    }
  }
  M.MarshalError = MarshalError;

  const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
  const UTF8 = new TextDecoder('utf-8');
  const ENC = new TextEncoder();

  function latin1(b) {
    let s = '';
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
    return s;
  }
  function fromLatin1(s) {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
  }
  function utf8OrNull(b) {
    try { return UTF8_FATAL.decode(b); } catch (e) { return null; }
  }
  function isAscii(b) {
    for (let i = 0; i < b.length; i++) if (b[i] > 0x7f) return false;
    return true;
  }
  function bytesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function toHex(b, sep) {
    sep = sep === undefined ? ' ' : sep;
    const out = new Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out.join(sep);
  }
  function parseHex(s) {
    const clean = s.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
    if (clean.length % 2) throw new Error('Nombre impair de chiffres hexadécimaux');
    const u = new Uint8Array(clean.length / 2);
    for (let i = 0; i < u.length; i++) u[i] = parseInt(clean.substr(i * 2, 2), 16);
    return u;
  }
  M.latin1 = latin1;
  M.fromLatin1 = fromLatin1;
  M.utf8OrNull = utf8OrNull;
  M.utf8 = (b) => UTF8.decode(b);
  M.encodeUtf8 = (s) => ENC.encode(s);
  M.isAscii = isAscii;
  M.bytesEqual = bytesEqual;
  M.toHex = toHex;
  M.parseHex = parseHex;

  M.TYPE_NAMES = {
    0x30: 'nil', 0x54: 'true', 0x46: 'false', 0x69: 'Fixnum (i)', 0x6c: 'Bignum (l)', 0x66: 'Float (f)',
    0x22: 'String (")', 0x3a: 'Symbol (:)', 0x3b: 'Symlink (;)', 0x40: 'Objlink (@)', 0x5b: 'Array ([)',
    0x7b: 'Hash ({)', 0x7d: 'Hash+défaut (})', 0x6f: 'Object (o)', 0x49: 'Ivars (I)', 0x53: 'Struct (S)',
    0x43: 'UserClass (C)', 0x75: 'UserDef (u)', 0x55: 'UserMarshal (U)', 0x65: 'Extended (e)',
    0x2f: 'Regexp (/)', 0x63: 'Class (c)', 0x6d: 'Module (m)', 0x4d: 'Module ancien (M)', 0x64: 'Data (d)',
  };
  M.typeByteName = function (b) {
    if (b === undefined || b === null) return '?';
    const ch = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·';
    return `0x${b.toString(16).padStart(2, '0')} '${ch}'` + (M.TYPE_NAMES[b] ? ` = ${M.TYPE_NAMES[b]}` : ' (type inconnu)');
  };

  function parseFloatBytes(b) {
    let end = b.indexOf(0);
    if (end < 0) end = b.length;
    const s = latin1(b.subarray(0, end));
    if (s === 'inf') return Infinity;
    if (s === '-inf') return -Infinity;
    if (s === 'nan') return NaN;
    const v = Number(s);
    if (!Number.isNaN(v)) return v;
    const p = parseFloat(s);
    if (!Number.isNaN(p)) return p;
    throw new Error('Flottant illisible: ' + JSON.stringify(s));
  }
  M.parseFloatBytes = parseFloatBytes;

  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
  function normInt(v) {
    return v <= MAX_SAFE && v >= -MAX_SAFE ? Number(v) : v;
  }
  M.normInt = normInt;

  /**
   * Parse un flux Marshal commençant par 04 08.
   * @returns {{root, end, stats}}
   */
  function parse(bytes) {
    let pos = 0;
    const syms = [];
    const objs = [];
    let ivConsumed = false;
    const stats = { strings: 0, encStrings: 0, nodes: 0 };

    const fail = (msg, off, tb) => {
      throw new MarshalError(msg, off === undefined ? pos : off, tb);
    };
    const rbyte = () => {
      if (pos >= bytes.length) fail("Fin de données inattendue (octet attendu)");
      return bytes[pos++];
    };
    function rlong() {
      let c = rbyte();
      if (c > 127) c -= 256;
      if (c === 0) return 0;
      if (c > 0) {
        if (c > 4) return c - 5;
        if (pos + c > bytes.length) fail('Fin de données inattendue (entier sur ' + c + ' octets)');
        let x = 0;
        for (let i = 0; i < c; i++) x += bytes[pos++] * 2 ** (8 * i);
        return x;
      }
      if (c < -4) return c + 5;
      c = -c;
      if (pos + c > bytes.length) fail('Fin de données inattendue (entier négatif sur ' + c + ' octets)');
      let x = -1;
      for (let i = 0; i < c; i++) {
        x &= ~(0xff << (8 * i));
        x |= bytes[pos++] << (8 * i);
      }
      return x;
    }
    function rbytes() {
      const start = pos;
      const n = rlong();
      if (n < 0 || pos + n > bytes.length) fail(`Longueur invalide (${n}) : dépasse la fin des données`, start);
      const b = bytes.subarray(pos, pos + n);
      pos += n;
      return b;
    }
    function count(start) {
      const n = rlong();
      if (n < 0 || n > bytes.length - pos + 1) fail(`Nombre d'éléments invalide (${n})`, start);
      return n;
    }
    function reg(node) {
      objs.push(node);
      return node;
    }
    function rsymreal(withIvars) {
      const node = { t: 'sym', bytes: rbytes() };
      node.name = latin1(node.bytes);
      syms.push(node);
      if (withIvars) {
        node.ivars = rivars();
        node.iwrap = true;
      }
      return node;
    }
    function rsymlink(start) {
      const i = rlong();
      const s = syms[i];
      if (!s) fail(`Symlink ;${i} invalide (table de ${syms.length} symboles)`, start, 0x3b);
      const n = { t: 'sym', bytes: s.bytes, name: s.name };
      if (s.ivars) { n.ivars = s.ivars; n.iwrap = true; }
      return n;
    }
    function rsym() {
      const start = pos;
      const c = rbyte();
      if (c === 0x3a) return rsymreal(false);
      if (c === 0x3b) return rsymlink(start);
      if (c === 0x49) {
        const c2 = rbyte();
        if (c2 !== 0x3a) fail('Symbole attendu après I', start + 1, c2);
        return rsymreal(true);
      }
      fail('Symbole attendu', start, c);
    }
    function rivars() {
      const start = pos;
      const n = count(start);
      const a = [];
      for (let i = 0; i < n; i++) {
        const k = rsym();
        const v = robj(false);
        a.push([k, v]);
      }
      return a;
    }

    function robj(ivp) {
      const start = pos;
      const tb = rbyte();
      let node;
      stats.nodes++;
      switch (tb) {
        case 0x30: node = { t: 'nil' }; break;
        case 0x54: node = { t: 'true' }; break;
        case 0x46: node = { t: 'false' }; break;
        case 0x69: node = { t: 'int', v: rlong() }; break;
        case 0x6c: {
          const sign = rbyte();
          if (sign !== 0x2b && sign !== 0x2d) fail('Signe de Bignum invalide', pos - 1, tb);
          const len = rlong();
          if (len < 0 || pos + len * 2 > bytes.length) fail('Longueur de Bignum invalide', start, tb);
          let v = 0n;
          for (let i = pos + len * 2 - 1; i >= pos; i--) v = (v << 8n) | BigInt(bytes[i]);
          pos += len * 2;
          if (sign === 0x2d) v = -v;
          node = reg({ t: 'int', v: normInt(v), big: true, raw: bytes.subarray(start + 1, pos) });
          break;
        }
        case 0x66: {
          const b = rbytes();
          let v;
          try { v = parseFloatBytes(b); } catch (e) { fail(e.message, start, tb); }
          node = reg({ t: 'float', v, raw: b });
          break;
        }
        case 0x22:
          node = reg({ t: 'str', bytes: rbytes() });
          stats.strings++;
          break;
        case 0x3a:
          node = rsymreal(ivp);
          if (ivp) ivConsumed = true;
          break;
        case 0x3b:
          node = rsymlink(start);
          break;
        case 0x40: {
          const i = rlong();
          const n = objs[i];
          if (!n) fail(`Objlink @${i} invalide (table de ${objs.length} objets)`, start, tb);
          n.refs = (n.refs || 1) + 1;
          return n;
        }
        case 0x5b: {
          node = reg({ t: 'array', items: [] });
          const n = count(start);
          for (let i = 0; i < n; i++) node.items.push(robj(false));
          break;
        }
        case 0x7b:
        case 0x7d: {
          node = reg({ t: 'hash', entries: [] });
          const n = count(start);
          for (let i = 0; i < n; i++) {
            const k = robj(false);
            const v = robj(false);
            node.entries.push([k, v]);
          }
          if (tb === 0x7d) node.def = robj(false);
          break;
        }
        case 0x6f: {
          const cls = rsym();
          node = reg({ t: 'object', cls, ivars: [] });
          node.ivars = rivars();
          break;
        }
        case 0x53: {
          const cls = rsym();
          node = reg({ t: 'struct', cls, members: [] });
          const n = count(start);
          for (let i = 0; i < n; i++) {
            const k = rsym();
            const v = robj(false);
            node.members.push([k, v]);
          }
          break;
        }
        case 0x43: {
          const cls = rsym();
          node = robj(false);
          node.uclass = cls;
          break;
        }
        case 0x65: {
          const mod = rsym();
          node = robj(false);
          (node.extends = node.extends || []).unshift(mod);
          break;
        }
        case 0x75: {
          const cls = rsym();
          node = { t: 'userdef', cls, bytes: rbytes() };
          if (ivp) {
            node.ivars = rivars();
            node.iwrap = true;
            ivConsumed = true;
          }
          reg(node);
          break;
        }
        case 0x55: {
          const cls = rsym();
          node = reg({ t: 'usermarshal', cls });
          node.data = robj(false);
          break;
        }
        case 0x64: {
          const cls = rsym();
          node = reg({ t: 'data', cls });
          node.data = robj(false);
          break;
        }
        case 0x2f: {
          const b = rbytes();
          const opts = rbyte();
          node = reg({ t: 'regexp', bytes: b, opts });
          break;
        }
        case 0x63: node = reg({ t: 'class', bytes: rbytes() }); break;
        case 0x6d: node = reg({ t: 'module', bytes: rbytes() }); break;
        case 0x4d: node = reg({ t: 'module', bytes: rbytes(), old: true }); break;
        case 0x49: {
          const saved = ivConsumed;
          ivConsumed = false;
          node = robj(true);
          if (!ivConsumed) {
            node.ivars = rivars();
            node.iwrap = true;
            if (node.t === 'str') stats.encStrings++;
          }
          ivConsumed = saved;
          break;
        }
        default:
          fail('Type Marshal inconnu ' + M.typeByteName(tb), start, tb);
      }
      node._o = start;
      node._e = pos;
      return node;
    }

    if (bytes.length < 2) fail('Fichier trop court', 0);
    if (bytes[0] !== 4 || bytes[1] > 8) fail(`Version Marshal non supportée ${bytes[0]}.${bytes[1]} (attendu 4.8)`, 0);
    pos = 2;
    const root = robj(false);
    stats.symbols = syms.length;
    stats.objects = objs.length;
    return { root, end: pos, stats };
  }
  M.parse = parse;

  /**
   * Charge un fichier complet : détecte un éventuel en-tête avant 04 08 (ex. "PKPRT")
   * et conserve les octets qui suivent la fin du flux Marshal.
   */
  M.load = function (fileBytes, maxScan) {
    maxScan = maxScan || 64;
    const candidates = [];
    const lim = Math.min(fileBytes.length - 1, maxScan + 1);
    for (let i = 0; i < lim; i++) if (fileBytes[i] === 4 && fileBytes[i + 1] === 8) candidates.push(i);
    if (!candidates.length) {
      const e = new MarshalError(`Signature Marshal 04 08 introuvable dans les ${maxScan} premiers octets`, 0, fileBytes[0]);
      e.base = 0;
      throw e;
    }
    let firstErr = null;
    for (const off of candidates) {
      try {
        const body = fileBytes.subarray(off);
        const r = parse(body);
        return {
          prefix: fileBytes.slice(0, off),
          marshal: body.subarray(0, r.end),
          suffix: fileBytes.slice(off + r.end),
          root: r.root,
          offset: off,
          stats: r.stats,
        };
      } catch (e) {
        if (!(e instanceof MarshalError)) throw e;
        if (!firstErr) {
          firstErr = e;
          e.base = off;
        }
      }
    }
    throw firstErr;
  };

  /* ------------------------------------------------------------------ */
  /* Utilitaires du modèle                                              */
  /* ------------------------------------------------------------------ */

  M.symName = function (s) {
    if (!s) return '';
    const u = utf8OrNull(s.bytes);
    return u !== null ? u : latin1(s.bytes);
  };
  const symE = () => ({ t: 'sym', bytes: new Uint8Array([0x45]), name: 'E' });
  M.mkSym = function (name) {
    const b = ENC.encode(name);
    const n = { t: 'sym', bytes: b, name: latin1(b) };
    if (!isAscii(b)) {
      n.ivars = [[symE(), { t: 'true' }]];
      n.iwrap = true;
    }
    return n;
  };
  M.setSymName = function (node, name) {
    const n = M.mkSym(name);
    node.bytes = n.bytes;
    node.name = n.name;
    if (n.ivars) { node.ivars = n.ivars; node.iwrap = true; }
    else { delete node.ivars; delete node.iwrap; }
  };

  /** Remplace un nœud par un autre en place (garde l'identité => références partagées conservées). */
  M.replaceNode = function (node, fresh) {
    const keep = { _o: node._o, _e: node._e, refs: node.refs };
    for (const k of Object.keys(node)) delete node[k];
    Object.assign(node, fresh);
    for (const k in keep) if (keep[k] !== undefined) node[k] = keep[k];
  };
  /** Fixe un entier (number ou bigint). Bascule automatiquement Fixnum/Bignum à l'écriture. */
  M.setInt = function (node, v) {
    if (typeof v === 'bigint') v = normInt(v);
    node.t = 'int';
    node.v = v;
    delete node.raw;
    delete node.big;
    const big = typeof v === 'bigint' || v < -1073741824 || v > 1073741823;
    if (big) node.big = true;
  };
  M.setFloat = function (node, v) {
    node.t = 'float';
    node.v = v;
    delete node.raw;
  };
  M.parseIntText = function (s) {
    s = String(s).trim().replace(/_/g, '');
    if (!/^[-+]?(\d+|0x[0-9a-f]+)$/i.test(s)) throw new Error('Entier invalide : ' + s);
    const neg = s[0] === '-';
    const body = s.replace(/^[-+]/, '');
    let v = BigInt(body);
    if (neg) v = -v;
    return normInt(v);
  };
  M.parseFloatText = function (s) {
    s = String(s).trim().toLowerCase();
    if (s === 'inf' || s === 'infinity' || s === '+inf') return Infinity;
    if (s === '-inf' || s === '-infinity') return -Infinity;
    if (s === 'nan') return NaN;
    if (s === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(s)) throw new Error('Flottant invalide : ' + s);
    return Number(s);
  };

  function findIvar(node, name) {
    if (!node.ivars || !node.iwrap) return null;
    for (const p of node.ivars) if (p[0].name === name) return p;
    return null;
  }
  /** 'UTF-8' | 'US-ASCII' | nom d'encodage | null (binaire / Ruby 1.8) */
  M.strEncoding = function (node) {
    const e = findIvar(node, 'E');
    if (e) return e[1].t === 'true' ? 'UTF-8' : 'US-ASCII';
    const enc = findIvar(node, 'encoding');
    if (enc && enc[1].t === 'str') return latin1(enc[1].bytes);
    return null;
  };
  /** Vue d'une chaîne : {mode:'text'|'hex'|'foreign', text, enc} */
  M.strView = function (node) {
    const enc = M.strEncoding(node);
    if (enc === null || enc === 'UTF-8' || enc === 'US-ASCII') {
      const t = utf8OrNull(node.bytes);
      if (t !== null) return { mode: 'text', text: t, enc };
      return { mode: 'hex', text: toHex(node.bytes), enc };
    }
    try {
      const t = new TextDecoder(enc.toLowerCase(), { fatal: true }).decode(node.bytes);
      return { mode: 'foreign', text: t, enc };
    } catch (e) {
      return { mode: 'hex', text: toHex(node.bytes), enc };
    }
  };
  /** Remplace le texte d'une chaîne (UTF-8). Ajuste E=false -> E=true si nécessaire. */
  M.setStrText = function (node, text) {
    node.bytes = ENC.encode(text);
    const e = findIvar(node, 'E');
    if (e && e[1].t === 'false' && !isAscii(node.bytes)) {
      const i = node.ivars.indexOf(e);
      node.ivars = node.ivars.slice();
      node.ivars[i] = [e[0], { t: 'true' }];
    }
  };
  M.newString = function (text, legacy) {
    const n = { t: 'str', bytes: ENC.encode(text || '') };
    if (!legacy) {
      n.ivars = [[symE(), { t: 'true' }]];
      n.iwrap = true;
    }
    return n;
  };

  /* ---------- Décodeurs userdef (RGSS) ---------- */
  function dv(b) { return new DataView(b.buffer, b.byteOffset, b.byteLength); }
  M.decoders = {
    Table: {
      check(b) {
        if (b.length < 20) return false;
        const d = dv(b);
        const xs = d.getInt32(4, true), ys = d.getInt32(8, true), zs = d.getInt32(12, true), size = d.getInt32(16, true);
        return xs >= 0 && ys >= 0 && zs >= 0 && size === xs * ys * zs && b.length === 20 + size * 2;
      },
      decode(b) {
        const d = dv(b);
        const t = { dim: d.getInt32(0, true), xs: d.getInt32(4, true), ys: d.getInt32(8, true), zs: d.getInt32(12, true), size: d.getInt32(16, true) };
        t.get = (x, y, z) => d.getInt16(20 + 2 * (x + t.xs * (y + t.ys * z)), true);
        return t;
      },
      set(b, x, y, z, v) {
        const c = b.slice();
        const d = dv(c);
        const xs = d.getInt32(4, true), ys = d.getInt32(8, true);
        d.setInt16(20 + 2 * (x + xs * (y + ys * z)), v, true);
        return c;
      },
      summary(b) {
        const t = this.decode(b);
        return `${t.xs}×${t.ys}×${t.zs} (dim ${t.dim})`;
      },
    },
    Color: floatQuad(['red', 'green', 'blue', 'alpha']),
    Tone: floatQuad(['red', 'green', 'blue', 'gray']),
    Rect: {
      fields: ['x', 'y', 'width', 'height'],
      kind: 'int',
      check: (b) => b.length === 16,
      decode(b) { const d = dv(b); return this.fields.map((_, i) => d.getInt32(i * 4, true)); },
      encode(vals) { const c = new Uint8Array(16); const d = dv(c); vals.forEach((v, i) => d.setInt32(i * 4, v, true)); return c; },
      summary(b) { return '(' + this.decode(b).join(', ') + ')'; },
    },
  };
  function floatQuad(fields) {
    return {
      fields,
      kind: 'float',
      check: (b) => b.length === 32,
      decode(b) { const d = dv(b); return fields.map((_, i) => d.getFloat64(i * 8, true)); },
      encode(vals) { const c = new Uint8Array(32); const d = dv(c); vals.forEach((v, i) => d.setFloat64(i * 8, v, true)); return c; },
      summary(b) { return '(' + this.decode(b).map((v) => +v.toFixed(3)).join(', ') + ')'; },
    };
  }
  M.decoderFor = function (node) {
    if (node.t !== 'userdef') return null;
    const name = M.symName(node.cls);
    const short = name.split('::').pop();
    const d = M.decoders[short];
    if (d && d.check(node.bytes)) return { name: short, dec: d };
    return null;
  };

  /* ---------- Navigation ---------- */
  M.version = 0; // incrémenté à chaque modification -> invalide le cache des enfants
  const childCache = new WeakMap();
  const ENC_HOLDERS = { str: 1, sym: 1, regexp: 1, userdef: 1 };

  M.keyLabel = function (k, i) {
    switch (k.t) {
      case 'sym': return ':' + M.symName(k);
      case 'str': {
        const v = M.strView(k);
        if (v.mode === 'hex') return `"<${k.bytes.length} o>"`;
        return JSON.stringify(v.text.length > 60 ? v.text.slice(0, 60) + '…' : v.text);
      }
      case 'int': return String(k.v);
      case 'float': return M.floatDisplay(k.v);
      case 'nil': case 'true': case 'false': return k.t;
      default: return `{${M.typeLabel(k)}#${i}}`;
    }
  };

  /** Liste des enfants : [{label, node, kind, index, key?}] (le label s'ajoute au chemin parent) */
  M.children = function (node) {
    const c = childCache.get(node);
    if (c && c.ver === M.version) return c.list;
    const out = [];
    switch (node.t) {
      case 'array':
        for (let i = 0; i < node.items.length; i++) out.push({ label: `[${i}]`, node: node.items[i], kind: 'item', index: i });
        break;
      case 'hash':
        for (let i = 0; i < node.entries.length; i++) {
          const [k, v] = node.entries[i];
          out.push({ label: '[' + M.keyLabel(k, i) + ']', node: v, key: k, kind: 'entry', index: i });
        }
        if (node.def !== undefined) out.push({ label: '.(défaut)', node: node.def, kind: 'default' });
        break;
      case 'object':
        node.ivars.forEach(([k, v], i) => out.push({ label: '.' + M.symName(k), node: v, kind: 'ivar', index: i, key: k }));
        break;
      case 'struct':
        node.members.forEach(([k, v], i) => out.push({ label: '.' + M.symName(k), node: v, kind: 'member', index: i, key: k }));
        break;
      case 'usermarshal':
      case 'data':
        out.push({ label: '.(data)', node: node.data, kind: 'data' });
        break;
    }
    if (node.iwrap && node.ivars && node.t !== 'object') {
      node.ivars.forEach(([k, v], i) => {
        const n = M.symName(k);
        if (ENC_HOLDERS[node.t] && (n === 'E' || n === 'encoding')) return;
        out.push({ label: '.' + n, node: v, kind: 'wivar', index: i, key: k });
      });
    }
    for (let i = 0; i < out.length; i++) out[i].pos = i;
    childCache.set(node, { ver: M.version, list: out });
    return out;
  };
  M.isContainer = (node) => M.children(node).length > 0 || ['array', 'hash', 'object', 'struct'].includes(node.t);

  M.typeLabel = function (n) {
    switch (n.t) {
      case 'nil': return 'nil';
      case 'true': case 'false': return 'Boolean';
      case 'int': return n.big ? 'Bignum' : 'Integer';
      case 'float': return 'Float';
      case 'str': return 'String';
      case 'sym': return 'Symbol';
      case 'array': return 'Array';
      case 'hash': return 'Hash';
      case 'object': return 'Object';
      case 'struct': return 'Struct';
      case 'userdef': return 'UserDef';
      case 'usermarshal': return 'UserMarshal';
      case 'data': return 'Data';
      case 'regexp': return 'Regexp';
      case 'class': return 'Class';
      case 'module': return 'Module';
      default: return n.t;
    }
  };
  M.className = function (n) {
    if (n.cls) return M.symName(n.cls);
    if (n.uclass) return M.symName(n.uclass);
    return '';
  };
  M.floatDisplay = function (v) {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    if (Object.is(v, -0)) return '-0.0';
    return Number.isInteger(v) && Math.abs(v) < 1e16 ? v.toFixed(1) : String(v);
  };
  M.summary = function (n, max) {
    max = max || 80;
    const cut = (s) => (s.length > max ? s.slice(0, max) + '…' : s);
    switch (n.t) {
      case 'nil': case 'true': case 'false': return n.t;
      case 'int': return String(n.v);
      case 'float': return M.floatDisplay(n.v);
      case 'str': {
        if (n.zs) return `<script ${n.zs.text.split('\n').length} lignes>`;
        const v = M.strView(n);
        if (v.mode === 'hex') return cut(`<hex ${n.bytes.length} o> ${toHex(n.bytes.subarray(0, 24))}`);
        return cut(JSON.stringify(v.text));
      }
      case 'sym': return ':' + M.symName(n);
      case 'array': return `[${n.items.length}]`;
      case 'hash': return `{${n.entries.length}}` + (n.def !== undefined ? ' +défaut' : '');
      case 'object': return `#<${M.symName(n.cls)}> (${n.ivars.length} ivars)`;
      case 'struct': return `#<struct ${M.symName(n.cls)}> (${n.members.length})`;
      case 'userdef': {
        const d = M.decoderFor(n);
        return d ? `${d.name} ${d.dec.summary(n.bytes)}` : `${M.symName(n.cls)} <${n.bytes.length} o>`;
      }
      case 'usermarshal': case 'data': return `${M.symName(n.cls)} (${n.t})`;
      case 'regexp': return cut('/' + (utf8OrNull(n.bytes) ?? latin1(n.bytes)) + '/' + regexpFlags(n.opts));
      case 'class': case 'module': return latin1(n.bytes);
      default: return '?';
    }
  };
  function regexpFlags(o) {
    return (o & 1 ? 'i' : '') + (o & 2 ? 'x' : '') + (o & 4 ? 'm' : '');
  }

  /* ---------- Scripts zlib (Scripts.rxdata / .rvdata / .rvdata2) ---------- */
  async function pipe(u8, stream) {
    const s = new Blob([u8]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  M.zlib = {
    available: typeof DecompressionStream !== 'undefined',
    inflate: (u8) => pipe(u8, new DecompressionStream('deflate')),
    deflate: (u8) => pipe(u8, new CompressionStream('deflate')),
  };
  /** Renvoie la liste des nœuds chaîne zlib si root ressemble à un fichier Scripts, sinon null. */
  M.detectScripts = function (root) {
    if (!root || root.t !== 'array' || !root.items.length) return null;
    const out = [];
    for (const it of root.items) {
      if (it.t !== 'array' || it.items.length !== 3) return null;
      const [a, b, c] = it.items;
      if (a.t !== 'int' || b.t !== 'str' || c.t !== 'str') return null;
      if (c.bytes.length < 2 || c.bytes[0] !== 0x78) return null;
      out.push(c);
    }
    return out;
  };
  M.inflateScripts = async function (root) {
    const list = M.detectScripts(root);
    if (!list || !M.zlib.available) return 0;
    let n = 0;
    for (const node of list) {
      try {
        const raw = await M.zlib.inflate(node.bytes);
        node.zs = { text: UTF8.decode(raw) };
        n++;
      } catch (e) { /* script non zlib : laissé tel quel */ }
    }
    if (n) M.version++;
    return n;
  };
})(typeof window !== 'undefined' ? window : globalThis);
