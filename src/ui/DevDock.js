export class DevDock{
 constructor({root,editors}){
  this.root=root;this.editors=editors;
  this.bar=document.createElement('div');
  this.bar.className='d8m4-dev-dock';
  this.bar.innerHTML='<button data-d="design">DESIGN DEV</button><button data-d="live">LIVE DEV</button><button data-d="both">BOTH</button><button data-d="legend">LEGEND DEV</button>';
  document.body.appendChild(this.bar);
  this.bar.onclick=e=>{
   const k=e.target.dataset.d;if(!k)return;const active=this.active();if(!active.length)return;
   if(k==='both'){
    const pair=active.filter(x=>x.layer==='design'||x.layer==='live');
    if(!pair.length)return;
    const open=pair.some(x=>x.closed);
    pair.forEach(x=>open?x.open():(x.closed=true,x.panel.hidden=true,x.box&&(x.box.hidden=true),x.grid&&(x.grid.hidden=true)));
   }else active.find(x=>x.layer===k)?.toggle();
   this.paint();
  };
  setInterval(()=>this.paint(),250);
 }
 active(){const page=this.root.querySelector('.crt-screen')?.dataset?.devPage;return this.editors.filter(x=>x.page===page||x.page==='global')}
 paint(){const a=this.active();this.bar.hidden=!a.length;if(!a.length)return;for(const b of this.bar.querySelectorAll('button')){const k=b.dataset.d;if(k==='both'){const pair=a.filter(x=>x.layer==='design'||x.layer==='live');b.classList.toggle('active',pair.length?pair.every(x=>!x.closed):false);}else b.classList.toggle('active',!a.find(x=>x.layer===k)?.closed)}}
}
