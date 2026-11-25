/* search.js — Recherche dans tout le graphe (clés, ivars, classes, symboles, valeurs).
 * Parcours itératif découpé en tranches pour ne pas bloquer l'interface. */
(function (G) {
  'use strict';
  const M = G.MarshalLib;

  const TYPE_FILTERS = {
    all: () => true,
    int: (n) => n.t === 'int',
    float: (n) => n.t === 'float',
    num: (n) => n.t === 'int' || n.t === 'float',
    str: (n) => n.t === 'str',
    sym: (n) => n.t === 'sym',
    bool: (n) => n.t === 'true' || n.t === 'false' || n.t === 'nil',
    array: (n) => n.t === 'array',
    hash: (n) => n.t === 'hash',
    object: (n) => n.t === 'object' || n.t === 'struct',
    userdef: (n) => n.t === 'userdef' || n.t === 'usermarshal' || n.t === 'data',
  };

  function makeMatcher(q, opts) {
    if (opts.mode === 'regex') {
      const re = new RegExp(q, opts.caseSensitive ? '' : 'i');
      return (s) => re.test(s);
    }
    if (opts.caseSensitive) return opts.mode === 'exact' ? (s) => s === q : (s) => s.includes(q);
    const ql = q.toLowerCase();
    return opts.mode === 'exact' ? (s) => s.toLowerCase() === ql : (s) => s.toLowerCase().includes(ql);
  }

  function keyText(k) {
    switch (k.t) {
      case 'sym': return M.symName(k);
      case 'str': { const v = M.strView(k); return v.mode === 'hex' ? null : v.text; }
      case 'int': return String(k.v);
      case 'float': return M.formatFloat(k.v);
      default: return null;
    }
  }
  function valueText(n) {
    switch (n.t) {
      case 'int': return String(n.v);
      case 'float': return M.formatFloat(n.v);
      case 'sym': return M.symName(n);
      case 'str': {
        if (n.zs) return n.zs.text;
        const v = M.strView(n);
        return v.text;
      }
      case 'nil': case 'true': case 'false': return n.t;
      case 'regexp': return M.utf8(n.bytes);
      case 'class': case 'module': return M.latin1(n.bytes);
      default: return null;
    }
  }

  /**
   * Lance une recherche.
   * @param opts {mode:'partial'|'exact'|'regex', caseSensitive, type, scope:'all'|'keys'|'classes'|'values', limit}
   * @param onDone(results, info)  results: [{path, node, where, text, steps}]
   * @param onProgress(visited)
   * @returns {cancel()}
   */
  function run(root, q, opts, onDone, onProgress) {
    const match = makeMatcher(q, opts);
    const typeOk = TYPE_FILTERS[opts.type || 'all'];
    const scope = opts.scope || 'all';
    const limit = opts.limit || 5000;
    const results = [];
    const seen = new Set();
    const stack = [{ node: root, path: 'root', parent: null, pos: undefined, info: { kind: 'root' } }];
    let cancelled = false;
    let visited = 0;

    const push = (e, where, text) => {
      results.push({ entry: e, path: e.path, node: e.node, where, text });
    };

    function visit(e) {
      const n = e.node;
      const info = e.info;
      if (typeOk(n)) {
        if (scope === 'all' || scope === 'keys') {
          if (info.kind === 'entry') {
            const kt = keyText(info.key);
            if (kt !== null && (match(kt) || (info.key.t === 'sym' && match(':' + kt)))) push(e, 'clé', info.label);
          } else if (info.kind === 'ivar' || info.kind === 'member' || info.kind === 'wivar') {
            const nm = M.symName(info.key);
            if (match(nm) || match(nm.replace(/^@/, ''))) push(e, info.kind === 'member' ? 'membre' : 'ivar', nm);
          }
        }
        if (scope === 'all' || scope === 'classes') {
          const cn = M.className(n);
          if (cn && match(cn)) push(e, 'classe', cn);
          else if ((n.t === 'class' || n.t === 'module') && match(M.latin1(n.bytes))) push(e, 'classe', M.latin1(n.bytes));
          else if (n.extends) for (const m of n.extends) if (match(M.symName(m))) { push(e, 'module', M.symName(m)); break; }
        }
        if (scope === 'all' || scope === 'values') {
          const vt = valueText(n);
          if (vt !== null && (match(vt) || (n.t === 'sym' && match(':' + vt)))) push(e, 'valeur', vt.length > 100 ? vt.slice(0, 100) + '…' : vt);
        }
      }
      if (seen.has(n)) return; // nœud partagé déjà exploré
      const kids = M.children(n);
      if (kids.length) seen.add(n);
      for (let i = kids.length - 1; i >= 0; i--) {
        const c = kids[i];
        stack.push({ node: c.node, path: e.path + c.label, parent: e, pos: c.pos, info: c });
      }
    }

    function slice() {
      if (cancelled) return;
      const t0 = Date.now();
      while (stack.length && results.length < limit) {
        visit(stack.pop());
        visited++;
        if ((visited & 1023) === 0 && Date.now() - t0 > 30) break;
      }
      if (stack.length && results.length < limit) {
        if (onProgress) onProgress(visited, results.length);
        setTimeout(slice, 0);
      } else {
        for (const r of results) r.steps = stepsOf(r.entry);
        onDone(results, { visited, truncated: results.length >= limit });
      }
    }
    setTimeout(slice, 0);
    return { cancel: () => { cancelled = true; } };
  }

  function stepsOf(e) {
    const chain = [];
    for (let x = e; x && x.parent; x = x.parent) chain.unshift({ parentPath: x.parent.path, pos: x.pos, path: x.path });
    return chain;
  }

  G.MarshalSearch = { run, TYPE_FILTERS, makeMatcher };
})(window);
