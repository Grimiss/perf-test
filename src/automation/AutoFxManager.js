const clamp01=v=>Math.max(0,Math.min(1,Number(v)||0));
const FX=['tremolo','delay','reverb','width'];

export class AutoFxManager{
  constructor({store,applyLevel,beginOverride=()=>{},endOverride=()=>{},onStatus=()=>{}}){
    this.store=store;this.applyLevel=applyLevel;this.beginOverride=beginOverride;this.endOverride=endOverride;this.onStatus=onStatus;
    this.waitTimer=null;this.motionTimer=null;this.activeNames=[];this.lastNames=[];this.generation=0;
  }
  setEnabled(enabled){
    if(!enabled){this.stop(true);return;}
    if(this.store.getState().transport.status==='playing')this.schedule(true);
  }
  onTransport(status){if(status==='playing'&&this.store.getState().autoFx?.enabled)this.schedule(true);else this.stop(true);}
  settingsChanged(){if(this.store.getState().autoFx?.enabled&&this.store.getState().transport.status==='playing'&&!this.activeNames.length)this.schedule(true);}
  stop(restore=false){
    this.generation++; if(this.waitTimer)clearTimeout(this.waitTimer); if(this.motionTimer)clearInterval(this.motionTimer);this.waitTimer=null;this.motionTimer=null;
    if(restore&&this.activeNames.length){const state=this.store.getState();for(const n of this.activeNames){const base=state.autoFx?.baselines?.[n];if(Number.isFinite(base))this.applyLevel(n,base);this.endOverride(`effect:${n}`);}}
    this.activeNames=[];this.onStatus({active:false,activeEffects:[]});
  }
  schedule(immediate=false){
    if(this.waitTimer||this.motionTimer||this.activeNames.length)return;
    const s=this.store.getState();if(!s.autoFx?.enabled||s.transport.status!=='playing')return;
    const freq=String(s.autoFx.frequency||'MED').toUpperCase();
    const ranges={LOW:[45000,90000],MED:[25000,50000],HIGH:[12000,26000]};const [a,b]=ranges[freq]||ranges.MED;
    const delay=immediate?1400:a+Math.random()*(b-a);
    this.waitTimer=setTimeout(()=>{this.waitTimer=null;this.runEvent();},delay);
  }
  chooseCount(){const mode=String(this.store.getState().autoFx?.countMode||'1').toUpperCase();if(mode==='ALL')return 4;if(mode==='RND'){const r=Math.random();return r<.38?1:r<.70?2:r<.90?3:4;}return Math.max(1,Math.min(3,Number(mode)||1));}
  chooseNames(count){
    const s=this.store.getState();const enabled=FX.filter(n=>s.effects[n]?.enabled!==false);const pool=enabled.length?enabled:[...FX];count=Math.min(count,pool.length);
    const chosen=[];while(chosen.length<count){const candidates=pool.filter(n=>!chosen.includes(n));const weights=candidates.map(n=>this.lastNames.includes(n)?.22:1);let pick=Math.random()*weights.reduce((x,y)=>x+y,0);let selected=candidates[candidates.length-1];for(let i=0;i<candidates.length;i++){pick-=weights[i];if(pick<=0){selected=candidates[i];break;}}chosen.push(selected);}return chosen;
  }
  runEvent(){
    const s=this.store.getState();if(!s.autoFx?.enabled||s.transport.status!=='playing')return;
    const names=this.chooseNames(this.chooseCount());if(!names.length){this.schedule();return;}
    const baselines={};for(const n of names){baselines[n]=clamp01(s.effects[n]?.level);this.beginOverride(`effect:${n}`);}
    this.activeNames=[...names];this.lastNames=[...names];this.onStatus({active:true,activeEffects:[...names],baselines});
    const g=++this.generation;const downMs=7000+Math.random()*5000;const upMs=8000+Math.random()*6000;const start=performance.now();let phase='down';let phaseStart=start;
    this.motionTimer=setInterval(()=>{
      if(g!==this.generation)return;const live=this.store.getState();if(!live.autoFx?.enabled||live.transport.status!=='playing'){this.stop(true);return;}
      const now=performance.now();if(phase==='down'){
        const p=Math.min(1,(now-phaseStart)/downMs),e=p*p*(3-2*p);for(const n of names)this.applyLevel(n,baselines[n]*(1-e));
        if(p>=1){phase='up';phaseStart=now;}
      }else{
        const p=Math.min(1,(now-phaseStart)/upMs),e=p*p*(3-2*p);for(const n of names)this.applyLevel(n,baselines[n]*e);
        if(p>=1){clearInterval(this.motionTimer);this.motionTimer=null;for(const n of names){this.applyLevel(n,baselines[n]);this.endOverride(`effect:${n}`);}this.activeNames=[];this.onStatus({active:false,activeEffects:[],lastEffects:[...names]});this.schedule();}
      }
    },100);
  }
}
