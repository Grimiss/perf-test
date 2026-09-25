import { StateStore } from './core/StateStore.js?v=rc216';
import { createInitialState } from './core/defaults.js?v=rc216';
import { AppController } from './core/AppController.js?v=rc216';
import { AudioEngine } from './audio/AudioEngine.js?v=rc216';
import { SoundscapeRepository } from './soundscapes/SoundscapeRepository.js?v=rc216';
import { MachineView } from './ui/MachineView_RC216.js';
import { startPerfProbe } from './perf/PerfProbe.js?v=rc216';

async function boot(){
  try{
    const repository=new SoundscapeRepository();
    const soundscape=await repository.getSoundscape('SS01');
    const store=new StateStore(createInitialState(soundscape));
    let controller;
    const audioEngine=new AudioEngine({onEvent:event=>controller?.handleEngineEvent(event)});
    controller=new AppController({store,audioEngine,repository,soundscape});
    const machineView=new MachineView({store,controller});
    const crtRoot=document.querySelector('#crt-screen-root');

    // RC201 PERFORMANCE BUILD: apply the approved shell legend layout once.
    // No DEV editors, selection overlays, or polling loops are created.
    const legendLayout={"unit-name":{"x":50,"y":816,"w":163,"h":29,"text":"D84M","fontSize":25,"letterSpacing":1,"color":"#7c1616","textAlign":"left"},"portable-line":{"x":545,"y":825,"w":333,"h":23,"text":"PORTABLE TELEVISION set","fontSize":15,"letterSpacing":0.8,"color":"#403c34","textAlign":"right"},"soundscapes-title":{"x":900,"y":26,"w":172,"h":23,"text":"SOUNDSCAPES","fontSize":11,"letterSpacing":0.9,"color":"#26231e","textAlign":"center"},"brightness-title":{"x":877,"y":345,"w":215,"h":20,"text":"BRIGHTNESS","fontSize":11,"letterSpacing":1,"color":"#26231e","textAlign":"center"},"tone-title":{"x":919,"y":471,"w":135,"h":20,"text":"TONE","fontSize":13,"letterSpacing":1,"color":"#26231e","textAlign":"center"},"gamevol-title":{"x":878,"y":602,"w":215,"h":20,"text":"GAME VOL","fontSize":13,"letterSpacing":1,"color":"#26231e","textAlign":"center"},"mainvol-title":{"x":881,"y":729,"w":209,"h":20,"text":"MAIN VOL","fontSize":13,"letterSpacing":1,"color":"#26231e","textAlign":"center"},"mute-title":{"x":1085,"y":894,"w":212,"h":20,"text":"MUTE","fontSize":13,"letterSpacing":1,"color":"#26231e","textAlign":"center"},"effects-title":{"x":912,"y":352,"w":390,"h":20,"text":"EFFECTS","fontSize":13,"letterSpacing":1,"color":"#26231e","textAlign":"center"},"mood-title":{"x":910,"y":451,"w":364,"h":20,"text":"MOOD","fontSize":13,"letterSpacing":1,"color":"#26231e","textAlign":"center"},"intensity-title":{"x":1194,"y":564,"w":192,"h":20,"text":"INTENSITY","fontSize":13,"letterSpacing":1,"color":"#26231e","textAlign":"center"},"mode-title":{"x":949,"y":589,"w":289,"h":20,"text":"MODE","fontSize":13,"letterSpacing":1,"color":"#26231e","textAlign":"center"},"timer-title":{"x":965,"y":711,"w":261,"h":20,"text":"TIMER","fontSize":13,"letterSpacing":1,"color":"#26231e","textAlign":"center"},"slower-label":{"x":1084,"y":539,"w":81,"h":13,"text":"SLOWER","fontSize":10,"letterSpacing":1.8,"color":"#65625d","textAlign":"center"},"faster-label":{"x":1419,"y":539,"w":71,"h":13,"text":"FASTER","fontSize":10,"letterSpacing":1.8,"color":"#65625d","textAlign":"center"},"video-in-label":{"x":317,"y":891,"w":117,"h":16,"text":"VIDEO IN","fontSize":9,"letterSpacing":1,"color":"#2b2722","textAlign":"center"},"audio-l-label":{"x":391,"y":891,"w":81,"h":16,"text":"AUDIO\nL","fontSize":9,"letterSpacing":1,"color":"#2b2722","textAlign":"center"},"audio-r-label":{"x":446,"y":891,"w":81,"h":16,"text":"AUDIO\nR","fontSize":9,"letterSpacing":1,"color":"#2b2722","textAlign":"center"},"headphones-icon":{"x":1154,"y":951,"w":74,"h":34},"brand-logo":{"x":639,"y":902,"w":187,"h":39},"brand-drone":{"x":562,"y":952,"w":246,"h":15,"text":"DRONE MACHINE - ","fontSize":12,"letterSpacing":1.44,"color":"#403c34","textAlign":"center"},"brand-model":{"x":750,"y":952,"w":106,"h":13,"text":"MODEL D84M","fontSize":12,"letterSpacing":1.44,"color":"#403c34","textAlign":"center"}};
    const machineRoot=document.querySelector('#machine');
    if(machineRoot){
      for(const [key,item] of Object.entries(legendLayout)){
        const el=machineRoot.querySelector(`[data-legend-dev][data-dev-key="${key}"]`);
        if(!el) continue;
        el.style.left=`${item.x/1536*100}%`;
        el.style.top=`${item.y/1024*100}%`;
        el.style.width=`${item.w/1536*100}%`;
        el.style.height=`${item.h/1024*100}%`;
        if(item.text!=null && el.hasAttribute('data-edit-text')) el.textContent=item.text;
        if(item.fontSize!=null) el.style.fontSize=`${item.fontSize}px`;
        if(item.letterSpacing!=null) el.style.letterSpacing=`${item.letterSpacing}px`;
        if(item.color) el.style.color=item.color;
        if(item.textAlign) el.style.textAlign=item.textAlign;
      }
    }

    // Optional low-overhead profiler: append ?perf=1 to the Netlify URL.
    startPerfProbe({getScreen:()=>machineView.crt.currentScreen||'boot'});
    window.D8M4_CP06={getState:()=>structuredClone(store.getState()),getRevision:()=>store.revision,getAudioDiagnostics:()=>audioEngine.getDiagnostics(),controller};
  }catch(error){
    console.error(error); const root=document.querySelector('#crt-screen-root'); if(root) root.innerHTML=`<div class='crt-screen missing-screen'><div class='missing-big'>BOOT ERROR</div><div class='missing-file'>${error.message}</div></div>`;
  }
}
boot();
