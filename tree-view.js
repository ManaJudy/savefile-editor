/* tree-view.js — Arbre virtualisé (seules les lignes visibles sont dans le DOM),
 * pagination des gros tableaux/hashs, sélection, édition en ligne. */
(function (G) {
  'use strict';
  const M = G.MarshalLib;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  M.esc = esc;

  const TYPE_CLASS = {
    nil: 'ty-nil', true: 'ty-bool', false: 'ty-bool', int: 'ty-num', float: 'ty-num', str: 'ty-str', sym: 'ty-sym',
    array: 'ty-arr', hash: 'ty-hash', object: 'ty-obj', struct: 'ty-obj', userdef: 'ty-ud', usermarshal: 'ty-ud',
    data: 'ty-ud', regexp: 'ty-str', class: 'ty-cls', module: 'ty-cls',
  };
  const SCALARS = { int: 1, float: 1, str: 1, sym: 1 };

  class TreeView {
    /**
     * @param el conteneur
     * @param hooks {onSelect(row), isModified(node), hasModifiedInside(path), onInlineEdit(row, text) -> erreur|null}
     */
    constructor(el, hooks) {
      this.el = el;
      this.hooks = hooks;
      this.rowH = 24;
      this.pageSize = 100;
      this.expanded = new Set(['root']);
      this.pages = new Map();
      this.rows = [];
      this.root = null;
      this.selectedPath = null;
      this.flashPath = null;
      this.editing = null;
      el.classList.add('tree');
      el.innerHTML = '<div class="tree-spacer"></div><div class="tree-rows"></div>';
      this.spacer = el.firstChild;
      this.rowsEl = el.lastChild;
      this._raf = 0;
      el.addEventListener('scroll', () => this.schedule());
      new ResizeObserver(() => this.schedule()).observe(el);
      this.rowsEl.addEventListener('click', (e) => this.onClick(e));
      this.rowsEl.addEventListener('dblclick', (e) => this.onDblClick(e));
      this.rowsEl.addEventListener('keydown', (e) => {
        if (!e.target.classList.contains('pg-go') || e.key !== 'Enter') return;
        const hit = this.rowFromEvent(e);
        const p = Math.max(1, Math.min(hit.row.pages, parseInt(e.target.value, 10) || 1));
        this.setPage(hit.row.path, p - 1);
      });
      el.tabIndex = 0;
      el.addEventListener('keydown', (e) => this.onKey(e));
    }

    setRoot(root) {
      this.root = root;
      this.expanded = new Set(['root']);
      this.pages = new Map();
      this.selectedPath = 'root';
      this.rebuild();
      this.el.scrollTop = 0;
      this.select(0, true);
    }

    /* ---------- Aplatissement des nœuds visibles ---------- */
    rebuild() {
      const rows = [];
      if (this.root) {
        const stack = [];
        const walk = (node, path, depth, info, parent) => {
          const kids = M.children(node);
          const cycle = stack.includes(node);
          const row = {
            node, path, depth, label: info.label, kind: info.kind, index: info.index, pos: info.pos, key: info.key,
            parent, childCount: kids.length, cycle, expandable: kids.length > 0 && !cycle,
          };
          rows.push(row);
          if (!row.expandable || !this.expanded.has(path)) return;
          stack.push(node);
          const ps = this.pageSize;
          const pages = Math.ceil(kids.length / ps);
          let page = Math.min(this.pages.get(path) || 0, pages - 1);
          const from = page * ps, to = Math.min(kids.length, from + ps);
          if (pages > 1) rows.push({ pager: true, path, depth: depth + 1, page, pages, total: kids.length, from, to, parent: row });
          for (let i = from; i < to; i++) {
            const c = kids[i];
            walk(c.node, path + c.label, depth + 1, c, row);
          }
          if (pages > 1 && to - from > 20) rows.push({ pager: true, path, depth: depth + 1, page, pages, total: kids.length, from, to, parent: row, bottom: true });
          stack.pop();
        };
        walk(this.root, 'root', 0, { label: 'root', kind: 'root' }, null);
      }
      this.rows = rows;
      this.spacer.style.height = rows.length * this.rowH + 'px';
      this.render(true);
    }

    schedule() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this.render();
      });
    }

    render(force) {
      if (this.editing && !force) return;
      const top = this.el.scrollTop;
      const h = this.el.clientHeight || 600;
      const first = Math.max(0, Math.floor(top / this.rowH) - 10);
      const last = Math.min(this.rows.length, Math.ceil((top + h) / this.rowH) + 10);
      if (!force && this._range && this._range[0] === first && this._range[1] === last) return;
      this._range = [first, last];
      const html = [];
      for (let i = first; i < last; i++) html.push(this.rowHTML(this.rows[i], i));
      this.rowsEl.innerHTML = html.join('');
      this.editing = null;
    }

    rowHTML(r, i) {
      const style = `top:${i * this.rowH}px;padding-left:${8 + r.depth * 16}px`;
      if (r.pager) {
        const b = (p, txt, dis) => `<button class="pg" data-page="${p}" ${dis ? 'disabled' : ''}>${txt}</button>`;
        return `<div class="row pager" data-i="${i}" style="${style}">` +
          b(0, '«', r.page === 0) + b(r.page - 1, '‹', r.page === 0) +
          `<span class="pg-info">éléments ${r.from}–${r.to - 1} sur ${r.total} · page ${r.page + 1}/${r.pages}</span>` +
          b(r.page + 1, '›', r.page >= r.pages - 1) + b(r.pages - 1, '»', r.page >= r.pages - 1) +
          `<input class="pg-go" type="number" min="1" max="${r.pages}" placeholder="page" title="Aller à la page (Entrée)"></div>`;
      }
      const n = r.node;
      const sel = r.path === this.selectedPath ? ' sel' : '';
      const flash = r.path === this.flashPath ? ' flash' : '';
      const mod = this.hooks.isModified(n) ? ' mod' : this.hooks.hasModifiedInside(r.path) ? ' mod-in' : '';
      const tog = r.expandable ? `<span class="tog">${this.expanded.has(r.path) ? '▾' : '▸'}</span>` : '<span class="tog none"></span>';
      const cls = M.className(n);
      let badges = '';
      if (n.refs > 1) badges += `<span class="badge shared" title="Objet partagé (${n.refs} références) : une modification s'applique partout">⇄${n.refs}</span>`;
      if (r.cycle) badges += '<span class="badge cyc" title="Référence circulaire vers un parent">↺ cycle</span>';
      if (n.zs) badges += '<span class="badge zs">zlib</span>';
      const val = SCALARS[n.t] || n.t === 'nil' || n.t === 'true' || n.t === 'false' ? ' editable' : '';
      return `<div class="row${sel}${mod}${flash}" data-i="${i}" style="${style}">${tog}` +
        `<span class="key k-${r.kind}">${esc(r.label)}</span>` +
        `<span class="ty ${TYPE_CLASS[n.t] || ''}">${M.typeLabel(n)}</span>` +
        (cls ? `<span class="cls">${esc(cls)}</span>` : '') +
        `<span class="val${val}" title="${val ? 'Double-clic pour éditer' : ''}">${esc(M.summary(n, 120))}</span>${badges}</div>`;
    }

    rowFromEvent(e) {
      const el = e.target.closest('.row');
      if (!el) return null;
      return { el, i: +el.dataset.i, row: this.rows[+el.dataset.i] };
    }

    onClick(e) {
      const hit = this.rowFromEvent(e);
      if (!hit) return;
      const { row, i } = hit;
      if (row.pager) {
        const btn = e.target.closest('.pg');
        if (btn && !btn.disabled) this.setPage(row.path, +btn.dataset.page);
        return;
      }
      if (e.target.classList.contains('tog')) {
        this.toggle(row.path);
        return;
      }
      if (e.target.closest('.inline-edit')) return;
      this.select(i);
    }

    onDblClick(e) {
      const hit = this.rowFromEvent(e);
      if (!hit || hit.row.pager) return;
      if (e.target.classList.contains('editable')) this.startInlineEdit(hit);
      else if (hit.row.expandable && !e.target.classList.contains('tog')) this.toggle(hit.row.path);
    }

    startInlineEdit({ el, row }) {
      const n = row.node;
      const valEl = el.querySelector('.val');
      let input;
      if (n.t === 'nil' || n.t === 'true' || n.t === 'false') {
        input = document.createElement('select');
        input.innerHTML = '<option>true</option><option>false</option><option>nil</option>';
        input.value = n.t;
      } else {
        input = document.createElement('input');
        input.type = 'text';
        if (n.t === 'str') {
          if (n.zs) return this.hooks.onSelect(row, true);
          const v = M.strView(n);
          if (v.mode !== 'text' || v.text.includes('\n')) return this.hooks.onSelect(row, true);
          input.value = v.text;
        } else if (n.t === 'sym') input.value = M.symName(n);
        else if (n.t === 'float') input.value = M.formatFloat(n.v);
        else input.value = String(n.v);
      }
      input.className = 'inline-edit';
      valEl.replaceWith(input);
      this.editing = input;
      input.focus();
      if (input.select) input.select();
      let done = false;
      const commit = (ok) => {
        if (done) return;
        done = true;
        this.editing = null;
        if (ok) {
          const err = this.hooks.onInlineEdit(row, input.value);
          if (err) { alert(err); }
        }
        this.render(true);
        this.el.focus();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(true);
        else if (e.key === 'Escape') commit(false);
      });
      input.addEventListener('blur', () => commit(input.tagName === 'SELECT'));
      if (input.tagName === 'SELECT') input.addEventListener('change', () => commit(true));
    }

    onKey(e) {
      if (e.target !== this.el) return;
      const i = this.rows.findIndex((r) => r.path === this.selectedPath && !r.pager);
      const row = this.rows[i];
      const move = (j) => {
        while (j >= 0 && j < this.rows.length && this.rows[j].pager) j += j > i ? 1 : -1;
        if (j >= 0 && j < this.rows.length) { this.select(j); this.scrollToIndex(j); }
      };
      if (e.key === 'ArrowDown') { move(i + 1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { move(i - 1); e.preventDefault(); }
      else if (e.key === 'ArrowRight' && row && row.expandable) { if (!this.expanded.has(row.path)) this.toggle(row.path); else move(i + 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' && row) {
        if (this.expanded.has(row.path) && row.expandable) this.toggle(row.path);
        else if (row.parent) { const j = this.rows.indexOf(row.parent); move(j); }
        e.preventDefault();
      } else if (e.key === 'Enter' && row) {
        const el = this.rowsEl.querySelector(`.row[data-i="${i}"]`);
        if (el && el.querySelector('.editable')) this.startInlineEdit({ el, row });
        e.preventDefault();
      }
    }

    toggle(path) {
      if (this.expanded.has(path)) this.expanded.delete(path);
      else this.expanded.add(path);
      this.rebuild();
    }
    setPage(path, p) {
      this.pages.set(path, p);
      this.rebuild();
      const j = this.rows.findIndex((r) => r.pager && r.path === path);
      if (j >= 0) this.scrollToIndex(j);
    }
    expandAll(row, maxRows) {
      // déplie récursivement (borné) à partir d'une ligne
      let budget = maxRows || 2000;
      const rec = (node, path, seen) => {
        if (budget <= 0 || seen.has(node)) return;
        const kids = M.children(node);
        if (!kids.length) return;
        this.expanded.add(path);
        seen.add(node);
        budget -= Math.min(kids.length, this.pageSize);
        const page = this.pages.get(path) || 0;
        for (const c of kids.slice(page * this.pageSize, (page + 1) * this.pageSize)) rec(c.node, path + c.label, seen);
        seen.delete(node);
      };
      rec(row.node, row.path, new Set());
      this.rebuild();
    }
    collapseAll() {
      this.expanded = new Set(['root']);
      this.rebuild();
    }

    select(i, force) {
      const row = this.rows[i];
      if (!row || row.pager) return;
      const same = this.selectedPath === row.path;
      this.selectedPath = row.path;
      // mise à jour en place (un re-rendu casserait le double-clic)
      this.rowsEl.querySelectorAll('.row.sel').forEach((el) => el.classList.remove('sel'));
      const el = this.rowsEl.querySelector(`.row[data-i="${i}"]`);
      if (el) el.classList.add('sel');
      if (!same || force) this.hooks.onSelect(row);
    }
    selectedRow() {
      return this.rows.find((r) => !r.pager && r.path === this.selectedPath) || null;
    }
    scrollToIndex(i) {
      const top = i * this.rowH;
      const h = this.el.clientHeight;
      if (top < this.el.scrollTop || top + this.rowH > this.el.scrollTop + h) this.el.scrollTop = Math.max(0, top - h / 3);
      this.render(true);
    }

    /**
     * Révèle un nœud à partir de la liste d'étapes [{parentPath, index, path}] (racine exclue).
     */
    reveal(steps, targetPath) {
      for (const s of steps) {
        this.expanded.add(s.parentPath);
        if (s.pos !== undefined) this.pages.set(s.parentPath, Math.floor(s.pos / this.pageSize));
      }
      this.rebuild();
      const i = this.rows.findIndex((r) => !r.pager && r.path === targetPath);
      if (i < 0) return false;
      this.flashPath = targetPath;
      this.select(i, true);
      this.scrollToIndex(i);
      setTimeout(() => { if (this.flashPath === targetPath) { this.flashPath = null; this.render(true); } }, 1600);
      this.el.focus({ preventScroll: true });
      return true;
    }

    /** Étapes pour révéler une ligne déjà construite (pour le fil d'Ariane). */
    static stepsOf(row) {
      const chain = [];
      for (let r = row; r && r.parent; r = r.parent) chain.unshift({ parentPath: r.parent.path, pos: r.pos, path: r.path, kind: r.kind });
      return chain;
    }
  }

  G.TreeView = TreeView;
})(window);
