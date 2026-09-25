const clamp=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||0));
const clamp01=v=>clamp(v,0,1), clampBi=v=>clamp(v,-1,1);
const jitter=(base,frac=.16)=>base*(1-frac+Math.random()*frac*2);

export class FxModManager {
  constructor({store,apply,suspend,resume,onStatus=()=>{}}){
    this.store=store; this.apply=apply; this.suspend=suspend; this.resume=resume; this.onStatus=onStatus;
    this.baseline=null; this.active=false; this.timer=null; this.autoTimer=null; this.generation=0; this.manual=false;
    this.gesture=[]; this.gestureStart=0;
    this.scopeTimer=null; this.scopeEpochMs=0; this.scopePassCount=0;
    this.randomProbTarget=null;
    this.gameControlled=false;
    this.manualOverrideIds=new Set();
  }

  paramOn(name){return this.store.getState().fxMod?.params?.[name]!==false;}
  automationIds(){return ['effect:reverb','effect:width','effect:tremolo','effect:delay',...Array.from({length:4},(_,i)=>`track:${i}:filter`)];}
  selectedAutomationIds(){
    const p=this.store.getState().fxMod?.params||{}; const ids=[];
    if(p.reverb!==false)ids.push('effect:reverb'); if(p.width!==false)ids.push('effect:width');
    if(p.tremolo!==false)ids.push('effect:tremolo'); if(p.delay!==false)ids.push('effect:delay');
    for(let i=0;i<4;i++) if(p.filter!==false)ids.push(`track:${i}:filter`);
    return ids;
  }
  syncOwnership(){
    const enabled=Boolean(this.store.getState().fxMod?.enabled);
    const selected=new Set(enabled?this.selectedAutomationIds():[]);
    this.automationIds().forEach(id=>selected.has(id)?this.suspend(id):this.resume(id));
  }
  onParamsChanged(){ this.syncOwnership(); }
  setEnabled(enabled){
    if(!enabled){this.cancel(true);this.stopAuto();this.syncOwnership();}
    else {this.syncOwnership();this.scheduleAuto(true);}
  }
  onTransport(status){ if(status==='playing'&&this.store.getState().fxMod.enabled){this.syncOwnership();this.scheduleAuto(true);} else this.stopAuto(); }
  onFRSChanged(){ if(this.store.getState().fxMod.enabled)this.scheduleAuto(true); }
  setGameControlled(enabled){
    this.gameControlled=Boolean(enabled);
    if(this.gameControlled){
      if(this.scopeTimer)clearTimeout(this.scopeTimer); this.scopeTimer=null;
      if(this.autoTimer)clearTimeout(this.autoTimer); this.autoTimer=null;
      this.scopePassCount=0; this.randomProbTarget=null;
      this.onStatus({scopePassCount:0});
    }else if(this.store.getState().fxMod.enabled && this.store.getState().transport.status==='playing'){
      this.scheduleAuto(true);
    }
  }
  onTimeChanged(mode,{fromInfinity=false}={}){
    if(mode==='INF'){
      this.scheduleAuto(false);
      if(this.store.getState().transport.status==='playing' && !this.active && !this.manual && this.#hasPattern()) this.triggerRandom('auto');
      return;
    }
    if(!this.active||this.manual)return;
    // Leaving INF should feel like releasing momentum, not snapping back to the
    // newly selected 01-second mode. Give it a long, smooth drift home.
    this.#recoverFromCurrent(fromInfinity ? 10000 : null);
  }

  onTimingChanged(){
    if(this.active && !this.manual && !this.#isInfinity()) this.#recoverFromCurrent();
  }
  onInfinityChanged(enabled){
    if(enabled){
      this.scheduleAuto(false);
      if(this.store.getState().transport.status==='playing' && !this.active && !this.manual && this.#hasPattern()) this.triggerRandom('auto');
    } else if(this.active && !this.manual){
      this.#recoverFromCurrent();
    }
  }
  beginParamOverride(id){
    if(!id)return; this.manualOverrideIds.add(id);
    this.onStatus({manualOverrideCount:this.manualOverrideIds.size});
  }
  endParamOverride(id){
    if(!id)return; this.manualOverrideIds.delete(id);
    this.onStatus({manualOverrideCount:this.manualOverrideIds.size});
  }
  manualOverrideValue(id,value){
    if(!this.active || !this.baseline || !id)return;
    const v=Number(value);
    const effect=/^effect:(reverb|width|tremolo|delay)$/.exec(id);
    if(effect)this.baseline[effect[1]]=clamp01(v);
    else if(id==='global:intensity')this.baseline.intensity=clampBi(v);
    else { const m=/^track:(\d+):filter$/.exec(id); if(m&&this.baseline.filters[Number(m[1])]!==undefined)this.baseline.filters[Number(m[1])]=clampBi(v); }
  }

  onProbabilityChanged(){ this.scopePassCount=0; this.randomProbTarget=null; this.onStatus({scopePassCount:0}); }

  #drawWeightedRandomProbTarget(){
    const weights=Array.from({length:10},(_,i)=>10-i); // 1 is most likely, 10 least likely
    const total=weights.reduce((a,b)=>a+b,0);
    let pick=Math.random()*total;
    for(let i=0;i<weights.length;i++){
      pick-=weights[i];
      if(pick<=0) return i+1;
    }
    return 1;
  }
  #probPassTarget(){
    const raw=String(this.store.getState().fxMod?.probMode||'x1').toUpperCase();
    if(raw==='RND'){
      if(!Number.isInteger(this.randomProbTarget) || this.randomProbTarget<1 || this.randomProbTarget>10){
        this.randomProbTarget=this.#drawWeightedRandomProbTarget();
      }
      return this.randomProbTarget;
    }
    this.randomProbTarget=null;
    const cleaned=raw.toLowerCase().replace('x','');
    return Math.max(1,Math.min(10,Number.parseInt(cleaned,10)||1));
  }
  #scopeCycleMs(){
    const frs=this.store.getState().frs;
    return frs==='sleep'?12800:frs==='relax'?6400:3200;
  }
  #timeMode(){ return this.store.getState().fxMod?.timeMode || 'CUSTOM'; }
  #isInfinity(){ const fx=this.store.getState().fxMod||{}; return Boolean(fx.infinite || fx.timeMode==='INF'); }
  #attackMs(){ return Math.max(250,Math.min(8000,Number(this.store.getState().fxMod?.attackMs)||1800)); }
  #recoverMs(){ return Math.max(500,Math.min(12000,Number(this.store.getState().fxMod?.releaseMs)||4000)); }
  #influenceScale(){ const m=String(this.store.getState().fxMod?.influence||'MED').toUpperCase(); return m==='LOW'?.45:m==='HIGH'?1:.72; }
  #fx(){ return this.store.getState().fxMod || {}; }
  #memory(){ const fx=this.#fx(); return {x:clampBi(fx.memoryX||0), y:clampBi(fx.memoryY||0)}; }
  #releaseVelocity(){ const rv=this.#fx().releaseVelocity||{}; return {x:Number(rv.x)||0,y:Number(rv.y)||0}; }
  #storedTrajectory(){
    const fx=this.#fx();
    const raw=Array.isArray(fx.trajectory)?fx.trajectory:[];
    const cleaned=raw
      .map(p=>({t:Math.max(0,Number(p?.t)||0),x:clampBi(p?.x),y:clampBi(p?.y)}))
      .filter((p,i,a)=>i===0 || p.t>=a[i-1].t);
    if(cleaned.length>=2) return cleaned;
    const mem=this.#memory();
    if(Math.abs(mem.x)>.01 || Math.abs(mem.y)>.01) return [{t:0,x:0,y:0},{t:240,x:mem.x,y:mem.y}];
    return [];
  }
  #hasPattern(){ return this.#storedTrajectory().length>=2; }

  scheduleAuto(replace=false){
    const s=this.store.getState();
    if(this.gameControlled||!s.fxMod.enabled||s.transport.status!=='playing'){ this.stopAuto(); return; }
    const cycleMs=this.#scopeCycleMs();
    if(replace || !this.scopeEpochMs){
      if(this.scopeTimer)clearTimeout(this.scopeTimer);
      this.scopeTimer=null;
      this.scopeEpochMs=Date.now();
      this.scopePassCount=0;
      this.onStatus({scopeEpochMs:this.scopeEpochMs,scopeCycleMs:cycleMs,scopePassCount:0});
    }
    if(this.scopeTimer)return;
    const now=Date.now();
    const elapsed=Math.max(0,now-this.scopeEpochMs);
    const phase=elapsed%cycleMs;
    const wait=Math.max(16,cycleMs-phase);
    this.scopeTimer=setTimeout(()=>this.#onScopeZeroPass(),wait);
  }
  #onScopeZeroPass(){
    this.scopeTimer=null;
    const s=this.store.getState();
    if(this.gameControlled||!s.fxMod.enabled||s.transport.status!=='playing')return;
    const cycleMs=this.#scopeCycleMs();
    // Keep the original epoch fixed. The visible sweep and the trigger clock
    // therefore share one continuous phase and cannot jump when an SpE updates
    // state or finishes a recorded gesture. Phase 0 is the 12-o'clock/up point.
    if(!this.#isInfinity() && !this.active && !this.manual && this.#hasPattern()){
      this.scopePassCount+=1;
      const target=this.#probPassTarget();
      if(this.scopePassCount>=target){
        this.scopePassCount=0;
        this.randomProbTarget=null;
        this.onStatus({scopeCycleMs:cycleMs,scopePassCount:0});
        this.triggerRandom('auto');
      }else{
        this.onStatus({scopeCycleMs:cycleMs,scopePassCount:this.scopePassCount});
      }
    }else{
      this.onStatus({scopeCycleMs:cycleMs,scopePassCount:this.scopePassCount});
    }
    // Re-arm against the unchanged epoch instead of adding a cycle to "now".
    // That prevents timer drift and keeps every trigger locked to the top pass.
    this.scheduleAuto(false);
  }
  stopAuto(){
    if(this.autoTimer)clearTimeout(this.autoTimer); this.autoTimer=null;
    if(this.scopeTimer)clearTimeout(this.scopeTimer); this.scopeTimer=null;
  }
  capture(){ const s=this.store.getState(); return {reverb:s.effects.reverb.level,width:s.effects.width.level,tremolo:s.effects.tremolo.level,delay:s.effects.delay.level,intensity:s.intensity,filters:s.tracks.map(t=>t.filter)}; }

  beginManual(){
    if(!this.store.getState().fxMod.enabled)return false;
    this.manual=true; this.gesture=[]; this.gestureStart=performance.now();
    this.#begin('manual');
    this.#recordPoint(0,0);
    return true;
  }
  moveManual(x,y){
    if(!this.manual)return;
    const cx=clampBi(x), cy=clampBi(y);
    this.#recordPoint(cx,cy);
    this.#applyXY(cx,cy,'MANUAL');
  }
  endManual(vx=0,vy=0){
    if(!this.manual)return;
    const fx=this.#fx();
    const currentX=clampBi(fx.x||0), currentY=clampBi(fx.y||0);
    this.#recordPoint(currentX,currentY,true);
    const trajectory=this.#normaliseTrajectory(this.gesture);
    this.manual=false;

    const last=trajectory.length ? trajectory[trajectory.length-1] : {x:currentX,y:currentY};
    this.onStatus({
      memoryX:clampBi(last.x||0),
      memoryY:clampBi(last.y||0),
      trajectory,
      releaseVelocity:{x:Number(vx)||0,y:Number(vy)||0}
    });

    const speed=Math.hypot(Number(vx)||0,Number(vy)||0);
    if(this.#isInfinity()){
      if(speed>.22)this.#coast(Number(vx)||0,Number(vy)||0);
      else this.onStatus({active:true,stage:'HOLD'});
      return;
    }
    if(speed>.22)this.#coast(Number(vx)||0,Number(vy)||0);
    else this.#recoverFrom(currentX,currentY);
  }
  onHoldChanged(mode){ if(!this.active||this.manual||mode==='infinity')return; this.generation++; if(this.timer)clearTimeout(this.timer); this.timer=null; this.#coast(0,0); }

  #recordPoint(x,y,force=false){
    const now=Math.max(0, performance.now() - this.gestureStart);
    const last=this.gesture[this.gesture.length-1];
    const point={t:now,x:clampBi(x),y:clampBi(y)};
    if(!last){ this.gesture.push(point); return; }
    const dist=Math.hypot(point.x-last.x, point.y-last.y);
    const dt=point.t-last.t;
    if(force || dist>.045 || dt>42){
      this.gesture.push(point);
    }else{
      this.gesture[this.gesture.length-1]=point;
    }
  }

  #normaliseTrajectory(points){
    const input=(Array.isArray(points)?points:[]).map(p=>({t:Math.max(0,Number(p?.t)||0),x:clampBi(p?.x),y:clampBi(p?.y)}));
    if(!input.length) return [{t:0,x:0,y:0}];
    let work=input.slice();
    const first=work[0];
    if(Math.hypot(first.x, first.y)>.01) work.unshift({t:0,x:0,y:0});
    if(work.length===1){ work.push({t:220,x:work[0].x,y:work[0].y}); }
    const total=Math.max(180, work[work.length-1].t || 0);
    if(work.length<=14) return work;
    const count=14;
    const output=[work[0]];
    for(let i=1;i<count-1;i++){
      const target=(total*i)/(count-1);
      output.push(this.#sampleAt(work,target));
    }
    output.push({...work[work.length-1], t:total});
    return output;
  }
  #sampleAt(path,target){
    if(target<=0) return {...path[0],t:0};
    for(let i=1;i<path.length;i++){
      const a=path[i-1], b=path[i];
      if(target<=b.t){
        const span=Math.max(1,b.t-a.t), p=(target-a.t)/span;
        return {t:target,x:a.x+(b.x-a.x)*p,y:a.y+(b.y-a.y)*p};
      }
    }
    const last=path[path.length-1];
    return {t:target,x:last.x,y:last.y};
  }

  #coast(vx,vy){
    if(!this.active||!this.baseline)return;
    const g=this.generation;
    let x=clampBi(this.store.getState().fxMod?.x||0), y=clampBi(this.store.getState().fxMod?.y||0);
    const maxV=3.6, mag=Math.hypot(vx,vy)||1, scale=Math.min(1,maxV/mag);
    vx*=scale; vy*=scale;
    let last=performance.now(), settledFrames=0;
    const infinite=this.#isInfinity();
    const factor=infinite?1:(this.#recoverMs()/1000);
    const spring=infinite?0:1.55/factor, damping=infinite?0:1.05/factor;
    const started=performance.now();
    const step=()=>{
      if(g!==this.generation||this.manual)return;
      const now=performance.now(), dt=Math.min(.034,Math.max(.008,(now-last)/1000)); last=now;
      vx+=(-spring*x-damping*vx)*dt; vy+=(-spring*y-damping*vy)*dt;
      x+=vx*dt; y+=vy*dt;
      const r=Math.hypot(x,y);
      if(r>1){
        x/=r; y/=r;
        const radial=vx*x+vy*y;
        if(radial>0){
          if(infinite){ const restitution=.94; vx-=(1+restitution)*radial*x; vy-=(1+restitution)*radial*y; }
          else { vx-=radial*x*1.12; vy-=radial*y*1.12; vx*=.82; vy*=.82; }
        }
      }
      this.#applyXY(x,y,'COAST');
      const energy=Math.hypot(x,y)+Math.hypot(vx,vy)*.55;
      settledFrames=energy<.035?settledFrames+1:0;
      if(!infinite && (settledFrames>8 || now-started>Math.max(2400,this.#recoverMs()*2))){
        // Never snap the last few pixels to neutral. Hand the remaining distance
        // to the same zero-velocity recovery curve used by normal SpE returns.
        const landingMs=Math.max(1200,Math.min(2200,this.#recoverMs()));
        this.#recoverFrom(x,y,landingMs);
        return;
      }
      this.timer=setTimeout(step,16);
    };
    step();
  }

  triggerFromIntensity(delta){ if(!this.store.getState().fxMod.enabled||Math.abs(delta)<.035)return; const strength=clamp(Math.abs(delta)*1.7,.16,1); this.triggerRandom('intensity',strength); }
  triggerRandom(source='auto',strength=null){
    const s=this.store.getState(); if(!s.fxMod.enabled||s.transport.status!=='playing')return false;
    this.#begin(source);
    const pattern=this.#storedTrajectory();
    if(pattern.length>=2){
      this.#playStoredTrajectory(pattern, source, strength==null?1:clamp(strength,.2,1));
      return true;
    }
    const base=strength??(s.frs==='sleep'?.28:s.frs==='relax'?.48:.72);
    const mem=this.#memory();
    let x,y;
    const useMemory=Math.abs(mem.x)>.01 || Math.abs(mem.y)>.01 || this.#isInfinity();
    if(useMemory){
      const mag=strength==null?1:clamp(strength,.2,1);
      x=clampBi(mem.x*mag); y=clampBi(mem.y*mag);
    } else {
      const mag=clamp(base*(.75+Math.random()*.35),.12,1);
      x=(Math.random()*2-1)*mag; y=(Math.random()*2-1)*mag;
      if(Math.abs(x)<.15)x=.15*Math.sign(x||1); if(Math.abs(y)<.15)y=.15*Math.sign(y||-1);
    }
    this.#animateTo(x,y,source);
    return true;
  }

  #playStoredTrajectory(path, source, scale=1){
    const g=this.generation;
    const rv=this.#releaseVelocity();
    const clean=(Array.isArray(path)?path:[]).map(p=>({
      t:Math.max(0,Number(p?.t)||0),
      x:clampBi(p?.x),
      y:clampBi(p?.y)
    }));
    if(clean.length<2){ this.#recoverFromCurrent(); return; }

    // A recorded gesture can contain a centre sample and then a large first
    // pointer sample only a few milliseconds later. Replaying those timestamps
    // literally looks like a jump. Treat the first meaningful non-centre point
    // as the entrance to the gesture and always glide into it first.
    let firstMeaningful=1;
    while(firstMeaningful<clean.length-1 && Math.hypot(clean[firstMeaningful].x,clean[firstMeaningful].y)<.025) firstMeaningful++;
    const entry=clean[firstMeaningful]||clean[clean.length-1];
    const entryX=clampBi(entry.x*scale), entryY=clampBi(entry.y*scale);
    const entryDistance=Math.hypot(entryX,entryY);
    const totalAttack=this.#attackMs();
    const leadInMs=Math.max(140,Math.min(totalAttack*.35,160+entryDistance*220));

    const gestureStartT=entry.t;
    const gestureEndT=clean[clean.length-1].t;
    const recordedDuration=Math.max(1,gestureEndT-gestureStartT);
    const gestureDuration=Math.max(120,totalAttack-leadInMs);
    const start=performance.now();

    const finishGesture=()=>{
      const end=clean[clean.length-1]||{x:0,y:0};
      const ex=clampBi(end.x*scale), ey=clampBi(end.y*scale);
      this.#applyXY(ex,ey,'SPIKE');
      if(this.#isInfinity()){
        const vx=(Number(rv.x)||0)*scale, vy=(Number(rv.y)||0)*scale;
        if(Math.hypot(vx,vy)>.22) this.#coast(vx,vy);
        else this.onStatus({active:true,stage:'HOLD'});
      } else {
        this.#recoverFrom(ex,ey);
      }
    };

    const step=()=>{
      if(g!==this.generation||this.manual)return;
      const elapsed=Math.max(0,performance.now()-start);

      if(elapsed<leadInMs){
        const p=Math.min(1,elapsed/leadInMs);
        // Smootherstep gives zero velocity at both ends. The marker therefore
        // leaves 0,0 gently and joins the stored gesture without a visible kick.
        const e=p*p*p*(p*(p*6-15)+10);
        this.#applyXY(entryX*e,entryY*e,'LEADIN');
        this.timer=setTimeout(step,16);
        return;
      }

      const gestureElapsed=elapsed-leadInMs;
      if(gestureElapsed>=gestureDuration){ finishGesture(); return; }

      const recordedElapsed=(gestureElapsed/gestureDuration)*recordedDuration;
      const sample=this.#sampleAt(clean,gestureStartT+recordedElapsed);
      this.#applyXY(clampBi(sample.x*scale),clampBi(sample.y*scale),'SPIKE');
      this.timer=setTimeout(step,16);
    };
    step();
  }

  #begin(source){
    this.generation++; if(this.timer)clearTimeout(this.timer);
    if(!this.active){ this.baseline=this.capture(); this.syncOwnership(); }
    this.timer=null; this.active=true; this.onStatus({active:true,source,stage:'SPIKE'});
  }
  #applyXY(x,y,stage='ACTIVE'){
    if(!this.baseline)return; const b=this.baseline, k=this.#influenceScale();
    const free=(id)=>!this.manualOverrideIds.has(id);
    if(this.paramOn('reverb')&&free('effect:reverb'))this.apply('effect:reverb',clamp01(b.reverb+x*.42*k));
    if(this.paramOn('width')&&free('effect:width'))this.apply('effect:width',clamp01(b.width+x*.42*k));
    if(this.paramOn('tremolo')&&free('effect:tremolo'))this.apply('effect:tremolo',clamp01(b.tremolo+y*.42*k));
    if(this.paramOn('delay')&&free('effect:delay'))this.apply('effect:delay',clamp01(b.delay+y*.42*k));
    if(this.paramOn('intensity')&&free('global:intensity'))this.apply('global:intensity',clampBi(b.intensity+x*.50*k));
    if(this.paramOn('filter'))b.filters.forEach((v,i)=>{const id=`track:${i}:filter`;if(free(id))this.apply(id,clampBi(v+y*.62*k));});
    this.onStatus({active:true,x,y,stage});
  }
  #animateTo(x,y,source){
    const g=this.generation, start=performance.now(), attack=this.#attackMs();
    const step=()=>{
      if(g!==this.generation||this.manual)return;
      const p=Math.min(1,(performance.now()-start)/attack), e=1-Math.pow(1-p,3);
      this.#applyXY(x*e,y*e,'SPIKE');
      if(p<1)this.timer=setTimeout(step,32);
      else if(this.#isInfinity()) this.onStatus({active:true,stage:'HOLD'});
      else this.#recoverFrom(x,y);
    };
    step();
  }
  #recoverFromCurrent(durationOverride=null){ const fx=this.store.getState().fxMod||{}; this.#recoverFrom(fx.x||0, fx.y||0, durationOverride); }
  #recoverFrom(x,y,durationOverride=null){
    if(!this.active||!this.baseline)return;
    const g=this.generation, start=performance.now(), duration=durationOverride ?? this.#recoverMs();
    const sx=clampBi(x), sy=clampBi(y);
    const step=()=>{
      if(g!==this.generation||this.manual)return;
      const p=Math.min(1,(performance.now()-start)/duration);
      // Smootherstep gives zero velocity at both ends, so the marker eases away
      // from its INF motion and settles gently at the neutral 0,0 position.
      const smooth=p*p*p*(p*(p*6-15)+10);
      const e=1-smooth;
      this.#applyXY(sx*e, sy*e, 'RECOVER');
      if(p<1){
        this.timer=setTimeout(step,16);
      }else{
        // At p=1 the smootherstep expression above already evaluates exactly
        // to 0,0. Finish on the following frame instead of issuing a second
        // hard position write, so there is never a final visual snap.
        this.timer=setTimeout(()=>this.#finish(),16);
      }
    };
    step();
  }
  cancel(restore=true){
    this.generation++; if(this.timer)clearTimeout(this.timer); this.timer=null;
    if(restore&&this.baseline){ const b=this.baseline; this.apply('effect:reverb',b.reverb); this.apply('effect:width',b.width); this.apply('effect:tremolo',b.tremolo); this.apply('effect:delay',b.delay); this.apply('global:intensity',b.intensity); b.filters.forEach((v,i)=>this.apply(`track:${i}:filter`,v)); }
    this.#finish();
  }
  #finish(){
    if(this.timer)clearTimeout(this.timer); this.timer=null; this.active=false; this.manual=false;
    this.manualOverrideIds.clear();
    this.syncOwnership();
    this.scopePassCount=0;
    this.randomProbTarget=null;
    this.onStatus({active:false,x:0,y:0,stage:'IDLE',scopePassCount:0,manualOverrideCount:0});
    this.baseline=null;
    if(!this.gameControlled && this.store.getState().fxMod.enabled && this.store.getState().transport.status==='playing') this.scheduleAuto(false);
  }
}
