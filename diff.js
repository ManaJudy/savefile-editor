/* diff.js — Liste des modifications (chemin : avant → après) et diff hexadécimal. */
(function (G) {
  'use strict';
  const M = G.MarshalLib;
  const IGNORED = { _o: 1, _e: 1, refs: 1 };

  function valEq(a, b) {
    if (a === b || Object.is(a, b)) return true;
    if (a instanceof Uint8Array && b instanceof Uint8Array) return M.bytesEqual(a, b);
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        if (Array.isArray(x) && Array.isArray(y)) { if (x.length !== y.length || x.some((v, j) => v !== y[j])) return false; }
        else if (x !== y) return false;
      }
      return true;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object' && 'text' in a && 'text' in b) return a.text === b.text;
    return false;
  }
  /** Compare deux instantanés de nœud (copies superficielles). */
  function snapEqual(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (IGNORED[k]) continue;
      if (!valEq(a[k], b[k])) return false;
    }
    return true;
  }
  function snapshot(node) {
    const o = {};
    for (const k of Object.keys(node)) {
      const v = node[k];
      o[k] = Array.isArray(v) ? v.slice() : v;
    }
    return o;
  }
  function restore(node, snap) {
    for (const k of Object.keys(node)) delete node[k];
    for (const k of Object.keys(snap)) {
      const v = snap[k];
      node[k] = Array.isArray(v) ? v.slice() : v;
    }
  }

  /** Chemins actuels (première occurrence) d'un ensemble de nœuds. */
  function pathsOf(root, targets) {
    const found = new Map();
    if (!targets.size) return found;
    const seen = new Set();
    const stack = [{ node: root, label: 'root', parent: null }];
    const full = (e) => { let s = ''; for (let x = e; x; x = x.parent) s = x.label + s; return s; };
    while (stack.length && found.size < targets.size) {
      const e = stack.pop();
      const n = e.node;
      if (targets.has(n) && !found.has(n)) found.set(n, full(e));
      if (seen.has(n)) continue;
      const kids = M.children(n);
      if (!kids.length) continue;
      seen.add(n);
      for (let i = kids.length - 1; i >= 0; i--) {
        const c = kids[i];
        stack.push({ node: c.node, label: c.label, parent: e });
        if (c.key && targets.has(c.key) && !found.has(c.key)) found.set(c.key, full(e) + c.label + ' (clé)');
      }
    }
    return found;
  }

  function describe(snap) {
    if (snap.zs) return `<script ${snap.zs.text.length} car.>`;
    if (snap.t === 'array') return `[${snap.items.length} éléments]`;
    if (snap.t === 'hash') return `{${snap.entries.length} entrées}`;
    if (snap.t === 'object') return `#<${M.symName(snap.cls)}> ${snap.ivars.length} ivars`;
    return `${M.typeLabel(snap)} ${M.summary(snap, 200)}`;
  }

  /**
   * @param doc {root, marshal, prefix}
   * @param orig Map<node, snapshot d'origine>
   * @param editPaths Map<node, chemin au moment de l'édition>
   */
  function compute(doc, orig, editPaths) {
    const changed = [];
    for (const [node, snap] of orig) {
      if (!snapEqual(snap, node)) changed.push({ node, snap });
    }
    const set = new Set(changed.map((c) => c.node));
    const paths = pathsOf(doc.root, set);
    const { bytes, positions } = M.dump(doc.root, { track: set });
    const changes = changed.map(({ node, snap }) => {
      const reachable = paths.has(node);
      const pos = positions.get(node);
      return {
        node,
        path: paths.get(node) || (editPaths.get(node) || '?') + ' (plus atteignable)',
        reachable,
        before: describe(snap),
        after: describe(node),
        oldOff: node._o,
        oldBytes: node._o !== undefined ? doc.marshal.subarray(node._o, node._e) : null,
        newOff: pos ? pos[0] : undefined,
        newBytes: pos ? bytes.subarray(pos[0], pos[1]) : null,
      };
    });
    changes.sort((a, b) => (a.oldOff ?? 1e15) - (b.oldOff ?? 1e15));
    // Statistiques globales
    let firstDiff = -1, diffBytes = 0;
    const a = doc.marshal;
    const n = Math.min(a.length, bytes.length);
    for (let i = 0; i < n; i++) if (a[i] !== bytes[i]) { if (firstDiff < 0) firstDiff = i; diffBytes++; }
    if (firstDiff < 0 && a.length !== bytes.length) firstDiff = n;
    return { changes, bytes, oldLen: a.length, newLen: bytes.length, firstDiff, diffBytes };
  }

  const MAXB = 64;
  function hexCell(b, other) {
    if (!b) return '<span class="dim">—</span>';
    const shown = b.subarray(0, MAXB);
    let s = '';
    for (let i = 0; i < shown.length; i++) {
      const h = (shown[i] < 16 ? '0' : '') + shown[i].toString(16);
      const differs = !other || i >= other.length || other[i] !== shown[i];
      s += (differs ? `<b>${h}</b>` : h) + ' ';
    }
    if (b.length > MAXB) s += `<span class="dim">… (+${b.length - MAXB} o)</span>`;
    return s;
  }
  const off = (o, base) => (o === undefined ? '<span class="dim">nouveau</span>' : '0x' + (o + base).toString(16).padStart(6, '0'));

  function renderHTML(res, prefixLen) {
    const esc = M.esc;
    let h = `<div class="diff-summary">Taille du flux Marshal : ${res.oldLen} → ${res.newLen} octets` +
      (res.firstDiff >= 0 ? ` · premier octet différent à l'offset fichier 0x${(res.firstDiff + prefixLen).toString(16)}` : ' · <b>aucune différence binaire</b>') +
      (res.oldLen === res.newLen && res.firstDiff >= 0 ? ` · ${res.diffBytes} octet(s) modifié(s)` : '') + '</div>';
    if (!res.changes.length) return h + '<p class="dim">Aucune modification.</p>';
    h += '<h3>Modifications</h3><ul class="changes">';
    for (const c of res.changes) {
      h += `<li><code class="path">${esc(c.path)}</code> : <span class="old">${esc(c.before)}</span> → <span class="new">${esc(c.after)}</span></li>`;
    }
    h += '</ul><h3>Diff hexadécimal (octets par nœud modifié)</h3><table class="hexdiff"><thead><tr><th>Nœud</th><th>Offset avant</th><th>Avant</th><th>Offset après</th><th>Après</th></tr></thead><tbody>';
    for (const c of res.changes) {
      h += `<tr><td><code>${esc(c.path)}</code></td><td>${off(c.oldOff, prefixLen)}</td><td class="hx">${hexCell(c.oldBytes, c.newBytes)}</td>` +
        `<td>${c.newBytes ? off(c.newOff, prefixLen) : '<span class="dim">supprimé</span>'}</td><td class="hx">${hexCell(c.newBytes, c.oldBytes)}</td></tr>`;
    }
    h += '</tbody></table><p class="dim">Les offsets incluent l\'en-tête éventuel (' + prefixLen + ' o). Les octets en gras diffèrent.</p>';
    return h;
  }

  G.MarshalDiff = { snapshot, restore, snapEqual, compute, renderHTML, pathsOf };
})(window);
