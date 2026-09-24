const W=762,H=656,LIVE_H=505;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

export class PageLayoutEditor{
  constructor({root,page,layer,title,storageKey}){
    this.root=root; this.page=page; this.layer=layer; this.title=title; this.storageKey=storageKey;
    this.enabled=true; this.closed=false; this.selectedKey=''; this.selected=null; this.snap=1; this.snapEnabled=true; this.gridEnabled=false;
    this.panelDrag=null; this.boxDrag=null;
    this.build(); this.bind(); this.timer=setInterval(()=>this.sync(),180); this.sync(true);
  }
  screen(){return this.root.querySelector(`.crt-screen[data-dev-page="${this.page}"]`)}
  frame(){const s=this.screen();if(!s)return null;return (this.layer==='live'&&(this.page==='cc'||this.page==='byd'))?(s.querySelector('.d8m4-zone-main')||s):s}
  dims(){return (this.layer==='live'&&(this.page==='cc'||this.page==='byd'))?{w:W,h:LIVE_H}:{w:W,h:H}}
  selector(){return `[data-dev-layer="${this.layer}"][data-dev-key]`}
  targets(){const s=this.screen(); return s?[...s.querySelectorAll(this.selector())]:[]}
  key(el){return el?.dataset?.devKey||''}
  scale(){const f=this.frame();const d=this.dims();if(!f)return {sx:1,sy:1};const r=f.getBoundingClientRect();return {sx:r.width/d.w,sy:r.height/d.h}}
  geom(el){
    const f=this.frame(),d=this.dims(); if(!f||!el)return{x:0,y:0,w:10,h:10};
    const a=el.getBoundingClientRect(),r=f.getBoundingClientRect();
    return{x:(a.left-r.left)*d.w/r.width,y:(a.top-r.top)*d.h/r.height,w:a.width*d.w/r.width,h:a.height*d.h/r.height};
  }
  build(){
    this.panel=document.createElement('aside');
    this.panel.className=`page-dev-window page-dev-${this.page}-${this.layer}`;
    this.panel.style.cssText=`position:fixed!important;right:12px;top:${this.layer==='design'?12:360}px;bottom:auto!important;left:auto;`;
    this.panel.innerHTML=`<div class="pdw-title" data-drag><b>${this.title}</b><button data-close>×</button></div>
      <div class="pdw-row"><label>Target</label><select data-target></select></div>
      <div class="pdw-values">${['x','y','w','h'].map(k=>`<label>${k.toUpperCase()}<input data-${k} type="number"></label>`).join('')}</div>
      <div class="pdw-row"><label>Snap</label><select data-snap><option>1</option><option>2</option><option>4</option><option>8</option></select><button data-snap-toggle>SNAP ON</button></div>
      <div class="pdw-nudge"><button data-nudge="up">▲</button><button data-nudge="left">◀</button><button data-nudge="down">▼</button><button data-nudge="right">▶</button></div>
      <div class="pdw-actions"><button data-lock>LOCK</button><button data-front>FRONT</button><button data-back>BACK</button><button data-grid>GRID</button></div>
      <div class="pdw-actions"><button data-save>SAVE</button><button data-load>LOAD</button><button data-reset>RESET</button><button data-export>EXPORT JSON</button></div>
      <div class="pdw-actions"><button data-toggle>EDIT ON</button></div>
      <small>Drag/resize the cyan box or use X/Y/W/H. Lock, layer, grid and snap controls are development-only. Layout changes auto-save; SAVE/LOAD provide explicit checkpoints.</small>`;
    document.body.appendChild(this.panel); this.restorePos();
    this.box=document.createElement('div'); this.box.className='page-dev-selection'; this.box.innerHTML='<span></span><i></i>';
    document.body.appendChild(this.box); this.box.hidden=true;
    this.grid=document.createElement('div'); this.grid.className='page-dev-grid'; document.body.appendChild(this.grid); this.grid.hidden=true;
  }
  bind(){
    this.panel.querySelector('[data-close]').onclick=()=>{this.closed=true;this.panel.hidden=true;this.box.hidden=true;this.grid.hidden=true};
    this.panel.querySelector('[data-toggle]').onclick=()=>{this.enabled=!this.enabled;this.panel.querySelector('[data-toggle]').textContent=this.enabled?'EDIT ON':'EDIT OFF';this.updateBox()};
    this.panel.querySelector('[data-reset]').onclick=()=>{localStorage.removeItem(this.storageKey);localStorage.removeItem(this.storageKey+'_layers');localStorage.removeItem(this.storageKey+'_locks');for(const el of this.targets())this.clearDevStyle(el);this.sync(true)};
    this.panel.querySelector('[data-save]').onclick=()=>this.saveAll();
    this.panel.querySelector('[data-load]').onclick=()=>{this.applySaved();this.applyMeta();this.sync(true)};
    this.panel.querySelector('[data-lock]').onclick=()=>this.toggleLock();
    this.panel.querySelector('[data-front]').onclick=()=>this.changeLayer(1);
    this.panel.querySelector('[data-back]').onclick=()=>this.changeLayer(-1);
    this.panel.querySelector('[data-grid]').onclick=()=>{this.gridEnabled=!this.gridEnabled;this.panel.querySelector('[data-grid]').classList.toggle('active',this.gridEnabled);this.updateGrid()};
    this.panel.querySelector('[data-snap-toggle]').onclick=()=>{this.snapEnabled=!this.snapEnabled;this.panel.querySelector('[data-snap-toggle]').textContent=this.snapEnabled?'SNAP ON':'SNAP OFF'};
    this.panel.querySelector('[data-export]').onclick=()=>this.exportJson();
    this.panel.querySelector('[data-target]').onchange=e=>this.selectByKey(e.target.value);
    this.panel.querySelector('[data-snap]').onchange=e=>this.snap=+e.target.value||1;
    for(const k of ['x','y','w','h']){const inp=this.panel.querySelector(`[data-${k}]`);inp.onchange=()=>this.applyFields();inp.onkeydown=e=>{if(e.key==='Enter')this.applyFields()}}
    for(const b of this.panel.querySelectorAll('[data-nudge]')) b.onclick=()=>this.nudge(b.dataset.nudge);

    // Window dragging uses document-level pointer tracking. This deliberately does not rely on
    // pointer capture or the CRT hierarchy, so both X and Y remain free even over transformed UI.
    const handle=this.panel.querySelector('[data-drag]');
    handle.addEventListener('pointerdown',e=>{
      if(e.target.closest('button,input,select'))return;
      e.preventDefault(); const r=this.panel.getBoundingClientRect();
      this.panelDrag={id:e.pointerId,startX:e.clientX,startY:e.clientY,left:r.left,top:r.top};
      this.panel.style.right='auto'; this.panel.style.bottom='auto';
    });
    document.addEventListener('pointermove',e=>{
      if(this.panelDrag&&e.pointerId===this.panelDrag.id){
        e.preventDefault(); const w=this.panel.offsetWidth,h=this.panel.offsetHeight;
        const left=clamp(this.panelDrag.left+e.clientX-this.panelDrag.startX,0,Math.max(0,innerWidth-w));
        const top=clamp(this.panelDrag.top+e.clientY-this.panelDrag.startY,0,Math.max(0,innerHeight-h));
        this.panel.style.setProperty('left',left+'px','important');
        this.panel.style.setProperty('top',top+'px','important');
        this.panel.style.setProperty('right','auto','important');
        this.panel.style.setProperty('bottom','auto','important');
      }
      if(this.boxDrag&&e.pointerId===this.boxDrag.id)this.dragBox(e);
    },{passive:false});
    document.addEventListener('pointerup',e=>{
      if(this.panelDrag&&e.pointerId===this.panelDrag.id){this.panelDrag=null;this.savePos()}
      if(this.boxDrag&&e.pointerId===this.boxDrag.id){this.boxDrag=null;this.saveSelected();this.updateFields()}
    });

    this.box.addEventListener('pointerdown',e=>{
      if(!this.enabled||!this.selected||this.isLocked())return; e.preventDefault();e.stopPropagation();
      this.boxDrag={id:e.pointerId,startX:e.clientX,startY:e.clientY,start:this.geom(this.selected),resize:e.target.tagName==='I'};
    });
    window.addEventListener('resize',()=>this.updateBox());
    window.addEventListener('keydown',e=>{
      if(!this.enabled||!this.selected||e.target.closest?.('.page-dev-window'))return;
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
      e.preventDefault(); this.nudge(({ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down'})[e.key],e.shiftKey?10:this.snap);
    },true);
  }
  nudge(dir,amount=this.snap){
    if(!this.selected||this.isLocked())return; const g=this.geom(this.selected),d=amount;
    if(dir==='left')g.x-=d;if(dir==='right')g.x+=d;if(dir==='up')g.y-=d;if(dir==='down')g.y+=d;
    this.setGeom(this.selected,g);this.saveSelected();
  }
  dragBox(e){
    if(!this.selected||!this.boxDrag||this.isLocked())return; const f=this.frame(),d=this.dims();if(!f)return;
    const r=f.getBoundingClientRect(),dx=(e.clientX-this.boxDrag.startX)*d.w/r.width,dy=(e.clientY-this.boxDrag.startY)*d.h/r.height;
    const g={...this.boxDrag.start};
    if(this.boxDrag.resize){g.w=Math.max(20,g.w+dx);g.h=Math.max(15,g.h+dy)}else{g.x+=dx;g.y+=dy}
    this.setGeom(this.selected,g);
  }
  setGeom(el,g){
    const f=this.frame(),d=this.dims();if(!f||!el)return;
    const snap=v=>this.snapEnabled?Math.round(v/this.snap)*this.snap:v;
    g={x:snap(g.x),y:snap(g.y),w:Math.max(10,snap(g.w)),h:Math.max(10,snap(g.h))};

    // BYD's two main control boxes and every Control Centre dev target are
    // true CRT-space regions. Apply geometry directly as percentages so saved
    // layouts never accumulate translate() offsets across renders.
    const directResponsive=(this.page==='cc'||this.page==='byd');
    if(directResponsive){
      el.style.setProperty('position','absolute','important');
      el.style.setProperty('left',(g.x/d.w*100)+'%','important');
      el.style.setProperty('top',(g.y/d.h*100)+'%','important');
      el.style.setProperty('width',(g.w/d.w*100)+'%','important');
      el.style.setProperty('height',(g.h/d.h*100)+'%','important');
      el.style.setProperty('right','auto','important');
      el.style.setProperty('bottom','auto','important');
      el.style.setProperty('transform','none','important');
      delete el.dataset.devTx;delete el.dataset.devTy;
      el.style.setProperty('z-index',this.layer==='design'?'2':'20','important');
      this.updateBox();this.updateFields();
      return;
    }

    // Other targets retain the generic visual-delta editor behaviour.
    const sc=this.scale();
    el.style.setProperty('width',(g.w*sc.sx)+'px','important');
    el.style.setProperty('height',(g.h*sc.sy)+'px','important');
    const afterResize=this.geom(el);
    const oldTx=Number(el.dataset.devTx||0),oldTy=Number(el.dataset.devTy||0);
    const dx=(g.x-afterResize.x)*sc.sx,dy=(g.y-afterResize.y)*sc.sy;
    const tx=oldTx+dx,ty=oldTy+dy;
    el.dataset.devTx=String(tx);el.dataset.devTy=String(ty);
    el.style.setProperty('transform',`translate(${tx}px,${ty}px)`,'important');
    if(this.layer==='design' && this.key(el)==='background') el.style.setProperty('z-index','0','important');
    else el.style.setProperty('z-index','20','important');
    this.updateBox();this.updateFields();
  }
  clearDevStyle(el){
    for(const p of ['left','top','width','height','transform','z-index'])el.style.removeProperty(p);
    delete el.dataset.devTx;delete el.dataset.devTy;
  }
  selectByKey(k){
    this.selectedKey=k;this.selected=this.targets().find(x=>this.key(x)===k)||null;
    const sel=this.panel.querySelector('[data-target]');if(sel)sel.value=k;
    this.updateBox();this.updateFields();
  }
  updateBox(){
    const s=this.screen();if(!this.enabled||this.closed||!s||!this.selected||!document.contains(this.selected)){this.box.hidden=true;return}
    const a=this.selected.getBoundingClientRect();
    Object.assign(this.box.style,{position:'fixed',left:a.left+'px',top:a.top+'px',width:a.width+'px',height:a.height+'px'});
    this.box.querySelector('span').textContent=this.key(this.selected);this.box.hidden=false;
  }
  updateFields(){if(!this.selected)return;const g=this.geom(this.selected);for(const k of ['x','y','w','h'])this.panel.querySelector(`[data-${k}]`).value=Math.round(g[k])}
  applyFields(){if(!this.selected)return;const g={};for(const k of ['x','y','w','h']){const v=Number(this.panel.querySelector(`[data-${k}]`).value);if(!Number.isFinite(v))return;g[k]=v}this.setGeom(this.selected,g);this.saveSelected()}
  saveSelected(){
    if(!this.selected)return;let all={};try{all=JSON.parse(localStorage.getItem(this.storageKey)||'{}')||{}}catch{}
    all[this.key(this.selected)]=this.geom(this.selected);localStorage.setItem(this.storageKey,JSON.stringify(all));
  }
  applySaved(){
    let all={};try{all=JSON.parse(localStorage.getItem(this.storageKey)||'{}')||{}}catch{}
    for(const el of this.targets()){const g=all[this.key(el)];if(g)this.setGeom(el,g)}
  }
  sync(force=false){
    const s=this.screen();this.panel.hidden=!s||this.closed;
    if(!s){this.box.hidden=true;this.selected=null;return}
    const ts=this.targets(),sel=this.panel.querySelector('[data-target]'),keys=ts.map(x=>this.key(x));
    if(force||sel.dataset.keys!==keys.join('|')){
      sel.innerHTML=keys.map(k=>`<option value="${k}">${k}</option>`).join('');sel.dataset.keys=keys.join('|');
      this.applySaved();this.applyMeta();if(!this.selectedKey||!keys.includes(this.selectedKey))this.selectedKey=keys[0]||'';this.selectByKey(this.selectedKey);
    }else if(this.selectedKey){
      const current=ts.find(x=>this.key(x)===this.selectedKey);
      if(current!==this.selected){this.selected=current||null;this.applySaved();this.applyMeta();this.updateBox();this.updateFields()}else this.updateBox();
    }
    this.updateGrid();
  }
  open(){this.closed=false;this.sync(true)}
  toggle(){this.closed=!this.closed;this.panel.hidden=this.closed;if(this.closed){this.box.hidden=true;this.grid.hidden=true}else this.sync(true)}

  loadObj(key){try{return JSON.parse(localStorage.getItem(key)||'{}')||{}}catch{return {}}}
  saveAll(){
    const all={}; for(const el of this.targets()) all[this.key(el)]=this.geom(el);
    localStorage.setItem(this.storageKey,JSON.stringify(all)); this.saveMeta();
  }
  isLocked(){const locks=this.loadObj(this.storageKey+'_locks');return Boolean(this.selectedKey&&locks[this.selectedKey])}
  toggleLock(){if(!this.selectedKey)return;const locks=this.loadObj(this.storageKey+'_locks');locks[this.selectedKey]=!locks[this.selectedKey];localStorage.setItem(this.storageKey+'_locks',JSON.stringify(locks));this.updateLockButton();this.updateBox()}
  updateLockButton(){const b=this.panel.querySelector('[data-lock]');if(!b)return;const locked=this.isLocked();b.textContent=locked?'UNLOCK':'LOCK';b.classList.toggle('active',locked);if(this.box)this.box.classList.toggle('locked',locked)}
  changeLayer(delta){if(!this.selected||this.isLocked())return;const layers=this.loadObj(this.storageKey+'_layers');const key=this.key(this.selected);const current=Number(layers[key]??this.selected.style.zIndex??20)||20;layers[key]=Math.max(0,Math.min(99,current+delta));localStorage.setItem(this.storageKey+'_layers',JSON.stringify(layers));this.selected.style.setProperty('z-index',String(layers[key]),'important')}
  saveMeta(){
    const layers=this.loadObj(this.storageKey+'_layers');
    for(const el of this.targets()){const z=Number(el.style.zIndex);if(Number.isFinite(z))layers[this.key(el)]=z}
    localStorage.setItem(this.storageKey+'_layers',JSON.stringify(layers));
  }
  applyMeta(){const layers=this.loadObj(this.storageKey+'_layers');for(const el of this.targets()){const z=layers[this.key(el)];if(z!==undefined)el.style.setProperty('z-index',String(z),'important')}this.updateLockButton()}
  updateGrid(){const f=this.frame();if(!this.gridEnabled||this.closed||!f){this.grid.hidden=true;return}const r=f.getBoundingClientRect();Object.assign(this.grid.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});this.grid.hidden=false}
  restorePos(){try{const p=JSON.parse(localStorage.getItem(this.storageKey+'_panel')||'null');if(p){this.panel.style.setProperty('left',p.left+'px','important');this.panel.style.setProperty('top',p.top+'px','important');this.panel.style.setProperty('right','auto','important');this.panel.style.setProperty('bottom','auto','important')}}catch{}}
  savePos(){const r=this.panel.getBoundingClientRect();localStorage.setItem(this.storageKey+'_panel',JSON.stringify({left:r.left,top:r.top}))}
  exportJson(){const d=this.dims();const payload={page:this.page,layer:this.layer,title:this.title,storageKey:this.storageKey,coordinateSpace:this.layer==='live'?'main':'screen',design:{width:d.w,height:d.h},exportedAt:new Date().toISOString(),elements:this.targets().map(el=>({key:this.key(el),...Object.fromEntries(Object.entries(this.geom(el)).map(([k,v])=>[k,Math.round(v)]))}))};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${this.storageKey}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
}
