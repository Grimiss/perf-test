const W=1536,H=1024;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

export class LegendLayoutEditor{
  constructor({root,title='LEGEND DEV',storageKey='D84M_LEGEND_DEV'}){
    this.root=root;this.page='global';this.layer='legend';this.title=title;this.storageKey=storageKey;
    this.enabled=true;this.closed=false;this.selectedKey='';this.selected=null;this.snap=1;this.panelDrag=null;this.boxDrag=null;
    this.build();this.bind();this.timer=setInterval(()=>this.sync(),180);this.sync(true);
  }
  screen(){return this.root}
  frame(){return this.root}
  dims(){return {w:W,h:H}}
  selector(){return '[data-legend-dev][data-dev-key]'}
  targets(){return [...this.root.querySelectorAll(this.selector())]}
  key(el){return el?.dataset?.devKey||''}
  label(el){return el?.dataset?.devLabel||this.key(el)||'target'}
  hasText(el){return Boolean(el?.hasAttribute?.('data-edit-text'))}
  geom(el){const f=this.frame(),d=this.dims();if(!f||!el)return{x:0,y:0,w:10,h:10};const a=el.getBoundingClientRect(),r=f.getBoundingClientRect();return{x:(a.left-r.left)*d.w/r.width,y:(a.top-r.top)*d.h/r.height,w:a.width*d.w/r.width,h:a.height*d.h/r.height};}
  rgbToHex(rgb){const m=String(rgb||'').match(/\d+(?:\.\d+)?/g);if(!m||m.length<3)return '#ffffff';return '#'+m.slice(0,3).map(v=>Math.max(0,Math.min(255,Math.round(Number(v)))).toString(16).padStart(2,'0')).join('')}
  build(){
    this.panel=document.createElement('aside');
    this.panel.className='page-dev-window legend-dev-window';
    this.panel.style.cssText='position:fixed!important;right:12px;top:12px;bottom:auto!important;left:auto;max-height:74vh;';
    this.panel.innerHTML=`<div class="pdw-title" data-drag><b>${this.title}</b><button data-close>×</button></div>
      <div class="pdw-row"><label>Target</label><select data-target></select></div>
      <div class="pdw-values">${['x','y','w','h'].map(k=>`<label>${k.toUpperCase()}<input data-${k} type="number"></label>`).join('')}</div>
      <div class="pdw-row"><label>Snap</label><select data-snap><option>1</option><option>2</option><option>4</option><option>8</option><option>16</option></select><button data-snap-toggle>SNAP ON</button></div>
      <div class="pdw-nudge"><button data-nudge="up">▲</button><button data-nudge="left">◀</button><button data-nudge="down">▼</button><button data-nudge="right">▶</button></div>
      <div class="pdw-actions"><button data-save>SAVE</button><button data-load>LOAD</button><button data-reset>RESET</button><button data-export>EXPORT JSON</button></div>
      <div class="pdw-actions"><button data-toggle>EDIT ON</button></div>
      <fieldset class="ldw-text" data-text-wrap hidden><legend>TEXT</legend><textarea data-text rows="3"></textarea><div class="ldw-style-grid"><label>Size<input data-font-size type="number" min="5" max="96"></label><label>Spacing<input data-letter-spacing type="number" step="0.1"></label><label>Colour<input data-color type="color"></label><label>Align<select data-align><option value="left">LEFT</option><option value="center">CENTRE</option><option value="right">RIGHT</option></select></label></div></fieldset>
      <small>Move/resize shell legends here. Text legends can also be renamed and restyled. This development window is private and does not ship.</small>`;
    document.body.appendChild(this.panel);this.restorePos();
    this.box=document.createElement('div');this.box.className='page-dev-selection';this.box.innerHTML='<span></span><i></i>';document.body.appendChild(this.box);this.box.hidden=true;
    this.grid=document.createElement('div');this.grid.className='page-dev-grid';document.body.appendChild(this.grid);this.grid.hidden=true;
  }
  bind(){
    this.panel.querySelector('[data-close]').onclick=()=>{this.closed=true;this.panel.hidden=true;this.box.hidden=true;this.grid.hidden=true};
    this.panel.querySelector('[data-toggle]').onclick=()=>{this.enabled=!this.enabled;this.panel.querySelector('[data-toggle]').textContent=this.enabled?'EDIT ON':'EDIT OFF';this.updateBox()};
    this.panel.querySelector('[data-reset]').onclick=()=>{localStorage.removeItem(this.storageKey);for(const el of this.targets())this.clearDevStyle(el);this.sync(true)};
    this.panel.querySelector('[data-save]').onclick=()=>this.saveAll();
    this.panel.querySelector('[data-load]').onclick=()=>{this.applySaved();this.sync(true)};
    this.panel.querySelector('[data-export]').onclick=()=>this.exportJson();
    this.panel.querySelector('[data-target]').onchange=e=>this.selectByKey(e.target.value);
    this.panel.querySelector('[data-snap]').onchange=e=>this.snap=+e.target.value||1;
    this.panel.querySelector('[data-snap-toggle]').onclick=()=>{this.snapEnabled=!this.snapEnabled;this.panel.querySelector('[data-snap-toggle]').textContent=this.snapEnabled?'SNAP ON':'SNAP OFF'};
    this.snapEnabled=true;
    for(const k of ['x','y','w','h']){const inp=this.panel.querySelector(`[data-${k}]`);inp.onchange=()=>this.applyFields();inp.onkeydown=e=>{if(e.key==='Enter')this.applyFields()}}
    for(const k of ['text','font-size','letter-spacing','color','align']){const el=this.panel.querySelector(`[data-${k}]`);if(el) el.addEventListener('input',()=>this.applyTextFields())}
    for(const b of this.panel.querySelectorAll('[data-nudge]')) b.onclick=()=>this.nudge(b.dataset.nudge);

    const handle=this.panel.querySelector('[data-drag]');
    handle.addEventListener('pointerdown',e=>{if(e.target.closest('button,input,select,textarea'))return;e.preventDefault();const r=this.panel.getBoundingClientRect();this.panelDrag={id:e.pointerId,startX:e.clientX,startY:e.clientY,left:r.left,top:r.top};this.panel.style.right='auto';this.panel.style.bottom='auto';});
    document.addEventListener('pointermove',e=>{
      if(this.panelDrag&&e.pointerId===this.panelDrag.id){e.preventDefault();const w=this.panel.offsetWidth,h=this.panel.offsetHeight;const left=clamp(this.panelDrag.left+e.clientX-this.panelDrag.startX,0,Math.max(0,innerWidth-w));const top=clamp(this.panelDrag.top+e.clientY-this.panelDrag.startY,0,Math.max(0,innerHeight-h));this.panel.style.setProperty('left',left+'px','important');this.panel.style.setProperty('top',top+'px','important');this.panel.style.setProperty('right','auto','important');this.panel.style.setProperty('bottom','auto','important');}
      if(this.boxDrag&&e.pointerId===this.boxDrag.id)this.dragBox(e);
    },{passive:false});
    document.addEventListener('pointerup',e=>{if(this.panelDrag&&e.pointerId===this.panelDrag.id){this.panelDrag=null;this.savePos()}if(this.boxDrag&&e.pointerId===this.boxDrag.id){this.boxDrag=null;this.saveSelected();this.updateFields()}});

    this.box.addEventListener('pointerdown',e=>{if(!this.enabled||!this.selected)return;e.preventDefault();e.stopPropagation();this.boxDrag={id:e.pointerId,startX:e.clientX,startY:e.clientY,start:this.geom(this.selected),resize:e.target.tagName==='I'};});
    window.addEventListener('resize',()=>this.updateBox());
    window.addEventListener('keydown',e=>{if(!this.enabled||!this.selected||e.target.closest?.('.page-dev-window'))return;if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();this.nudge(({ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down'})[e.key],e.shiftKey?10:this.snap)},true);
  }
  nudge(dir,amount=this.snap){if(!this.selected)return;const g=this.geom(this.selected),d=amount;if(dir==='left')g.x-=d;if(dir==='right')g.x+=d;if(dir==='up')g.y-=d;if(dir==='down')g.y+=d;this.setGeom(this.selected,g);this.saveSelected()}
  dragBox(e){if(!this.selected||!this.boxDrag)return;const f=this.frame(),d=this.dims();if(!f)return;const r=f.getBoundingClientRect(),dx=(e.clientX-this.boxDrag.startX)*d.w/r.width,dy=(e.clientY-this.boxDrag.startY)*d.h/r.height;const g={...this.boxDrag.start};if(this.boxDrag.resize){g.w=Math.max(20,g.w+dx);g.h=Math.max(10,g.h+dy)}else{g.x+=dx;g.y+=dy}this.setGeom(this.selected,g)}
  setGeom(el,g){const d=this.dims();const snap=v=>this.snapEnabled?Math.round(v/this.snap)*this.snap:v;g={x:snap(g.x),y:snap(g.y),w:Math.max(10,snap(g.w)),h:Math.max(10,snap(g.h))};el.style.setProperty('position','absolute','important');el.style.setProperty('left',(g.x/d.w*100)+'%','important');el.style.setProperty('top',(g.y/d.h*100)+'%','important');el.style.setProperty('width',(g.w/d.w*100)+'%','important');el.style.setProperty('height',(g.h/d.h*100)+'%','important');el.style.setProperty('right','auto','important');el.style.setProperty('bottom','auto','important');this.updateBox();this.updateFields()}
  clearDevStyle(el){for(const p of ['left','top','width','height','right','bottom'])el.style.removeProperty(p)}
  selectByKey(k){this.selectedKey=k;this.selected=this.targets().find(x=>this.key(x)===k)||null;const sel=this.panel.querySelector('[data-target]');if(sel)sel.value=k;this.updateBox();this.updateFields()}
  updateBox(){const s=this.screen();if(!this.enabled||this.closed||!s||!this.selected||!document.contains(this.selected)){this.box.hidden=true;return}const a=this.selected.getBoundingClientRect();Object.assign(this.box.style,{position:'fixed',left:a.left+'px',top:a.top+'px',width:a.width+'px',height:a.height+'px'});this.box.querySelector('span').textContent=this.label(this.selected);this.box.hidden=false}
  updateFields(){if(!this.selected)return;const g=this.geom(this.selected);for(const k of ['x','y','w','h'])this.panel.querySelector(`[data-${k}]`).value=Math.round(g[k]);this.fillTextFields()}
  applyFields(){if(!this.selected)return;const g={};for(const k of ['x','y','w','h']){const v=Number(this.panel.querySelector(`[data-${k}]`).value);if(!Number.isFinite(v))return;g[k]=v}this.setGeom(this.selected,g);this.saveSelected()}
  fillTextFields(){const wrap=this.panel.querySelector('[data-text-wrap]');if(!this.selected||!this.hasText(this.selected)){wrap.hidden=true;return}wrap.hidden=false;const cs=getComputedStyle(this.selected);this.panel.querySelector('[data-text]').value=this.selected.textContent;this.panel.querySelector('[data-font-size]').value=parseFloat(cs.fontSize)||12;this.panel.querySelector('[data-letter-spacing]').value=cs.letterSpacing==='normal'?0:(parseFloat(cs.letterSpacing)||0);this.panel.querySelector('[data-color]').value=this.rgbToHex(cs.color);this.panel.querySelector('[data-align]').value=cs.textAlign||'left'}
  applyTextFields(){if(!this.selected||!this.hasText(this.selected))return;const text=this.panel.querySelector('[data-text]').value,size=Number(this.panel.querySelector('[data-font-size]').value),spacing=Number(this.panel.querySelector('[data-letter-spacing]').value),color=this.panel.querySelector('[data-color]').value,align=this.panel.querySelector('[data-align]').value;this.selected.textContent=text;this.selected.style.setProperty('font-size',`${size}px`,'important');this.selected.style.setProperty('letter-spacing',`${spacing}px`,'important');this.selected.style.setProperty('color',color,'important');this.selected.style.setProperty('text-align',align,'important');this.selected.style.setProperty('white-space','pre-wrap','important');this.selected.style.setProperty('overflow-wrap','anywhere','important');this.saveSelected();this.updateBox()}
  saveSelected(){if(!this.selected)return;let all={};try{all=JSON.parse(localStorage.getItem(this.storageKey)||'{}')||{}}catch{};const item={...this.geom(this.selected)};if(this.hasText(this.selected)){const cs=getComputedStyle(this.selected);item.text=this.selected.textContent;item.fontSize=parseFloat(cs.fontSize)||12;item.letterSpacing=cs.letterSpacing==='normal'?0:(parseFloat(cs.letterSpacing)||0);item.color=this.rgbToHex(cs.color);item.textAlign=cs.textAlign||'left';}all[this.key(this.selected)]=item;localStorage.setItem(this.storageKey,JSON.stringify(all))}
  applySaved(){let all={};try{all=JSON.parse(localStorage.getItem(this.storageKey)||'{}')||{}}catch{};for(const el of this.targets()){const item=all[this.key(el)];if(!item)continue;this.setGeom(el,item);if(this.hasText(el)){if(item.text!=null)el.textContent=item.text;if(item.fontSize!=null)el.style.setProperty('font-size',`${item.fontSize}px`,'important');if(item.letterSpacing!=null)el.style.setProperty('letter-spacing',`${item.letterSpacing}px`,'important');if(item.color)el.style.setProperty('color',item.color,'important');if(item.textAlign)el.style.setProperty('text-align',item.textAlign,'important');el.style.setProperty('white-space','pre-wrap','important');el.style.setProperty('overflow-wrap','anywhere','important');}}}
  sync(force=false){const s=this.screen();this.panel.hidden=!s||this.closed;if(!s){this.box.hidden=true;this.selected=null;return}const ts=this.targets(),sel=this.panel.querySelector('[data-target]'),keys=ts.map(x=>this.key(x));if(force||sel.dataset.keys!==keys.join('|')){sel.innerHTML=keys.map(k=>`<option value="${k}">${(ts.find(x=>this.key(x)===k)?.dataset?.devLabel)||k}</option>`).join('');sel.dataset.keys=keys.join('|');this.applySaved();if(!this.selectedKey||!keys.includes(this.selectedKey))this.selectedKey=keys[0]||'';this.selectByKey(this.selectedKey)}else if(this.selectedKey){const current=ts.find(x=>this.key(x)===this.selectedKey);if(current!==this.selected){this.selected=current||null;this.applySaved();this.updateBox();this.updateFields()}else this.updateBox();}}
  open(){this.closed=false;this.sync(true)}
  toggle(){this.closed=!this.closed;this.panel.hidden=this.closed;if(this.closed){this.box.hidden=true;this.grid.hidden=true}else this.sync(true)}
  saveAll(){const all={};for(const el of this.targets()){const item={...this.geom(el)};if(this.hasText(el)){const cs=getComputedStyle(el);item.text=el.textContent;item.fontSize=parseFloat(cs.fontSize)||12;item.letterSpacing=cs.letterSpacing==='normal'?0:(parseFloat(cs.letterSpacing)||0);item.color=this.rgbToHex(cs.color);item.textAlign=cs.textAlign||'left';}all[this.key(el)]=item}localStorage.setItem(this.storageKey,JSON.stringify(all))}
  restorePos(){try{const p=JSON.parse(localStorage.getItem(this.storageKey+'_panel')||'null');if(p){this.panel.style.setProperty('left',p.left+'px','important');this.panel.style.setProperty('top',p.top+'px','important');this.panel.style.setProperty('right','auto','important');this.panel.style.setProperty('bottom','auto','important')}}catch{}}
  savePos(){const r=this.panel.getBoundingClientRect();localStorage.setItem(this.storageKey+'_panel',JSON.stringify({left:r.left,top:r.top}))}
  exportJson(){const payload={page:'shell',layer:'legend',title:this.title,storageKey:this.storageKey,design:{width:W,height:H},exportedAt:new Date().toISOString(),elements:this.targets().map(el=>{const g=this.geom(el),obj={key:this.key(el),label:this.label(el),x:Math.round(g.x),y:Math.round(g.y),w:Math.round(g.w),h:Math.round(g.h)};if(this.hasText(el)){const cs=getComputedStyle(el);obj.text=el.textContent;obj.fontSize=parseFloat(cs.fontSize)||12;obj.letterSpacing=cs.letterSpacing==='normal'?0:(parseFloat(cs.letterSpacing)||0);obj.color=this.rgbToHex(cs.color);obj.textAlign=cs.textAlign||'left';}return obj;})};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${this.storageKey}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
}
