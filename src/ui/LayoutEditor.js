const DESIGN_W = 1536;
const DESIGN_H = 1024;
const STORAGE_KEY = 'D8M4_LAYOUT_DEV_V3';

export class LayoutEditor {
  constructor({ machine }) {
    this.machine = machine;
    this.enabled = false;
    this.selected = null;
    this.drag = null;
    this.snap = 1;
    this.saved = this.#loadSaved();
    this.#buildUi();
    this.#applySaved();
    this.#bind();
    this.#refreshTargetList();
  }

  #targets() {
    return [...this.machine.querySelectorAll(`
      .live-layer button,
      .live-layer input,
      .live-layer .timer-display,
      .live-layer .brand-block,
      .live-layer .utility-mask
    `)].filter(el => !el.closest('.layout-editor'));
  }

  #key(el) {
    if (el.id) return `#${el.id}`;
    if (el.dataset.soundscape) return `soundscape:${el.dataset.soundscape}`;
    if (el.dataset.effectButton) return `effect:${el.dataset.effectButton}`;
    if (el.dataset.frs) return `frs:${el.dataset.frs}`;
    if (el.dataset.rocker) return `rocker:${el.dataset.rocker}`;
    if (el.dataset.future) return `future:${el.dataset.future}`;
    const useful = [...el.classList].filter(c => !['is-active','active'].includes(c));
    return useful.length ? `class:${useful.join('.')}` : null;
  }

  #label(el) {
    const key = this.#key(el) || el.tagName;
    const text = (el.textContent || '').replace(/\s+/g,' ').trim();
    if (el.id === 'utility-panel') return '#utility-panel — BUTTON BACKING PANEL';
    return text ? `${key} — ${text.slice(0,28)}` : key;
  }

  #buildUi() {
    this.panel = document.createElement('aside');
    this.panel.className = 'layout-editor';
    this.panel.innerHTML = `
      <div class="le-title"><b>LAYOUT DEV</b><button data-le="toggle">EDIT OFF</button></div>
      <div class="le-row"><label>Target</label><select data-le="target"></select></div>
      <div class="le-values">
        <label>X <input data-le="x" type="number" step="1"></label>
        <label>Y <input data-le="y" type="number" step="1"></label>
        <label>W <input data-le="w" type="number" step="1" min="1"></label>
        <label>H <input data-le="h" type="number" step="1" min="1"></label>
      </div>
      <div class="le-row"><label>Snap</label><select data-le="snap"><option>1</option><option>2</option><option>4</option><option>8</option><option>16</option></select><span>px</span></div>
      <div class="le-actions">
        <button data-le="copy">COPY CSS</button>
        <button data-le="export">EXPORT JSON</button>
        <button data-le="reset-one">RESET ONE</button>
        <button data-le="reset-all">RESET ALL</button>
      </div>
      <div class="le-help">Edit ON: click a physical control to select it. Drag the box to move. Drag the square handle to resize. Arrow keys nudge; Shift+Arrow = 10px. Changes autosave in this browser.</div>
      <textarea data-le="css" readonly></textarea>
    `;
    document.body.appendChild(this.panel);

    this.box = document.createElement('div');
    this.box.className = 'layout-selection-box';
    this.box.innerHTML = `<div class="layout-selection-label"></div><i class="layout-resize-handle" title="Resize"></i>`;
    this.machine.appendChild(this.box);
    this.box.hidden = true;
  }

  #bind() {
    this.panel.addEventListener('click', e => {
      const action = e.target?.dataset?.le;
      if (!action) return;
      if (action === 'toggle') this.setEnabled(!this.enabled);
      if (action === 'copy') this.copyCss();
      if (action === 'export') this.exportJson();
      if (action === 'reset-one') this.resetSelected();
      if (action === 'reset-all') this.resetAll();
    });

    this.panel.querySelector('[data-le="target"]').addEventListener('change', e => {
      const key = e.target.value;
      this.select(this.#targets().find(el => this.#key(el) === key) || null);
    });
    this.panel.querySelector('[data-le="snap"]').addEventListener('change', e => this.snap = Number(e.target.value) || 1);
    for (const name of ['x','y','w','h']) {
      this.panel.querySelector(`[data-le="${name}"]`).addEventListener('change', () => this.#applyFields());
    }

    // Capture clicks before normal machine handlers while editing.
    this.machine.addEventListener('pointerdown', e => {
      if (!this.enabled) return;
      if (e.target.closest('.layout-selection-box')) return;
      const target = e.target.closest('.live-layer button,.live-layer input,.live-layer .timer-display,.live-layer .brand-block,.live-layer .utility-mask');
      if (!target) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.select(target);
    }, true);
    this.machine.addEventListener('click', e => {
      if (!this.enabled) return;
      const target = e.target.closest('.live-layer button,.live-layer input,.live-layer .timer-display,.live-layer .brand-block,.live-layer .utility-mask');
      if (!target) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    this.box.addEventListener('pointerdown', e => {
      if (!this.enabled || !this.selected) return;
      e.preventDefault();
      e.stopPropagation();
      const mode = e.target.classList.contains('layout-resize-handle') ? 'resize' : 'move';
      const g = this.#geometry(this.selected);
      this.drag = { mode, pointerId:e.pointerId, startX:e.clientX, startY:e.clientY, ...g };
      this.box.setPointerCapture(e.pointerId);
    });
    this.box.addEventListener('pointermove', e => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      const scale = this.machine.getBoundingClientRect().width / DESIGN_W;
      const dx = (e.clientX - this.drag.startX) / scale;
      const dy = (e.clientY - this.drag.startY) / scale;
      let g = {...this.drag};
      if (this.drag.mode === 'move') { g.x = this.#snap(this.drag.x + dx); g.y = this.#snap(this.drag.y + dy); }
      else { g.w = Math.max(8,this.#snap(this.drag.w + dx)); g.h = Math.max(8,this.#snap(this.drag.h + dy)); }
      this.#setGeometry(this.selected,g);
    });
    this.box.addEventListener('pointerup', e => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      this.drag = null;
      this.#saveSelected();
    });

    window.addEventListener('keydown', e => {
      if (!this.enabled || !this.selected) return;
      if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const d = e.shiftKey ? 10 : this.snap;
      const g = this.#geometry(this.selected);
      if (e.key === 'ArrowLeft') g.x -= d;
      if (e.key === 'ArrowRight') g.x += d;
      if (e.key === 'ArrowUp') g.y -= d;
      if (e.key === 'ArrowDown') g.y += d;
      this.#setGeometry(this.selected,g);
      this.#saveSelected();
    }, true);

    window.addEventListener('resize', () => this.#syncBox());
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    document.body.classList.toggle('layout-edit-mode', this.enabled);
    this.panel.querySelector('[data-le="toggle"]').textContent = this.enabled ? 'EDIT ON' : 'EDIT OFF';
    if (!this.enabled) this.box.hidden = true;
    else if (this.selected) this.#syncBox();
  }

  select(el) {
    this.selected = el;
    if (!el) { this.box.hidden = true; return; }
    this.#refreshTargetList();
    const select = this.panel.querySelector('[data-le="target"]');
    select.value = this.#key(el) || '';
    this.#syncBox();
    this.#updateFields();
  }

  #geometry(el) {
    const er = el.getBoundingClientRect();
    const mr = this.machine.getBoundingClientRect();
    const sx = DESIGN_W / mr.width;
    const sy = DESIGN_H / mr.height;
    return {
      x:(er.left-mr.left)*sx,
      y:(er.top-mr.top)*sy,
      w:er.width*sx,
      h:er.height*sy
    };
  }

  #setGeometry(el,g) {
    const x = this.#snap(g.x), y = this.#snap(g.y), w = Math.max(8,this.#snap(g.w)), h = Math.max(8,this.#snap(g.h));
    el.style.position = 'absolute';
    el.style.left = `${x/DESIGN_W*100}%`;
    el.style.top = `${y/DESIGN_H*100}%`;
    el.style.width = `${w/DESIGN_W*100}%`;
    el.style.height = `${h/DESIGN_H*100}%`;
    // Neutralize right/bottom if a component happened to use them.
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    this.#syncBox();
    this.#updateFields();
  }

  #syncBox() {
    if (!this.enabled || !this.selected || !document.contains(this.selected)) { this.box.hidden = true; return; }
    const g = this.#geometry(this.selected);
    this.box.hidden = false;
    this.box.style.left = `${g.x}px`;
    this.box.style.top = `${g.y}px`;
    this.box.style.width = `${g.w}px`;
    this.box.style.height = `${g.h}px`;
    this.box.querySelector('.layout-selection-label').textContent = this.#key(this.selected) || 'selected';
  }

  #updateFields() {
    if (!this.selected) return;
    const g = this.#geometry(this.selected);
    for (const k of ['x','y','w','h']) this.panel.querySelector(`[data-le="${k}"]`).value = Math.round(g[k]);
    this.panel.querySelector('[data-le="css"]').value = this.#cssFor(this.selected,g);
  }

  #applyFields() {
    if (!this.selected) return;
    const read = k => Number(this.panel.querySelector(`[data-le="${k}"]`).value);
    this.#setGeometry(this.selected,{x:read('x'),y:read('y'),w:read('w'),h:read('h')});
    this.#saveSelected();
  }

  #snap(v) { return Math.round(v / this.snap) * this.snap; }

  #saveSelected() {
    if (!this.selected) return;
    const key = this.#key(this.selected); if (!key) return;
    const g = this.#geometry(this.selected);
    this.saved[key] = {x:Math.round(g.x),y:Math.round(g.y),w:Math.round(g.w),h:Math.round(g.h)};
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.saved));
    this.#updateFields();
  }

  #loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
    catch { return {}; }
  }

  #applySaved() {
    for (const el of this.#targets()) {
      const key = this.#key(el); const g = key && this.saved[key];
      if (g) this.#setGeometry(el,g);
    }
  }

  resetSelected() {
    if (!this.selected) return;
    const key = this.#key(this.selected); if (!key) return;
    delete this.saved[key]; localStorage.setItem(STORAGE_KEY, JSON.stringify(this.saved));
    // Remove inline layout overrides and let production CSS take over.
    for (const prop of ['position','left','top','width','height','right','bottom']) this.selected.style.removeProperty(prop);
    this.#syncBox(); this.#updateFields();
  }

  resetAll() {
    localStorage.removeItem(STORAGE_KEY); this.saved = {};
    for (const el of this.#targets()) for (const prop of ['position','left','top','width','height','right','bottom']) el.style.removeProperty(prop);
    this.#syncBox(); this.#updateFields();
  }

  #cssFor(el,g=this.#geometry(el)) {
    const key = this.#key(el) || 'selected';
    return `${key} {\n  left: ${(g.x/DESIGN_W*100).toFixed(3)}%;\n  top: ${(g.y/DESIGN_H*100).toFixed(3)}%;\n  width: ${(g.w/DESIGN_W*100).toFixed(3)}%;\n  height: ${(g.h/DESIGN_H*100).toFixed(3)}%;\n}`;
  }

  async copyCss() {
    if (!this.selected) return;
    const text = this.#cssFor(this.selected);
    this.panel.querySelector('[data-le="css"]').value = text;
    try { await navigator.clipboard.writeText(text); }
    catch { this.panel.querySelector('[data-le="css"]').select(); document.execCommand('copy'); }
  }

  exportJson() {
    const payload = { design:{width:DESIGN_W,height:DESIGN_H}, exportedAt:new Date().toISOString(), elements:this.saved };
    const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
    const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='D8M4_layout_overrides.json'; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }

  #refreshTargetList() {
    const sel = this.panel.querySelector('[data-le="target"]'); if (!sel) return;
    const prior = sel.value;
    sel.innerHTML = '<option value="">— select control —</option>' + this.#targets().map(el => {
      const key=this.#key(el); return key ? `<option value="${this.#escape(key)}">${this.#escape(this.#label(el))}</option>` : '';
    }).join('');
    if ([...sel.options].some(o=>o.value===prior)) sel.value=prior;
  }

  #escape(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
}
