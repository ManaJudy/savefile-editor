/* app.js — Contrôleur principal : chargement, édition, undo/redo, recherche, export. */
(function () {
  'use strict';
  const M = window.MarshalLib;
  const D = window.MarshalDiff;
  const S = window.MarshalSearch;
  const esc = M.esc;
  const $ = (s, el) => (el || document).querySelector(s);

  const state = {
    doc: null,
    fileName: '',
    fileBytes: null,
    undo: [],
    redo: [],
    orig: new Map(),
    editPaths: new Map(),
    modified: new Set(),
    modPaths: [],
    legacy: false,
    search: null,
    results: [],
    resPage: 0,
    tableView: new WeakMap(),
    hexMode: new WeakSet(),
  };
  let tree;

  /* ================================================================ */
  /* Chargement                                                        */
  /* ================================================================ */
  async function openFile(file) {
    if (!file) return;
    if (state.undo.length && !confirm('Des modifications non téléchargées seront perdues. Continuer ?')) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    loadBytes(bytes, file.name);
  }

  function loadBytes(bytes, name) {
    let doc;
    const t0 = performance.now();
    try {
      doc = M.load(bytes);
    } catch (e) {
      showError(e, bytes, name);
      return;
    }
    const t1 = performance.now();
    Object.assign(state, {
      doc, fileName: name, fileBytes: bytes, undo: [], redo: [], orig: new Map(), editPaths: new Map(),
      modified: new Set(), modPaths: [], results: [], resPage: 0,
      legacy: doc.stats.strings > 0 && doc.stats.encStrings === 0,
    });
    $('#error-panel').hidden = true;
    $('#dropzone').hidden = true;
    $('#workspace').hidden = false;
    $('#results').hidden = true;
    document.body.classList.add('loaded');
    const rt = M.roundTrip(doc);
    const t2 = performance.now();
    setBadge(rt);
    $('#file-info').innerHTML =
      `<b>${esc(name)}</b> · ${fmtSize(bytes.length)}` +
      (doc.prefix.length ? ` · en-tête <code title="${esc(M.toHex(doc.prefix))}">${esc(printable(doc.prefix))}</code> (${doc.prefix.length} o)` : '') +
      (doc.suffix.length ? ` · ${doc.suffix.length} o après le Marshal` : '') +
      ` · ${doc.stats.nodes.toLocaleString('fr')} nœuds` +
      (state.legacy ? ' · <span title="Aucune chaîne n\'a d\'encodage : style Ruby 1.8 (RPG Maker XP)">Ruby 1.8</span>' : '');
    console.info(`Parse ${(t1 - t0).toFixed(0)} ms, round-trip ${(t2 - t1).toFixed(0)} ms`);
    M.version++;
    tree.setRoot(doc.root);
    updateButtons();
    if (M.detectScripts(doc.root)) {
      M.inflateScripts(doc.root).then((n) => {
        if (state.doc !== doc || !n) return;
        toast(`${n} script(s) zlib décompressé(s) — éditables comme du texte`);
        tree.rebuild();
        renderDetail();
      });
    }
    tree.el.focus();
  }

  function printable(b) {
    return Array.from(b.subarray(0, 32), (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '·')).join('');
  }
  function fmtSize(n) {
    return n < 1024 ? n + ' o' : n < 1048576 ? (n / 1024).toFixed(1) + ' Ko' : (n / 1048576).toFixed(2) + ' Mo';
  }

  function setBadge(rt) {
    const b = $('#rt-badge');
    if (rt.ok) {
      b.className = 'badge-rt ok';
      b.textContent = '✔ Round-trip OK';
      b.title = 'La réécriture sans modification produit exactement les mêmes octets.';
    } else {
      b.className = 'badge-rt warn';
      b.textContent = '⚠ Round-trip imparfait';
      b.title = `La réécriture diffère de l'original à l'offset ${rt.firstDiff} (${rt.origLen} → ${rt.newLen} o). ` +
        'Le fichier reste lisible et modifiable, mais l\'export ne sera pas identique octet pour octet.';
    }
  }

  function showError(e, bytes, name) {
    const p = $('#error-panel');
    const base = e.base || 0;
    const off = (e.offset || 0) + base;
    const from = Math.max(0, off - 48) & ~15;
    const to = Math.min(bytes.length, off + 64);
    let dump = '';
    for (let row = from; row < to; row += 16) {
      let hex = '', asc = '';
      for (let i = row; i < row + 16; i++) {
        if (i >= to) { hex += '   '; continue; }
        const c = bytes[i];
        const h = (c < 16 ? '0' : '') + c.toString(16);
        hex += (i === off ? `<b class="err-byte">${h}</b>` : h) + ' ';
        const ch = c >= 32 && c < 127 ? esc(String.fromCharCode(c)) : '.';
        asc += i === off ? `<b class="err-byte">${ch}</b>` : ch;
      }
      dump += `${row.toString(16).padStart(8, '0')}  ${hex} ${asc}\n`;
    }
    p.innerHTML = `<h2>Impossible de lire « ${esc(name)} »</h2>
      <p class="err-msg">${esc(e.message)}</p>
      <ul>
        <li>Offset dans le fichier : <b>0x${off.toString(16)}</b> (${off})${base ? ` — flux Marshal commençant à 0x${base.toString(16)}` : ''}</li>
        <li>Octet rencontré : <b>${off >= bytes.length ? 'fin du fichier' : esc(M.typeByteName(e.typeByte !== undefined ? e.typeByte : bytes[off]))}</b></li>
        <li>Taille du fichier : ${bytes.length} octets</li>
      </ul>
      <pre class="hexdump">${dump}</pre>
      <p class="dim">Le fichier est peut-être chiffré, compressé dans son ensemble, ou n'est pas un fichier Ruby Marshal 4.8.</p>`;
    p.hidden = false;
    state.doc = null;
    state.undo = [];
    state.modified = new Set();
    document.body.classList.remove('loaded');
    $('#workspace').hidden = true;
    $('#dropzone').hidden = false;
    $('#rt-badge').className = '';
    $('#rt-badge').textContent = '';
    $('#file-info').textContent = '';
    updateButtons();
    if (e.name !== 'MarshalError') console.error(e);
  }

  /* ================================================================ */
  /* Édition + undo/redo                                              */
  /* ================================================================ */
  function edit(node, mutate, desc, path, opts) {
    const before = D.snapshot(node);
    try {
      mutate(node);
    } catch (err) {
      D.restore(node, before);
      throw err;
    }
    const after = D.snapshot(node);
    if (D.snapEqual(before, after)) return false;
    if (!state.orig.has(node)) {
      state.orig.set(node, before);
      state.editPaths.set(node, path);
    }
    state.undo.push({ node, before, after, desc, path });
    state.redo.length = 0;
    afterChange(opts);
    return true;
  }
  function afterChange(opts) {
    M.version++;
    recomputeModified();
    tree.rebuild();
    if (!(opts && opts.keepDetail)) renderDetail();
    updateButtons();
  }
  function recomputeModified() {
    state.modified = new Set();
    state.modPaths = [];
    for (const [node, snap] of state.orig) {
      if (!D.snapEqual(snap, node)) {
        state.modified.add(node);
        state.modPaths.push(state.editPaths.get(node));
      }
    }
  }
  function undo() {
    const c = state.undo.pop();
    if (!c) return;
    D.restore(c.node, c.before);
    state.redo.push(c);
    afterChange();
    toast('Annulé : ' + c.desc);
  }
  function redo() {
    const c = state.redo.pop();
    if (!c) return;
    D.restore(c.node, c.after);
    state.undo.push(c);
    afterChange();
    toast('Rétabli : ' + c.desc);
  }
  function updateButtons() {
    $('#btn-undo').disabled = !state.undo.length;
    $('#btn-redo').disabled = !state.redo.length;
    $('#btn-undo').title = state.undo.length ? 'Annuler : ' + state.undo[state.undo.length - 1].desc + ' (Ctrl+Z)' : 'Rien à annuler';
    $('#btn-redo').title = state.redo.length ? 'Rétablir : ' + state.redo[state.redo.length - 1].desc + ' (Ctrl+Y)' : 'Rien à rétablir';
    const n = state.modified.size;
    $('#chg-count').textContent = n ? n : '';
    for (const id of ['#btn-download', '#btn-json', '#btn-changes']) $(id).disabled = !state.doc;
  }
  function hasModifiedInside(path) {
    for (const p of state.modPaths) {
      if (p && p.length > path.length && p.startsWith(path)) {
        const c = p[path.length];
        if (c === '.' || c === '[') return true;
      }
    }
    return false;
  }

  /* ---------- Valeurs ---------- */
  const NEW_TYPES = [
    ['nil', 'nil'], ['true', 'true'], ['false', 'false'], ['int', 'Integer'], ['float', 'Float'],
    ['str', 'String'], ['sym', 'Symbol'], ['array', 'Array'], ['hash', 'Hash'],
  ];
  function freshNode(type, text) {
    text = text === undefined ? '' : String(text);
    switch (type) {
      case 'nil': case 'true': case 'false': return { t: type };
      case 'int': { const n = { t: 'int' }; M.setInt(n, text.trim() ? M.parseIntText(text) : 0); return n; }
      case 'float': return { t: 'float', v: text.trim() ? M.parseFloatText(text) : 0 };
      case 'str': return M.newString(text, state.legacy);
      case 'sym': {
        if (!text.trim()) throw new Error('Nom de symbole vide');
        const s = M.mkSym(text.trim());
        if (state.legacy) { delete s.ivars; delete s.iwrap; }
        return s;
      }
      case 'array': return { t: 'array', items: [] };
      case 'hash': return { t: 'hash', entries: [] };
    }
    throw new Error('Type inconnu ' + type);
  }
  function typeOptions(sel) {
    return NEW_TYPES.map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('');
  }

  /** Applique un texte à un nœud scalaire. Renvoie un message d'erreur ou null. */
  function setScalarFromText(row, text) {
    const n = row.node;
    try {
      switch (n.t) {
        case 'nil': case 'true': case 'false':
          if (text !== n.t) edit(n, (x) => M.replaceNode(x, { t: text }), `${row.path} = ${text}`, row.path);
          break;
        case 'int': {
          const v = M.parseIntText(text);
          edit(n, (x) => M.setInt(x, v), `${row.path} = ${v}`, row.path);
          break;
        }
        case 'float': {
          const v = M.parseFloatText(text);
          if (!Object.is(v, n.v)) edit(n, (x) => M.setFloat(x, v), `${row.path} = ${M.formatFloat(v)}`, row.path);
          break;
        }
        case 'str':
          edit(n, (x) => M.setStrText(x, text), `${row.path} = "${text.slice(0, 30)}"`, row.path);
          break;
        case 'sym': {
          const name = text.replace(/^:/, '').trim();
          if (!name) throw new Error('Nom de symbole vide');
          edit(n, (x) => { M.setSymName(x, name); if (state.legacy) { delete x.ivars; delete x.iwrap; } }, `${row.path} = :${name}`, row.path);
          break;
        }
        default:
          return 'Ce type ne s\'édite pas en ligne';
      }
    } catch (e) {
      return e.message;
    }
    return null;
  }

  /* ================================================================ */
  /* Panneau de détail                                                */
  /* ================================================================ */
  function renderDetail(focusEditor) {
    const box = $('#detail');
    const row = tree.selectedRow();
    renderCrumbs(row);
    if (!row) { box.innerHTML = '<p class="dim">Sélectionnez un nœud.</p>'; return; }
    const n = row.node;
    const parent = row.parent ? row.parent.node : null;
    let h = `<div class="d-path"><code>${esc(row.path)}</code></div>`;
    h += '<table class="d-info">';
    h += `<tr><th>Type</th><td>${M.typeLabel(n)}${n.big ? ' (Bignum)' : ''}</td></tr>`;
    if (M.className(n)) h += `<tr><th>Classe</th><td><code>${esc(M.className(n))}</code>${n.uclass && n.cls ? '' : n.uclass ? ' (sous-classe)' : ''}</td></tr>`;
    if (n.extends && n.extends.length) h += `<tr><th>Étendu par</th><td>${n.extends.map((m) => esc(M.symName(m))).join(', ')}</td></tr>`;
    if (n.t === 'str' || n.t === 'regexp') h += `<tr><th>Encodage</th><td>${esc(M.strEncoding(n) || 'aucun (binaire / Ruby 1.8)')} · ${n.bytes.length} octets</td></tr>`;
    if (n._o !== undefined) h += `<tr><th>Offset d'origine</th><td>0x${(n._o + state.doc.prefix.length).toString(16)} (${n._e - n._o} o)</td></tr>`;
    else h += '<tr><th>Offset</th><td class="dim">nouveau nœud</td></tr>';
    if (n.refs > 1) h += `<tr><th>Partagé</th><td class="warn-txt">⇄ ${n.refs} références : toute modification s'applique partout</td></tr>`;
    if (state.modified.has(n)) h += `<tr><th>État</th><td class="mod-txt">modifié (avant : ${esc(describeOrig(n))})</td></tr>`;
    h += '</table>';

    h += '<div class="d-editor">' + editorHTML(row) + '</div>';

    // Opérations sur le conteneur
    if (n.t === 'array') {
      h += `<fieldset><legend>Ajouter un élément</legend>
        <select id="add-type">${typeOptions('nil')}</select>
        <input id="add-val" placeholder="valeur (facultatif)">
        <label>position <input id="add-pos" type="number" min="0" max="${n.items.length}" value="${n.items.length}" style="width:6em"></label>
        <button id="add-do">Ajouter</button></fieldset>`;
    } else if (n.t === 'hash') {
      h += `<fieldset><legend>Ajouter une entrée</legend>
        <div class="row-f">Clé <select id="addk-type"><option value="sym">Symbol</option><option value="str">String</option><option value="int">Integer</option></select>
        <input id="addk-val" placeholder="clé"></div>
        <div class="row-f">Valeur <select id="add-type">${typeOptions('int')}</select>
        <input id="add-val" placeholder="valeur"></div>
        <button id="add-do">Ajouter</button></fieldset>`;
      if (n.def === undefined) h += '<button id="add-def" class="small">Ajouter une valeur par défaut</button>';
    } else if (n.t === 'object') {
      h += `<fieldset><legend>Ajouter une variable d'instance</legend>
        <input id="addk-val" placeholder="@nom">
        <select id="add-type">${typeOptions('nil')}</select><input id="add-val" placeholder="valeur">
        <button id="add-do">Ajouter</button></fieldset>`;
    }

    // Opérations par rapport au parent
    if (parent && ['item', 'entry', 'ivar', 'default', 'wivar'].includes(row.kind)) {
      h += '<fieldset><legend>Dans le parent</legend>';
      if (row.kind === 'entry') h += keyEditorHTML(row);
      if (row.kind === 'item') h += `<button id="dup-item" class="small">Dupliquer (copie superficielle)</button> `;
      h += `<button id="del-item" class="danger small">Supprimer ${row.kind === 'item' ? 'cet élément' : row.kind === 'entry' ? 'cette entrée' : row.kind === 'default' ? 'la valeur par défaut' : 'cette variable'}</button></fieldset>`;
    }

    // Changement de type
    h += `<fieldset><legend>Changer le type</legend><select id="chg-type">${typeOptions(n.t)}</select>
      <input id="chg-val" placeholder="valeur initiale"> <button id="chg-do">Changer…</button></fieldset>`;
    if (row.expandable) h += '<button id="expand-all" class="small">Déplier tout le sous-arbre</button>';
    box.innerHTML = h;
    bindDetail(row);
    if (focusEditor) {
      const f = box.querySelector('.d-editor textarea, .d-editor input, .d-editor select');
      if (f) f.focus();
    }
  }

  function describeOrig(n) {
    const s = state.orig.get(n);
    return s ? M.summary(s, 60) : '';
  }

  function keyEditorHTML(row) {
    const k = row.key;
    if (!['sym', 'str', 'int'].includes(k.t)) return `<div class="row-f">Clé : <code>${esc(M.keyLabel(k, row.index))}</code> (clé complexe, non éditable)</div>`;
    const v = k.t === 'sym' ? M.symName(k) : k.t === 'int' ? String(k.v) : M.strView(k).text;
    return `<div class="row-f">Clé (${M.typeLabel(k)}) <input id="key-val" value="${esc(v)}"> <button id="key-do" class="small">Renommer la clé</button></div>`;
  }

  function editorHTML(row) {
    const n = row.node;
    switch (n.t) {
      case 'nil': case 'true': case 'false':
        return `<label>Valeur <select id="ed-bool"><option>true</option><option>false</option><option>nil</option></select></label>`;
      case 'int':
        return `<label>Valeur entière <input id="ed-num" class="mono" value="${esc(String(n.v))}" inputmode="numeric"></label>
          <button id="ed-apply">Appliquer</button><div class="hint">Les valeurs hors de ±2³⁰ sont écrites en Bignum automatiquement.</div>`;
      case 'float':
        return `<label>Valeur flottante <input id="ed-num" class="mono" value="${esc(M.formatFloat(n.v))}"></label>
          <button id="ed-apply">Appliquer</button><div class="hint">Accepte aussi inf, -inf, nan.</div>`;
      case 'sym':
        return `<label>Symbole <span class="mono">:</span><input id="ed-sym" class="mono" value="${esc(M.symName(n))}"></label>
          <button id="ed-apply">Appliquer</button><div class="hint">Un nouveau nom crée un nouveau symbole ; un nom existant réutilise le symbole (symlink).</div>`;
      case 'str': {
        if (n.zs) {
          return `<div class="lbl">Script Ruby (décompressé de zlib, ${n.bytes.length} o compressés)</div>
            <textarea id="ed-script" class="code" spellcheck="false">${esc(n.zs.text)}</textarea>
            <button id="ed-apply">Appliquer et recompresser</button>`;
        }
        const v = M.strView(n);
        const hex = state.hexMode.has(n) || v.mode === 'hex';
        let h = '';
        if (v.mode === 'foreign') h += `<div class="lbl">Aperçu (${esc(v.enc)}, lecture seule)</div><pre class="preview">${esc(v.text)}</pre>`;
        if (hex || v.mode === 'foreign') {
          h += `<div class="lbl">Octets (hexadécimal)</div><textarea id="ed-hex" class="mono" spellcheck="false">${esc(M.toHex(n.bytes))}</textarea>`;
        } else {
          h += `<div class="lbl">Texte (${esc(v.enc || 'binaire, UTF-8 valide')})</div><textarea id="ed-str" spellcheck="false">${esc(v.text)}</textarea>`;
        }
        h += '<button id="ed-apply">Appliquer</button>';
        if (v.mode === 'text') h += ` <button id="ed-hextoggle" class="small">${hex ? 'Éditer en texte' : 'Éditer en hex'}</button>`;
        return h;
      }
      case 'userdef': return userdefEditorHTML(n);
      case 'regexp':
        return `<label>Source <input id="ed-re" class="mono" value="${esc(M.utf8(n.bytes))}"></label>
          <label>Options <input id="ed-reopts" type="number" min="0" max="255" value="${n.opts}" style="width:5em"></label>
          <button id="ed-apply">Appliquer</button><div class="hint">Options : 1 = i, 2 = x, 4 = m</div>`;
      case 'class': case 'module':
        return `<label>Nom <input id="ed-cname" class="mono" value="${esc(M.latin1(n.bytes))}"></label> <button id="ed-apply">Appliquer</button>`;
      case 'object': case 'struct':
        return `<label>Classe <input id="ed-cls" class="mono" value="${esc(M.symName(n.cls))}"></label> <button id="ed-apply-cls" class="small">Renommer la classe</button>`;
      case 'array': return `<div class="dim">${n.items.length} élément(s).</div>`;
      case 'hash': return `<div class="dim">${n.entries.length} entrée(s)${n.def !== undefined ? ', avec valeur par défaut' : ''}.</div>`;
      case 'usermarshal': case 'data':
        return `<div class="dim">Données ${n.t === 'data' ? '_dump_data' : 'marshal_dump'} de <code>${esc(M.symName(n.cls))}</code> : voir l'enfant <code>(data)</code>.</div>`;
    }
    return '';
  }

  function userdefEditorHTML(n) {
    const d = M.decoderFor(n);
    let h = '';
    if (d && d.name === 'Table') {
      const t = d.dec.decode(n.bytes);
      let tv = state.tableView.get(n) || { z: 0, x0: 0, y0: 0 };
      state.tableView.set(n, tv);
      const W = Math.min(16, t.xs), H = Math.min(16, t.ys);
      tv.x0 = Math.max(0, Math.min(tv.x0, t.xs - W));
      tv.y0 = Math.max(0, Math.min(tv.y0, t.ys - H));
      h += `<div class="lbl">Table ${t.xs} × ${t.ys} × ${t.zs} (dim ${t.dim}, ${t.size} valeurs int16)</div>`;
      if (t.size === 0) return h + '<div class="dim">Table vide.</div>';
      h += `<div class="tbl-nav">z <select id="tb-z">${Array.from({ length: t.zs }, (_, z) => `<option${z === tv.z ? ' selected' : ''}>${z}</option>`).join('')}</select>
        x <input id="tb-x0" type="number" min="0" max="${t.xs - 1}" value="${tv.x0}"> y <input id="tb-y0" type="number" min="0" max="${t.ys - 1}" value="${tv.y0}">
        <button data-mv="-1,0">◀</button><button data-mv="1,0">▶</button><button data-mv="0,-1">▲</button><button data-mv="0,1">▼</button></div>`;
      h += '<div class="tbl-wrap"><table class="grid"><tr><th></th>';
      for (let x = tv.x0; x < tv.x0 + W; x++) h += `<th>${x}</th>`;
      h += '</tr>';
      for (let y = tv.y0; y < tv.y0 + H; y++) {
        h += `<tr><th>${y}</th>`;
        for (let x = tv.x0; x < tv.x0 + W; x++) h += `<td><input data-x="${x}" data-y="${y}" value="${t.get(x, y, tv.z)}"></td>`;
        h += '</tr>';
      }
      h += '</table></div>';
    } else if (d) {
      const vals = d.dec.decode(n.bytes);
      h += `<div class="lbl">${d.name}</div><div class="quad">` +
        d.dec.fields.map((f, i) => `<label>${f}<input data-q="${i}" class="mono" value="${d.dec.kind === 'float' ? +vals[i].toPrecision(15) : vals[i]}"></label>`).join('') +
        '</div><button id="ed-quad">Appliquer</button>';
    }
    h += `<details${d ? '' : ' open'}><summary>Octets bruts (_dump, ${n.bytes.length} o)</summary>
      <textarea id="ed-hex" class="mono" spellcheck="false">${esc(M.toHex(n.bytes.length > 65536 ? n.bytes.subarray(0, 65536) : n.bytes))}</textarea>
      ${n.bytes.length > 65536 ? '<div class="hint">Trop volumineux pour l\'édition hexadécimale (affichage tronqué).</div>' : '<button id="ed-hexapply">Appliquer les octets</button>'}</details>`;
    return h;
  }

  function bindDetail(row) {
    const box = $('#detail');
    const n = row.node;
    const on = (sel, ev, fn) => { const el = box.querySelector(sel); if (el) el.addEventListener(ev, fn); };
    const guard = (fn) => () => { try { fn(); } catch (e) { alert(e.message); } };
    const enter = (sel, fn) => on(sel, 'keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fn(); } });

    // scalaires
    const bool = box.querySelector('#ed-bool');
    if (bool) { bool.value = n.t; bool.addEventListener('change', () => setScalarFromText(row, bool.value)); }
    const applyScalar = guard(() => {
      const el = box.querySelector('#ed-num, #ed-sym, #ed-str');
      if (!el) return;
      const err = setScalarFromText(row, el.value);
      if (err) throw new Error(err);
    });
    if (box.querySelector('#ed-num, #ed-sym, #ed-str')) {
      on('#ed-apply', 'click', applyScalar);
      enter('#ed-num', applyScalar);
      enter('#ed-sym', applyScalar);
    }
    on('#ed-str', 'keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) applyScalar(); });
    on('#ed-hextoggle', 'click', () => { state.hexMode.has(n) ? state.hexMode.delete(n) : state.hexMode.add(n); renderDetail(); });
    if (box.querySelector('#ed-hex') && (n.t === 'str')) {
      on('#ed-apply', 'click', guard(() => {
        const b = M.parseHex(box.querySelector('#ed-hex').value);
        edit(n, (x) => { x.bytes = b; }, `${row.path} (octets)`, row.path);
      }));
    }
    on('#ed-hexapply', 'click', guard(() => {
      const b = M.parseHex(box.querySelector('#ed-hex').value);
      edit(n, (x) => { x.bytes = b; }, `${row.path} (octets)`, row.path);
    }));
    // script zlib
    on('#ed-script', 'keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); const t = e.target; const s = t.selectionStart; t.setRangeText('  ', s, t.selectionEnd, 'end'); }
    });
    if (n.zs) on('#ed-apply', 'click', async () => {
      const text = box.querySelector('#ed-script').value;
      if (text === n.zs.text) return;
      try {
        const comp = await M.zlib.deflate(M.encodeUtf8(text));
        edit(n, (x) => { x.bytes = comp; x.zs = { text }; }, `script ${row.path}`, row.path);
        toast('Script recompressé');
      } catch (e) { alert('Compression impossible : ' + e.message); }
    });
    // regexp, class/module
    if (n.t === 'regexp') on('#ed-apply', 'click', guard(() => {
      const src = M.encodeUtf8(box.querySelector('#ed-re').value);
      const opts = +box.querySelector('#ed-reopts').value & 0xff;
      edit(n, (x) => { x.bytes = src; x.opts = opts; }, `${row.path} (regexp)`, row.path);
    }));
    if (n.t === 'class' || n.t === 'module') on('#ed-apply', 'click', guard(() => {
      const b = M.encodeUtf8(box.querySelector('#ed-cname').value.trim());
      edit(n, (x) => { x.bytes = b; }, `${row.path} (nom)`, row.path);
    }));
    on('#ed-apply-cls', 'click', guard(() => {
      const name = box.querySelector('#ed-cls').value.trim();
      if (!name) throw new Error('Nom vide');
      edit(n, (x) => { x.cls = M.mkSym(name); }, `${row.path} classe → ${name}`, row.path);
    }));
    // userdef
    const d = M.decoderFor(n);
    if (d && d.name === 'Table') {
      const tv = state.tableView.get(n);
      const t = d.dec.decode(n.bytes);
      on('#tb-z', 'change', (e) => { tv.z = +e.target.value; renderDetail(); });
      on('#tb-x0', 'change', (e) => { tv.x0 = +e.target.value || 0; renderDetail(); });
      on('#tb-y0', 'change', (e) => { tv.y0 = +e.target.value || 0; renderDetail(); });
      box.querySelectorAll('[data-mv]').forEach((b) => b.addEventListener('click', () => {
        const [dx, dy] = b.dataset.mv.split(',').map(Number);
        tv.x0 += dx * 8; tv.y0 += dy * 8; renderDetail();
      }));
      box.querySelectorAll('.grid input').forEach((inp) => inp.addEventListener('change', () => {
        const x = +inp.dataset.x, y = +inp.dataset.y;
        const v = Number(inp.value);
        if (!Number.isInteger(v) || v < -32768 || v > 32767) { alert('Valeur int16 attendue (-32768..32767)'); inp.value = t.get(x, y, tv.z); return; }
        edit(n, (nd) => { nd.bytes = M.decoders.Table.set(nd.bytes, x, y, tv.z, v); }, `${row.path}[${x},${y},${tv.z}] = ${v}`, row.path, { keepDetail: true });
        inp.classList.add('cell-mod');
      }));
    } else if (d) {
      on('#ed-quad', 'click', guard(() => {
        const vals = [...box.querySelectorAll('[data-q]')].map((i) => {
          const v = d.dec.kind === 'float' ? M.parseFloatText(i.value) : M.parseIntText(i.value);
          if (d.dec.kind === 'int' && (typeof v !== 'number' || v < -2147483648 || v > 2147483647)) throw new Error('int32 attendu');
          return v;
        });
        edit(n, (x) => { x.bytes = d.dec.encode(vals); }, `${row.path} = ${d.name}(${vals.join(', ')})`, row.path);
      }));
    }

    // ajout dans conteneur
    on('#add-do', 'click', guard(() => {
      const type = box.querySelector('#add-type').value;
      const val = freshNode(type, box.querySelector('#add-val').value);
      if (n.t === 'array') {
        let pos = Math.max(0, Math.min(n.items.length, +box.querySelector('#add-pos').value));
        edit(n, (x) => { x.items.splice(pos, 0, val); }, `ajout ${row.path}[${pos}]`, row.path);
        revealChild(row, pos);
      } else if (n.t === 'hash') {
        const kt = box.querySelector('#addk-type').value;
        const kv = box.querySelector('#addk-val').value;
        const key = freshNode(kt, kv);
        const lbl = M.keyLabel(key, 0);
        if (n.entries.some(([k], i) => M.keyLabel(k, i) === lbl) && !confirm(`La clé ${lbl} existe déjà. Ajouter un doublon quand même ?`)) return;
        edit(n, (x) => { x.entries.push([key, val]); }, `ajout ${row.path}[${lbl}]`, row.path);
        revealChild(row, n.entries.length - 1);
      } else if (n.t === 'object') {
        let name = box.querySelector('#addk-val').value.trim();
        if (!name) throw new Error('Nom de variable vide');
        if (!name.startsWith('@')) name = '@' + name;
        if (n.ivars.some(([k]) => M.symName(k) === name)) throw new Error(`${name} existe déjà`);
        edit(n, (x) => { x.ivars.push([M.mkSym(name), val]); }, `ajout ${row.path}.${name}`, row.path);
        revealChild(row, n.ivars.length - 1);
      }
    }));
    on('#add-def', 'click', () => edit(n, (x) => { x.def = { t: 'nil' }; }, `${row.path} défaut = nil`, row.path));

    // parent
    const parent = row.parent && row.parent.node;
    on('#del-item', 'click', () => {
      const msg = `Supprimer ${row.path} ?` + (n.refs > 1 ? '\n(L\'objet est partagé : seules les autres références le conserveront.)' : '');
      if (!confirm(msg)) return;
      const pr = row.parent;
      const desc = 'suppression ' + row.path;
      if (row.kind === 'item') edit(parent, (x) => { x.items.splice(row.index, 1); }, desc, pr.path);
      else if (row.kind === 'entry') edit(parent, (x) => { x.entries.splice(row.index, 1); }, desc, pr.path);
      else if (row.kind === 'default') edit(parent, (x) => { delete x.def; }, desc, pr.path);
      else if (row.kind === 'ivar') edit(parent, (x) => { x.ivars.splice(row.index, 1); }, desc, pr.path);
      else if (row.kind === 'wivar') edit(parent, (x) => { x.ivars = x.ivars.filter((_, i) => i !== row.index); }, desc, pr.path);
      tree.selectedPath = pr.path;
      renderDetail();
    });
    on('#dup-item', 'click', () => {
      const copy = D.snapshot(n);
      delete copy._o; delete copy._e; delete copy.refs;
      edit(parent, (x) => { x.items.splice(row.index + 1, 0, copy); }, 'duplication ' + row.path, row.parent.path);
    });
    on('#key-do', 'click', guard(() => {
      const k = row.key;
      const v = box.querySelector('#key-val').value;
      const fresh = freshNode(k.t, v);
      edit(k, (x) => M.replaceNode(x, fresh), `clé ${row.path} → ${M.keyLabel(fresh, 0)}`, row.path);
      tree.selectedPath = row.parent.path + '[' + M.keyLabel(k, row.index) + ']';
      renderDetail();
    }));

    // changement de type
    on('#chg-do', 'click', guard(() => {
      const type = box.querySelector('#chg-type').value;
      const fresh = freshNode(type, box.querySelector('#chg-val').value);
      let msg = `Remplacer ${M.typeLabel(n)} (${M.summary(n, 40)}) par ${M.typeLabel(fresh)} (${M.summary(fresh, 40)}) ?`;
      if (n.refs > 1) msg += `\n\nAttention : cet objet est partagé (${n.refs} références), le changement s'appliquera partout.`;
      if (M.children(n).length) msg += '\n\nLe contenu actuel sera perdu (annulable avec Ctrl+Z).';
      if (!confirm(msg)) return;
      edit(n, (x) => M.replaceNode(x, fresh), `${row.path} : type → ${M.typeLabel(fresh)}`, row.path);
    }));
    on('#expand-all', 'click', () => tree.expandAll(row, 3000));
  }

  function revealChild(row, pos) {
    const kids = M.children(row.node);
    const c = kids[pos];
    if (!c) return;
    const steps = window.TreeView.stepsOf(row).concat([{ parentPath: row.path, pos, path: row.path + c.label }]);
    tree.reveal(steps, row.path + c.label);
  }

  /* ---------- Fil d'Ariane ---------- */
  function renderCrumbs(row) {
    const nav = $('#crumbs');
    if (!row) { nav.innerHTML = ''; return; }
    const steps = window.TreeView.stepsOf(row);
    let h = '<a data-k="-1">root</a>';
    steps.forEach((s, i) => {
      const label = s.path.slice(s.parentPath.length);
      h += `<span class="sep"></span><a data-k="${i}">${esc(label)}</a>`;
    });
    nav.innerHTML = h;
    nav.scrollLeft = nav.scrollWidth;
    nav.onclick = (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      const k = +a.dataset.k;
      if (k < 0) tree.reveal([], 'root');
      else tree.reveal(steps.slice(0, k + 1), steps[k].path);
    };
  }

  function copyText(text) {
    const done = () => toast('Copié : ' + text);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { prompt('Copiez le chemin :', text); }
      ta.remove();
    }
  }

  /* ================================================================ */
  /* Recherche                                                         */
  /* ================================================================ */
  function runSearch() {
    if (!state.doc) return;
    const q = $('#q').value;
    if (!q) { $('#results').hidden = true; return; }
    const opts = {
      mode: $('#q-mode').value,
      caseSensitive: $('#q-case').checked,
      type: $('#q-type').value,
      scope: $('#q-scope').value,
      limit: 5000,
    };
    if (opts.mode === 'regex') {
      try { new RegExp(q); } catch (e) { $('#q-status').textContent = 'Regex invalide : ' + e.message; return; }
    }
    if (state.search) state.search.cancel();
    $('#q-status').textContent = 'Recherche…';
    $('#results').hidden = false;
    $('#res-list').innerHTML = '';
    state.search = S.run(state.doc.root, q, opts, (results, info) => {
      state.search = null;
      state.results = results;
      state.resPage = 0;
      $('#q-status').textContent = `${results.length}${info.truncated ? '+' : ''} résultat(s) · ${info.visited.toLocaleString('fr')} nœuds parcourus`;
      renderResults();
      if (results.length === 1) gotoResult(0);
    }, (visited, found) => {
      $('#q-status').textContent = `Recherche… ${visited.toLocaleString('fr')} nœuds, ${found} résultat(s)`;
    });
  }
  const RES_PAGE = 50;
  function renderResults() {
    const r = state.results;
    const pages = Math.max(1, Math.ceil(r.length / RES_PAGE));
    const p = Math.min(state.resPage, pages - 1);
    let h = '';
    for (let i = p * RES_PAGE; i < Math.min(r.length, (p + 1) * RES_PAGE); i++) {
      const x = r[i];
      h += `<li data-r="${i}"><span class="where w-${esc(x.where)}">${esc(x.where)}</span><code>${esc(x.path)}</code>` +
        `<span class="rv">= ${esc(M.summary(x.node, 60))}</span></li>`;
    }
    $('#res-list').innerHTML = h || '<li class="dim">Aucun résultat.</li>';
    $('#res-pager').innerHTML = pages > 1
      ? `<button data-p="${p - 1}" ${p === 0 ? 'disabled' : ''}>‹</button> page ${p + 1}/${pages} <button data-p="${p + 1}" ${p >= pages - 1 ? 'disabled' : ''}>›</button>`
      : '';
  }
  function gotoResult(i) {
    const r = state.results[i];
    if (!r) return;
    $('#res-list').querySelectorAll('li.cur').forEach((li) => li.classList.remove('cur'));
    const li = $(`#res-list li[data-r="${i}"]`);
    if (li) li.classList.add('cur');
    if (!tree.reveal(r.steps, r.path)) toast('Nœud introuvable (l\'arbre a changé ?) — relancez la recherche');
  }

  /* ================================================================ */
  /* Export                                                            */
  /* ================================================================ */
  function outName(ext) {
    const name = state.fileName || 'fichier';
    if ($('#keep-name').checked && !ext) return name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const e = ext || (dot > 0 ? name.slice(dot) : '');
    return ext ? base + ext : base + '_edited' + e;
  }
  function saveBlob(bytes, name, type) {
    const blob = new Blob([bytes], { type: type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function download() {
    if (!state.doc) return;
    let bytes;
    try { bytes = M.dumpFile(state.doc); } catch (e) { alert('Erreur à l\'écriture : ' + e.message); return; }
    // Vérification : le fichier produit doit se relire
    try { M.load(bytes); } catch (e) { alert('Le fichier produit ne se relit pas : ' + e.message); return; }
    const name = outName();
    saveBlob(bytes, name);
    toast(`Téléchargé : ${name} (${fmtSize(bytes.length)})`);
  }
  function exportJSON() {
    if (!state.doc) return;
    try {
      saveBlob(M.toJSON(state.doc.root), outName('.json'), 'application/json');
    } catch (e) { alert('Export JSON impossible : ' + e.message); }
  }
  function showChanges() {
    if (!state.doc) return;
    const res = D.compute(state.doc, state.orig, state.editPaths);
    let h = D.renderHTML(res, state.doc.prefix.length);
    if (state.undo.length) {
      h += '<h3>Historique</h3><ol class="history">' + state.undo.map((c) => `<li>${esc(c.desc)}</li>`).join('') + '</ol>';
    }
    openModal('Modifications', h);
    $('#modal-body').addEventListener('click', (e) => {
      const code = e.target.closest('.changes code.path');
      if (!code) return;
      const c = res.changes.find((x) => x.path === code.textContent);
      if (c && c.reachable) { closeModal(); gotoNode(c.node); }
    }, { once: true });
  }
  function gotoNode(node) {
    // retrouve les étapes jusqu'à un nœud (première occurrence)
    const seen = new Set();
    const stack = [{ node: state.doc.root, path: 'root', parent: null }];
    while (stack.length) {
      const e = stack.pop();
      if (e.node === node) {
        const steps = [];
        for (let x = e; x.parent; x = x.parent) steps.unshift({ parentPath: x.parent.path, pos: x.pos, path: x.path });
        tree.reveal(steps, e.path);
        return;
      }
      if (seen.has(e.node)) continue;
      seen.add(e.node);
      const kids = M.children(e.node);
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i].node, path: e.path + kids[i].label, parent: e, pos: kids[i].pos });
    }
  }

  /* ---------- Modale / toast ---------- */
  function openModal(title, html) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('#modal').hidden = false;
  }
  function closeModal() { $('#modal').hidden = true; }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ================================================================ */
  /* Initialisation                                                    */
  /* ================================================================ */
  function init() {
    tree = new window.TreeView($('#tree'), {
      onSelect: (row, focus) => renderDetail(focus),
      isModified: (n) => state.modified.has(n),
      hasModifiedInside,
      onInlineEdit: setScalarFromText,
    });

    $('#btn-open').onclick = () => $('#file').click();
    $('#dz-open').onclick = () => $('#file').click();
    $('#file').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
    $('#btn-undo').onclick = undo;
    $('#btn-redo').onclick = redo;
    $('#btn-download').onclick = download;
    $('#btn-json').onclick = exportJSON;
    $('#btn-changes').onclick = showChanges;
    $('#btn-copy-path').onclick = () => { const r = tree.selectedRow(); if (r) copyText(r.path); };
    $('#btn-collapse').onclick = () => tree.collapseAll();
    $('#page-size').onchange = (e) => { tree.pageSize = +e.target.value; tree.pages.clear(); tree.rebuild(); };
    $('#modal-close').onclick = closeModal;
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

    // recherche
    $('#q-go').onclick = runSearch;
    $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); if (e.key === 'Escape') e.target.blur(); });
    for (const id of ['#q-mode', '#q-type', '#q-scope', '#q-case']) $(id).addEventListener('change', () => { if ($('#q').value) runSearch(); });
    $('#res-list').addEventListener('click', (e) => { const li = e.target.closest('li[data-r]'); if (li) gotoResult(+li.dataset.r); });
    $('#res-pager').addEventListener('click', (e) => { const b = e.target.closest('button[data-p]'); if (b) { state.resPage = +b.dataset.p; renderResults(); } });
    $('#res-close').onclick = () => { $('#results').hidden = true; };

    // glisser-déposer
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging');
      const f = e.dataTransfer.files[0];
      if (f) openFile(f);
    });

    // raccourcis
    window.addEventListener('keydown', (e) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      const k = e.key.toLowerCase();
      if (e.key === 'Escape' && !$('#modal').hidden) { closeModal(); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (k === 'f') { e.preventDefault(); $('#q').focus(); $('#q').select(); }
      else if (k === 's') { e.preventDefault(); download(); }
      else if (k === 'o') { e.preventDefault(); $('#file').click(); }
      else if (!inField && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (!inField && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    });
    window.addEventListener('beforeunload', (e) => {
      if (state.modified.size) { e.preventDefault(); e.returnValue = ''; }
    });
    updateButtons();
  }

  // Exposé pour le débogage / les tests manuels dans la console
  window.MarshalApp = { state, loadBytes, undo, redo, edit, download };
  document.addEventListener('DOMContentLoaded', init);
})();
