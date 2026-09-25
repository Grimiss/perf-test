export function startPerfProbe({getScreen=()=>''}={}){
  const params=new URLSearchParams(location.search);
  if(!params.has('perf')) return null;
  const panel=document.createElement('div');
  panel.id='d8m4-perf-probe';
  panel.style.cssText='position:fixed;left:8px;top:8px;z-index:2147483647;background:rgba(0,0,0,.88);color:#72ff7a;border:1px solid #72ff7a;padding:7px 9px;font:11px/1.35 monospace;white-space:pre;pointer-events:none';
  document.body.appendChild(panel);
  let frames=0,last=performance.now(),fps=0,longTasks=0,longMs=0,maxLong=0,raf=0;
  const samples=[];
  let observer=null;
  try{
    observer=new PerformanceObserver(list=>{
      for(const e of list.getEntries()){
        longTasks+=1; longMs+=e.duration; maxLong=Math.max(maxLong,e.duration);
      }
    });
    observer.observe({entryTypes:['longtask']});
  }catch{}
  const tick=(now)=>{
    frames++;
    const elapsed=now-last;
    if(elapsed>=1000){
      fps=frames*1000/elapsed; samples.push(fps); if(samples.length>10)samples.shift();
      frames=0; last=now;
      const avg=samples.reduce((a,b)=>a+b,0)/samples.length;
      const heap=performance.memory?`${Math.round(performance.memory.usedJSHeapSize/1048576)} MB`:'n/a';
      panel.textContent=`D8M4 PERF RC210\nFPS ${fps.toFixed(0)}  AVG ${avg.toFixed(0)}\nLONG ${longTasks}  ${Math.round(longMs)}ms  MAX ${Math.round(maxLong)}ms\nHEAP ${heap}\nSCREEN ${getScreen()}`;
    }
    raf=requestAnimationFrame(tick);
  };
  raf=requestAnimationFrame(tick);
  const api={snapshot:()=>({fps,averageFps:samples.length?samples.reduce((a,b)=>a+b,0)/samples.length:0,longTasks,longTaskMs:longMs,maxLongTaskMs:maxLong,screen:getScreen()}),stop:()=>{cancelAnimationFrame(raf);observer?.disconnect();panel.remove();}};
  window.D8M4_PERF=api;
  return api;
}
