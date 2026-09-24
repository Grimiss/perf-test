const DESIGN_W = 762;
const DESIGN_H = 656;
const STORAGE_KEY = 'D8M4_WELCOME_LAYER_DEV_V12';

export class WelcomeLayoutEditor {
  constructor({ root, layer = 'design', title = 'DESIGN DEV', panelStorageKey = 'D8M4_WELCOME_PANEL' }) {
    this.root = root;
    this.layer = layer;
    this.title = title;
    this.panelStorageKey = panelStorageKey;
    this.enabled = false;
    this.selected = null;
    this.selectedKey = null;
    this.drag = null;
    this.panelDrag = null;
    this.snap = 1;
    this.saved = this.#load();
    this.#build();
    this.#bind();
    this.lastWelcomeScreen = null;
    this.syncTimer = window.setInterval(() => this.#syncToScreen(), 350);
    setTimeout(() => this.#syncToScreen(true), 0);
  }

  #targets(){
    return [...this.root.querySelectorAll(`.welcome-final-screen [data-welcome-editable][data-layer="${this.layer}"]`)];
  }
  #allTargets(){ return [...this.root.querySelectorAll('.welcome-final-screen [data-welcome-editable]')]; }
  #key(el){ return el?.dataset?.layoutKey || null; }
  #locksAspect(el){ return el?.dataset?.lockAspect === 'true'; }
  #sizeOnly(el){ return el?.dataset?.sizeOnly === 'true'; }
  #childRelative(el){ return el?.dataset?.childRelative === 'true'; }
  #label(el){
    const labels={
      'header-block':'HEADER BLOCK (GROUPED)','brand-logo':'GRIMISS AMBIENT LOGO','instruction':'CHOOSE SS INSTRUCTION','copyright':'COPYRIGHT',
      'soundscape-menu':'SOUNDSCAPE MENU','play-button':'PLAY BUTTON','typed-line':'NOW BUILD YOUR DRONE',
      'nav-stack':'BYD / CC / UG STACK','byd-button':'BUILD YOUR DRONE BUTTON','cc-button':'CONTROL CENTRE BUTTON',
      'ug-button':'USER GUIDES BUTTON','game-button':'GAME MODE BUTTON','tv-button':'TV MODE BUTTON','skip-intro-button':'SKIP INTRO BUTTON'
    };
    return labels[this.#key(el)] || this.#key(el) || 'target';
  }

  #build(){
    this.panel=document.createElement('aside');
    this.panel.className=`welcome-layer-editor welcome-${this.layer}-editor`;
    this.panel.dataset.editorLayer=this.layer;
    this.panel.innerHTML=`
      <div class="wle-title" data-wle-drag-handle><b>${this.title}</b><button data-wle="toggle">EDIT OFF</button></div>
      <div class="wle-row"><label>Target</label><select data-wle="target"></select></div>
      <div class="wle-values">
        <label>X<input data-wle="x" type="number"></label><label>Y<input data-wle="y" type="number"></label>
        <label>W<input data-wle="w" type="number" min="1"></label><label>H<input data-wle="h" type="number" min="1"></label>
      </div>
      <div class="wle-row"><label>Snap</label><select data-wle="snap"><option>1</option><option>2</option><option>4</option><option>8</option><option>16</option></select></div>
      <fieldset class="wle-text-controls" data-wle="text-controls" hidden>
        <legend>TEXT</legend>
        <textarea data-wle="text" rows="3"></textarea>
        <div class="wle-style-grid">
          <label>Size<input data-wle="font-size" type="number" min="5" max="100"></label>
          <label>Spacing<input data-wle="letter-spacing" type="number" step="0.1"></label>
          <label>Colour<input data-wle="color" type="color"></label>
          <label>Align<select data-wle="align"><option value="left">LEFT</option><option value="center">CENTRE</option><option value="right">RIGHT</option></select></label>
        </div>
      </fieldset>
      <div class="wle-actions"><button data-wle="copy">COPY CSS</button><button data-wle="export">EXPORT JSON</button><button data-wle="reset-one">RESET ONE</button><button data-wle="reset-all">RESET ALL</button></div>
      <div class="wle-help">${this.layer==='design'
        ? 'DESIGN items only. The grouped header contains DRONE MACHINE, [D8M4], RGBY bar and strapline. Instruction/copyright can be edited and their W/H values control the real text box so text wraps to the chosen width.'
        : 'LIVE items only. Select the SS list, Play, typed guidance, BYD/CC/UG stack or individual buttons, GAME or TV. W/H values override the live CSS. Typed guidance text is editable.'}
        Drag this window by its title bar. Changes autosave locally.</div>
      <textarea class="wle-css" data-wle="css" readonly></textarea>`;
    document.body.appendChild(this.panel);
    this.#restorePanelPosition();

    this.box=document.createElement('div');
    this.box.className=`welcome-layout-selection selection-${this.layer}`;
    this.box.innerHTML='<div class="welcome-layout-selection-label"></div><i class="welcome-layout-resize"></i>';
    this.root.appendChild(this.box); this.box.hidden=true;
  }

  #bind(){
    const dragHandle=this.panel.querySelector('[data-wle-drag-handle]');
    dragHandle.addEventListener('pointerdown',e=>{
      if(e.target.closest('button,input,select,textarea'))return;
      e.preventDefault();const r=this.panel.getBoundingClientRect();
      this.panelDrag={pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,left:r.left,top:r.top};
      dragHandle.setPointerCapture?.(e.pointerId);document.body.classList.add('wle-panel-dragging');
    });
    dragHandle.addEventListener('pointermove',e=>{
      if(!this.panelDrag||e.pointerId!==this.panelDrag.pointerId)return;
      const maxLeft=Math.max(0,window.innerWidth-this.panel.offsetWidth),maxTop=Math.max(0,window.innerHeight-this.panel.offsetHeight);
      const left=Math.max(0,Math.min(maxLeft,this.panelDrag.left+(e.clientX-this.panelDrag.startX)));
      const top=Math.max(0,Math.min(maxTop,this.panelDrag.top+(e.clientY-this.panelDrag.startY)));
      Object.assign(this.panel.style,{left:`${left}px`,top:`${top}px`,right:'auto',bottom:'auto'});
    });
    const endPanel=e=>{if(!this.panelDrag||(e?.pointerId!=null&&e.pointerId!==this.panelDrag.pointerId))return;this.panelDrag=null;document.body.classList.remove('wle-panel-dragging');this.#savePanelPosition();};
    dragHandle.addEventListener('pointerup',endPanel);dragHandle.addEventListener('pointercancel',endPanel);dragHandle.addEventListener('lostpointercapture',endPanel);

    this.panel.addEventListener('click',e=>{
      const a=e.target?.dataset?.wle;if(!a)return;
      if(a==='toggle')this.setEnabled(!this.enabled);else if(a==='copy')this.copyCss();else if(a==='export')this.exportJson();else if(a==='reset-one')this.resetOne();else if(a==='reset-all')this.resetAll();
    });
    this.panel.querySelector('[data-wle="target"]').addEventListener('change',e=>this.selectByKey(e.target.value));
    this.panel.querySelector('[data-wle="snap"]').addEventListener('change',e=>this.snap=Number(e.target.value)||1);
    for(const n of ['x','y','w','h']){const el=this.panel.querySelector(`[data-wle="${n}"]`);el.addEventListener('change',()=>this.#applyFields());el.addEventListener('input',()=>this.#applyFields());}
    for(const n of ['text','font-size','letter-spacing','color','align'])this.panel.querySelector(`[data-wle="${n}"]`).addEventListener('input',()=>this.#applyTextFields());

    this.root.addEventListener('pointerdown',e=>{
      if(!this.enabled)return;if(e.target.closest('.welcome-layout-selection'))return;
      const t=e.target.closest(`.welcome-final-screen [data-welcome-editable][data-layer="${this.layer}"]`);if(!t)return;
      e.preventDefault();e.stopImmediatePropagation();this.select(t);
    },true);
    this.root.addEventListener('click',e=>{
      if(!this.enabled)return;const t=e.target.closest(`.welcome-final-screen [data-welcome-editable][data-layer="${this.layer}"]`);if(!t)return;
      e.preventDefault();e.stopImmediatePropagation();
    },true);

    // When a menu button is selected, the dev selection box sits above it.
    // Mirror hover state onto the underlying button so the real menu-hover style
    // remains testable in EDIT mode.
    this.box.addEventListener('pointerenter',()=>{
      if(this.selected?.matches?.('[data-menu-item]')) this.selected.classList.add('menu-hovered');
    });
    this.box.addEventListener('pointerleave',()=>{
      if(this.selected?.matches?.('[data-menu-item]')) this.selected.classList.remove('menu-hovered');
    });

    this.box.addEventListener('pointerdown',e=>{
      if(!this.enabled||!this.selected)return;e.preventDefault();e.stopPropagation();
      const mode=e.target.classList.contains('welcome-layout-resize')?'resize':'move';const g=this.#geometry(this.selected);
      this.drag={mode,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,...g};this.box.setPointerCapture?.(e.pointerId);
    });
    this.box.addEventListener('pointermove',e=>{
      if(!this.drag||e.pointerId!==this.drag.pointerId||!this.selected||!document.contains(this.selected))return;
      const rr=this.root.getBoundingClientRect(),scaleX=DESIGN_W/rr.width,scaleY=DESIGN_H/rr.height;
      const dx=(e.clientX-this.drag.startX)*scaleX,dy=(e.clientY-this.drag.startY)*scaleY;const g={...this.drag};
      if(this.drag.mode==='move'){g.x=this.#snap(this.drag.x+dx);g.y=this.#snap(this.drag.y+dy);}
      else if(this.#locksAspect(this.selected)){const ratio=this.drag.w/Math.max(1,this.drag.h);g.w=Math.max(20,this.#snap(this.drag.w+dx));g.h=Math.max(10,this.#snap(g.w/ratio));}
      else{g.w=Math.max(10,this.#snap(this.drag.w+dx));g.h=Math.max(10,this.#snap(this.drag.h+dy));}
      this.#setGeometry(this.selected,g);
    });
    this.box.addEventListener('pointerup',e=>{if(!this.drag||e.pointerId!==this.drag.pointerId)return;this.drag=null;if(this.selected&&document.contains(this.selected))this.#saveSelected();else this.box.hidden=true;});

    window.addEventListener('keydown',e=>{
      if(!this.enabled||!this.selected||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
      if(e.target.closest?.('.welcome-layer-editor'))return;
      e.preventDefault();const d=e.shiftKey?10:this.snap,g=this.#geometry(this.selected);
      if(e.key==='ArrowLeft')g.x-=d;if(e.key==='ArrowRight')g.x+=d;if(e.key==='ArrowUp')g.y-=d;if(e.key==='ArrowDown')g.y+=d;
      this.#setGeometry(this.selected,g);this.#saveSelected();
    },true);
    window.addEventListener('resize',()=>this.#syncBox());
  }

  #syncToScreen(force=false){
    const screen=this.root.querySelector('.welcome-final-screen');this.panel.hidden=!screen;if(!this.box.isConnected)this.root.appendChild(this.box);
    if(!force&&screen===this.lastWelcomeScreen){if(!screen)this.box.hidden=true;if(this.selected&&!document.contains(this.selected)){this.selected=null;this.selectedKey=null;this.box.hidden=true;}return;}
    this.lastWelcomeScreen=screen;this.saved=this.#load();this.#refresh();this.#applySaved();if(this.selectedKey)this.selectByKey(this.selectedKey,false);if(!screen)this.box.hidden=true;this.#updateOutlines();
  }

  setEnabled(on){this.enabled=Boolean(on);this.panel.querySelector('[data-wle="toggle"]').textContent=this.enabled?'EDIT ON':'EDIT OFF';this.#updateOutlines();if(!this.enabled)this.box.hidden=true;else if(this.selected)this.#syncBox();}
  #updateOutlines(){document.body.classList.toggle(`welcome-${this.layer}-edit`,this.enabled);}
  selectByKey(key,update=true){const el=this.#targets().find(x=>this.#key(x)===key)||null;this.select(el,update);}
  select(el,update=true){this.selected=el;this.selectedKey=this.#key(el);if(!el){this.box.hidden=true;this.#showTextControls(false);return;}if(update)this.panel.querySelector('[data-wle="target"]').value=this.selectedKey||'';this.#syncBox();this.#updateFields();}

  #geometry(el){const er=el.getBoundingClientRect(),rr=this.root.getBoundingClientRect();return{x:(er.left-rr.left)*DESIGN_W/rr.width,y:(er.top-rr.top)*DESIGN_H/rr.height,w:er.width*DESIGN_W/rr.width,h:er.height*DESIGN_H/rr.height};}
  #setGeometry(el,g){
    const x=this.#snap(g.x),y=this.#snap(g.y),w=Math.max(10,this.#snap(g.w)),h=Math.max(10,this.#snap(g.h));
    // Development geometry must always win over the checkpoint CSS. Some of the
    // imported RC4 positions intentionally use !important, so normal inline
    // styles could move left/right but were unable to override top/width/height.
    // Use important inline properties for all editor-controlled geometry.
    if(this.#childRelative(el)){
      const rr=this.root.getBoundingClientRect(), pr=el.parentElement?.getBoundingClientRect();
      if(pr){
        const px=(pr.left-rr.left)*DESIGN_W/rr.width, py=(pr.top-rr.top)*DESIGN_H/rr.height;
        const pw=pr.width*DESIGN_W/rr.width, ph=pr.height*DESIGN_H/rr.height;
        el.style.setProperty('position','absolute','important');
        el.style.setProperty('left',`${(x-px)/pw*100}%`,'important');
        el.style.setProperty('top',`${(y-py)/ph*100}%`,'important');
        el.style.setProperty('width',`${w/pw*100}%`,'important');
        el.style.setProperty('height',`${h/ph*100}%`,'important');
        el.style.setProperty('right','auto','important');
        el.style.setProperty('bottom','auto','important');
        el.style.setProperty('flex','none','important');
        el.style.setProperty('min-width','0','important');
        el.style.setProperty('max-width','none','important');
        el.style.setProperty('min-height','0','important');
        el.style.setProperty('max-height','none','important');
      }
    }else if(this.#sizeOnly(el)){
      const rr=this.root.getBoundingClientRect(),pr=el.parentElement?.getBoundingClientRect();
      const parentW=pr?.width?pr.width*DESIGN_W/rr.width:DESIGN_W,parentH=pr?.height?pr.height*DESIGN_H/rr.height:DESIGN_H;
      el.style.setProperty('width',`${w/parentW*100}%`,'important');
      el.style.setProperty('height',`${h/parentH*100}%`,'important');
      el.style.setProperty('flex','none','important');
      el.style.setProperty('min-width','0','important');
      el.style.setProperty('max-width','none','important');
      el.style.setProperty('min-height','0','important');
      el.style.setProperty('max-height','none','important');
    }else{
      el.style.setProperty('position','absolute','important');
      el.style.setProperty('left',`${x/DESIGN_W*100}%`,'important');
      el.style.setProperty('top',`${y/DESIGN_H*100}%`,'important');
      el.style.setProperty('width',`${w/DESIGN_W*100}%`,'important');
      el.style.setProperty('height',`${h/DESIGN_H*100}%`,'important');
      el.style.setProperty('right','auto','important');
      el.style.setProperty('bottom','auto','important');
      el.style.setProperty('max-width','none','important');
      el.style.setProperty('max-height','none','important');
    }
    this.#syncBox();this.#updateFields(false);
  }
  #syncBox(){if(!this.enabled||!this.selected||!document.contains(this.selected)){this.box.hidden=true;return;}const g=this.#geometry(this.selected);this.box.hidden=false;Object.assign(this.box.style,{left:`${g.x/DESIGN_W*100}%`,top:`${g.y/DESIGN_H*100}%`,width:`${g.w/DESIGN_W*100}%`,height:`${g.h/DESIGN_H*100}%`});this.box.querySelector('.welcome-layout-selection-label').textContent=`${this.layer.toUpperCase()} · ${this.#label(this.selected)}`;}
  #updateFields(updateText=true){if(!this.selected)return;const g=this.#geometry(this.selected);for(const k of ['x','y','w','h'])this.panel.querySelector(`[data-wle="${k}"]`).value=Math.round(g[k]);this.panel.querySelector('[data-wle="css"]').value=this.#cssFor(this.selected,g);if(updateText)this.#fillTextControls();}
  #applyFields(){if(!this.selected)return;const read=k=>Number(this.panel.querySelector(`[data-wle="${k}"]`).value);let g={x:read('x'),y:read('y'),w:read('w'),h:read('h')};if(this.#locksAspect(this.selected)){const current=this.#geometry(this.selected),ratio=current.w/Math.max(1,current.h);g.h=Math.max(10,g.w/ratio);}this.#setGeometry(this.selected,g);this.#saveSelected();}
  #snap(v){return Math.round(v/this.snap)*this.snap;}

  #showTextControls(show){this.panel.querySelector('[data-wle="text-controls"]').hidden=!show;}
  #fillTextControls(){
    const isText=Boolean(this.selected?.hasAttribute('data-edit-text'));this.#showTextControls(isText);if(!isText)return;
    const cs=getComputedStyle(this.selected),key=this.#key(this.selected);
    this.panel.querySelector('[data-wle="text"]').value=key==='typed-line'?(this.selected.dataset.typedText||'NOW BUILD YOUR DRONE....'):this.selected.textContent;
    this.panel.querySelector('[data-wle="font-size"]').value=parseFloat(cs.fontSize)||12;
    this.panel.querySelector('[data-wle="letter-spacing"]').value=cs.letterSpacing==='normal'?0:(parseFloat(cs.letterSpacing)||0);
    this.panel.querySelector('[data-wle="color"]').value=this.#rgbToHex(cs.color);
    this.panel.querySelector('[data-wle="align"]').value=cs.textAlign||'left';
  }
  #applyTextFields(){
    if(!this.selected?.hasAttribute('data-edit-text'))return;
    const text=this.panel.querySelector('[data-wle="text"]').value,size=Number(this.panel.querySelector('[data-wle="font-size"]').value),spacing=Number(this.panel.querySelector('[data-wle="letter-spacing"]').value),color=this.panel.querySelector('[data-wle="color"]').value,align=this.panel.querySelector('[data-wle="align"]').value,key=this.#key(this.selected);
    if(key==='typed-line'){
      this.selected.dataset.typedText=text;
      const line=this.selected.querySelector('.spectrum-typed-line');
      const copy=this.selected.querySelector('.typed-copy');
      if(copy) copy.textContent=text;
      Object.assign(this.selected.style,{fontSize:`${size}px`,letterSpacing:`${spacing}px`,color,textAlign:align});
      if(line) Object.assign(line.style,{fontSize:`${size}px`,letterSpacing:`${spacing}px`,color,textAlign:align,direction:'ltr'});
      if(copy) Object.assign(copy.style,{color,direction:'ltr',textAlign:align});
    }else{
      this.selected.textContent=text;
      this.selected.style.setProperty('font-size',`${size}px`,'important');
      this.selected.style.setProperty('letter-spacing',`${spacing}px`,'important');
      this.selected.style.setProperty('color',color,'important');
      this.selected.style.setProperty('text-align',align,'important');
      this.selected.style.setProperty('white-space','pre-wrap','important');
      this.selected.style.setProperty('overflow-wrap','break-word','important');
    }
    this.#saveSelected();this.#syncBox();
  }
  #rgbToHex(rgb){const m=rgb.match(/\d+(?:\.\d+)?/g);if(!m||m.length<3)return'#ffffff';return'#'+m.slice(0,3).map(v=>Math.max(0,Math.min(255,Math.round(Number(v)))).toString(16).padStart(2,'0')).join('');}

  #load(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')||{};}catch{return{};}}
  #saveSelected(){
    if(!this.selectedKey)return;this.saved=this.#load();const g=this.#geometry(this.selected),item=this.saved[this.selectedKey]||{};
    Object.assign(item,{layer:this.layer,x:Math.round(g.x),y:Math.round(g.y),w:Math.round(g.w),h:Math.round(g.h)});
    if(this.selected.hasAttribute('data-edit-text')){const cs=getComputedStyle(this.selected),isTyped=this.selectedKey==='typed-line',savedText=isTyped?(this.selected.dataset.typedText||this.selected.querySelector('.typed-copy')?.textContent||''):this.selected.textContent;Object.assign(item,{text:savedText,fontSize:parseFloat(cs.fontSize)||12,letterSpacing:cs.letterSpacing==='normal'?0:(parseFloat(cs.letterSpacing)||0),color:this.#rgbToHex(cs.color),textAlign:cs.textAlign||'left'});}
    this.saved[this.selectedKey]=item;localStorage.setItem(STORAGE_KEY,JSON.stringify(this.saved));this.#updateFields(false);
  }
  #applySaved(){
    this.saved=this.#load();
    for(const el of this.#allTargets()){
      const k=this.#key(el),g=k&&this.saved[k];if(!g)continue;this.#setGeometry(el,g);
      if(el.hasAttribute('data-edit-text')){if(g.text!=null){if(k==='typed-line'){el.dataset.typedText=g.text;}else el.textContent=g.text;}if(g.fontSize!=null)el.style.setProperty('font-size',`${g.fontSize}px`,'important');if(g.letterSpacing!=null)el.style.setProperty('letter-spacing',`${g.letterSpacing}px`,'important');if(g.color)el.style.setProperty('color',g.color,'important');if(g.textAlign)el.style.setProperty('text-align',g.textAlign,'important');if(k==='typed-line'){const line=el.querySelector('.spectrum-typed-line'),copy=el.querySelector('.typed-copy');if(line){if(g.fontSize!=null)line.style.fontSize=`${g.fontSize}px`;if(g.letterSpacing!=null)line.style.letterSpacing=`${g.letterSpacing}px`;if(g.color)line.style.color=g.color;if(g.textAlign)line.style.textAlign=g.textAlign;line.style.direction='ltr';}if(copy){if(g.color)copy.style.color=g.color;copy.style.direction='ltr';if(g.textAlign)copy.style.textAlign=g.textAlign;}}else{el.style.whiteSpace='pre-wrap';el.style.overflowWrap='break-word';}}
    }
  }
  resetOne(){if(!this.selectedKey||!this.selected)return;this.saved=this.#load();delete this.saved[this.selectedKey];localStorage.setItem(STORAGE_KEY,JSON.stringify(this.saved));for(const p of ['position','left','top','width','height','right','bottom','max-width','font-size','letter-spacing','color','text-align','white-space','overflow-wrap'])this.selected.style.removeProperty(p);this.#syncToScreen(true);}
  resetAll(){localStorage.removeItem(STORAGE_KEY);this.saved={};for(const el of this.#allTargets())for(const p of ['position','left','top','width','height','right','bottom','max-width','font-size','letter-spacing','color','text-align','white-space','overflow-wrap'])el.style.removeProperty(p);this.#syncToScreen(true);}
  #cssFor(el,g=this.#geometry(el)){const k=this.#key(el)||'target';return `[data-layout-key="${k}"] {\n  left: ${(g.x/DESIGN_W*100).toFixed(3)}%;\n  top: ${(g.y/DESIGN_H*100).toFixed(3)}%;\n  width: ${(g.w/DESIGN_W*100).toFixed(3)}%;\n  height: ${(g.h/DESIGN_H*100).toFixed(3)}%;\n}`;}
  async copyCss(){if(!this.selected)return;const t=this.#cssFor(this.selected);this.panel.querySelector('[data-wle="css"]').value=t;try{await navigator.clipboard.writeText(t);}catch{this.panel.querySelector('[data-wle="css"]').select();document.execCommand('copy');}}
  exportJson(){const payload={design:{width:DESIGN_W,height:DESIGN_H},scope:'D8M4 Welcome CRT split design/live dev',exportedAt:new Date().toISOString(),elements:this.#load()};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='D8M4_welcome_split_dev_layout.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}

  #restorePanelPosition(){try{const pos=JSON.parse(localStorage.getItem(this.panelStorageKey)||'null');if(!pos||!Number.isFinite(pos.left)||!Number.isFinite(pos.top)){if(this.layer==='design')Object.assign(this.panel.style,{left:'12px',top:'12px',right:'auto',bottom:'auto'});return;}const left=Math.max(0,Math.min(window.innerWidth-80,pos.left)),top=Math.max(0,Math.min(window.innerHeight-40,pos.top));Object.assign(this.panel.style,{left:`${left}px`,top:`${top}px`,right:'auto',bottom:'auto'});}catch{}}
  #savePanelPosition(){const r=this.panel.getBoundingClientRect();localStorage.setItem(this.panelStorageKey,JSON.stringify({left:Math.round(r.left),top:Math.round(r.top)}));}
  #refresh(){const sel=this.panel.querySelector('[data-wle="target"]');if(!sel)return;const prior=sel.value;sel.innerHTML='<option value="">— select element —</option>'+this.#targets().map(el=>`<option value="${this.#esc(this.#key(el))}">${this.#esc(this.#label(el))}</option>`).join('');if([...sel.options].some(o=>o.value===prior))sel.value=prior;}
  #esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
}
