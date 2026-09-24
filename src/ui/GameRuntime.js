export class GameRuntime {
  constructor({ store, onGameEvent = () => {} }) {
    this.store = store;
    this.onGameEvent = onGameEvent;
    this.canvas = null;
    this.ctx = null;
    this.gameId = null;
    this.game = null;
    this.raf = null;
    this.gameOverRaf = null;
    this.lastTime = 0;
    this.keys = { left:false, right:false, up:false, down:false, fire:false };
    this.audioContext = null;
    this.gameGain = null;
    this.demoMode = false;
    this.demoRestartTimer = null;
    this.readyCountdownTimer = null;
    this.loaderOsc = null;
    this.loaderToneGain = null;
    this.loaderToneTimer = null;
    this.loaderMediaSources = new WeakMap();
  }

  attach(gameId, canvas) {
    this.stop();
    this.gameId = gameId;
    this.canvas = canvas;
    this.ctx = canvas?.getContext?.('2d') || null;
    if (!this.ctx) return;
    this.game = this.#createGame(gameId);
    this.#resetGame();
    this.#beginReadyCountdown();
    if (document.fonts?.load) {
      document.fonts.load('14px ZX').then(() => { if (this.ctx && this.game) this.#draw(); }).catch(()=>{});
    }
  }

  detach() {
    this.stopLoaderSound();
    this.stop();
    this.demoMode = false;
    if (this.demoRestartTimer) clearTimeout(this.demoRestartTimer);
    this.demoRestartTimer = null;
    if (this.readyCountdownTimer) clearTimeout(this.readyCountdownTimer);
    this.readyCountdownTimer = null;
    this.readyCountdownTimer = null;
    this.canvas = null;
    this.ctx = null;
    this.gameId = null;
    this.game = null;
    this.keys = { left:false, right:false, up:false, down:false, fire:false };
  }

  setKey(name, pressed) {
    if (!(name in this.keys)) return;
    this.keys[name] = Boolean(pressed);
    if (pressed && name === 'fire') this.#ensureAudio();
  }

  fire() {
    this.#ensureAudio();
    if (this.game && !this.game.running && this.game.message === 'GAME OVER') {
      this.start();
      return;
    }
    this.keys.fire = true;
    if (this.gameId === 'alien') this.#alienFire();
    else if (this.gameId === 'mushroom') this.#mushroomFire();
    setTimeout(() => { this.keys.fire = false; }, 80);
  }

  isPaused() { return Boolean(this.game?.running && this.game.paused && !this.game?.preStart); }

  isDemoMode() { return Boolean(this.demoMode); }

  rebindCanvas(canvas) {
    this.canvas=canvas;
    this.ctx=canvas?.getContext?.('2d') || null;
    if(this.ctx && this.game) this.#draw();
  }

  resumeWithReadyCountdown() {
    if(!this.game || !this.ctx) return false;
    this.#beginReadyCountdown();
    return true;
  }

  #emitGameEvent(type, detail = {}) {
    try { this.onGameEvent({ type, game: this.gameId, ...detail }); } catch {}
  }

  setDemoMode(enabled) {
    const next = Boolean(enabled);
    this.demoMode = next;
    if (!this.game) return;
    if (next) {
      if (!this.game.running || this.game.message === 'GAME OVER') this.start();
      else if (this.game.paused) this.start();
    } else {
      this.keys.left = false;
      this.keys.right = false;
      this.keys.up = false;
      this.keys.down = false;
      this.keys.fire = false;
      if (this.game.paused && this.game.running) {
        this.game.paused = false;
        this.game.message = 'PLAY';
        this.lastTime = 0;
        this.#schedule();
      }
      this.#draw();
    }
  }

  toggleDemoMode() {
    const wasDemo = this.demoMode;
    this.setDemoMode(!wasDemo);
    return this.demoMode;
  }

  start() {
    if (!this.game || !this.ctx) return;
    if (this.gameOverRaf) { cancelAnimationFrame(this.gameOverRaf); this.gameOverRaf = null; }
    if (this.readyCountdownTimer) { clearTimeout(this.readyCountdownTimer); this.readyCountdownTimer = null; }
    this.#ensureAudio();
    if (this.game.running && this.game.paused) {
      this.game.paused = false;
      this.game.preStart = false;
      this.game.message = 'PLAY';
      this.game.countdown = '';
      this.lastTime = 0;
      this.#schedule();
      return;
    }
    if (this.game.running && this.game.preStart) {
      this.game.preStart = false;
      this.game.paused = false;
      this.game.message = 'PLAY';
      this.game.countdown = '';
      this.lastTime = 0;
      this.#draw();
      this.#schedule();
      return;
    }
    if (this.game.running) return;
    this.#resetGame();
    this.game.running = true;
    this.game.paused = false;
    this.game.preStart = false;
    this.game.message = 'PLAY';
    this.game.countdown = '';
    this.lastTime = 0;
    this.#draw();
    this.#schedule();
  }

  pause() {
    if (!this.game?.running) return;
    if (this.readyCountdownTimer) { clearTimeout(this.readyCountdownTimer); this.readyCountdownTimer = null; }
    this.game.preStart = false;
    this.game.paused = true;
    this.game.countdown = '';
    this.game.message = 'PAUSED';
    this.#draw();
  }

  togglePause() {
    if (!this.game?.running) return this.start();
    if (this.game.paused) this.start(); else this.pause();
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.demoRestartTimer) clearTimeout(this.demoRestartTimer);
    this.demoRestartTimer = null;
    if (this.readyCountdownTimer) clearTimeout(this.readyCountdownTimer);
    this.readyCountdownTimer = null;
    this.readyCountdownTimer = null;
    if (this.gameOverRaf) cancelAnimationFrame(this.gameOverRaf);
    this.raf = null;
    this.gameOverRaf = null;
    this.lastTime = 0;
    if (this.game) {
      this.game.running = false;
      this.game.paused = false;
      this.game.message = 'READY';
      if (this.ctx) this.#draw();
    }
  }

  #schedule() {
    if (this.raf || !this.game?.running || this.game.paused || this.game.preStart) return;
    this.raf = requestAnimationFrame((ts) => this.#frame(ts));
  }

  #frame(ts) {
    this.raf = null;
    if (!this.game?.running) return;
    if (!this.lastTime) this.lastTime = ts;
    const dt = Math.min((ts - this.lastTime) / 1000, 0.05);
    this.lastTime = ts;
    if (!this.game.paused && !this.game.preStart) this.#update(dt);
    this.#draw();
    if (this.game.running && !this.game.paused && !this.game.preStart) this.#schedule();
  }

  #speed() {
    const mode = this.store.getState().frs;
    const frsSpeed = mode === 'sleep' ? 0.5 : mode === 'relax' ? 0.75 : 1;
    const levelSpeed = 1 + Math.max(0, (Number(this.game?.level) || 1) - 1) * 0.05;
    return frsSpeed * levelSpeed;
  }

  #beginReadyCountdown() {
    const g = this.game;
    if (!g || !this.ctx) return;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    if (this.readyCountdownTimer) { clearTimeout(this.readyCountdownTimer); this.readyCountdownTimer = null; }
    const seq = ['3','2','1','START'];
    g.running = true;
    g.paused = false;
    g.preStart = true;
    g.message = 'READY?';
    g.countdown = seq[0];
    this.lastTime = 0;
    const advance = (index) => {
      if (!this.game || this.game !== g) return;
      if (index < seq.length) {
        g.preStart = true;
        g.message = 'READY?';
        g.countdown = seq[index];
        this.#draw();
        this.readyCountdownTimer = setTimeout(() => advance(index + 1), index === seq.length - 1 ? 700 : 800);
        return;
      }
      this.readyCountdownTimer = null;
      g.preStart = false;
      g.countdown = '';
      g.message = 'PLAY';
      this.#draw();
      this.#schedule();
    };
    this.#draw();
    this.readyCountdownTimer = setTimeout(() => advance(1), 800);
  }

  #beginNextStage(buildNextStage) {
    const g = this.game;
    if (!g || !this.ctx) return;
    this.#emitGameEvent('stage-complete', { level: Math.max(1, Number(g.level) - 1) });
    try { buildNextStage?.(); } catch {}
    this.#beep('level');
    this.#beginReadyCountdown();
  }

  #ensureAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this.audioContext) {
        this.audioContext = new AC();
        this.gameGain = this.audioContext.createGain();
        this.gameGain.connect(this.audioContext.destination);
      }
      if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(()=>{});
      this.#syncGameGain();
    } catch {}
  }

  startLoaderSound() {
    // Disabled: loading-screen audio now comes from the original MP4 files.
  }

  stopLoaderSound() {
    // No generated loader tone to stop.
  }

  syncAudioLevels() {
    this.#syncGameGain();
  }

  attachLoaderVideo(video) {
    if (!video) return false;
    this.#ensureAudio();
    if (!this.audioContext || !this.gameGain) return false;
    try {
      if (!this.loaderMediaSources.has(video)) {
        const source = this.audioContext.createMediaElementSource(video);
        source.connect(this.gameGain);
        this.loaderMediaSources.set(video, source);
      }
      video.muted = false;
      video.volume = 1;
      this.#syncGameGain();
      return true;
    } catch {
      return false;
    }
  }

  #syncGameGain() {
    if (!this.gameGain || !this.audioContext) return;
    const state = this.store.getState();
    const aux = state.auxiliary || {};
    const master = state.master || {};
    const gameVolume = Math.max(0, Math.min(1, Number(aux.gameVolume ?? 0.5)));
    const mainVolume = Math.max(0, Math.min(1, Number(master.volume ?? 0.5)));
    const muted = Boolean(aux.muteSounds || master.muted);

    // Logical series routing: GAME VOL -> MAIN VOL -> GLOBAL MUTE.
    // x2 keeps the established nominal level at the default 50% / 50%.
    const level = muted ? 0 : Math.max(0, Math.min(2, gameVolume * mainVolume * 1.0));
    this.gameGain.gain.setTargetAtTime(level, this.audioContext.currentTime, 0.01);
  }

  #beep(kind) {
    this.#ensureAudio();
    if (!this.audioContext || !this.gameGain || this.audioContext.state !== 'running') return;
    this.#syncGameGain();
    const maps = {
      block: { paddle:[520,.12], hit:[240,.21], life:[110,.255], level:[660,.30], gameover:[80,.255] },
      alien: { shot:[760,.12], hit:[260,.21], life:[120,.255], level:[520,.30], gameover:[70,.255] },
      mushroom: { shot:[720,.12], hit:[300,.2025], life:[130,.255], level:[520,.30], gameover:[70,.255], bonus:[900,.225] }
    };
    const cfg = maps[this.gameId]?.[kind] || [440,.04];
    try {
      const osc=this.audioContext.createOscillator();
      const gain=this.audioContext.createGain();
      const now=this.audioContext.currentTime;
      osc.type='square';
      osc.frequency.setValueAtTime(cfg[0],now);
      gain.gain.setValueAtTime(.0001,now);
      gain.gain.exponentialRampToValueAtTime(cfg[1],now+.003);
      gain.gain.exponentialRampToValueAtTime(.0001,now+Math.max(.06,cfg[1]*4));
      osc.connect(gain); gain.connect(this.gameGain); osc.start(now); osc.stop(now+.28);
    } catch {}
  }

  #createGame(id) {
    if (id === 'alien') return {
      width:760,height:470,running:false,paused:false,preStart:false,countdown:'',score:0,lives:3,level:1,
      player:{x:350,y:425,w:50,h:10,speed:390},bullets:[],bombs:[],aliens:[],shields:[],explosions:[],alienDir:1,alienStepTimer:0,shotCooldown:0,bombTimer:1.2,ufo:{active:false,x:0,y:70,w:56,h:18,dir:1,speed:150,timer:4+Math.random()*4},message:'READY'
    };
    if (id === 'mushroom') return {
      width:760,height:470,running:false,paused:false,preStart:false,countdown:'',score:0,lives:3,level:1,
      player:{x:364,y:414,w:32,h:11,speed:230},bullet:null,mushrooms:[],centipedes:[],shotCooldown:0,moveTimer:0,spider:null,spiderTimer:12,scorpion:null,scorpionTimer:18,message:'READY'
    };
    return {
      width:760,height:470,running:false,paused:false,preStart:false,countdown:'',score:0,lives:3,level:1,
      ball:{x:380,y:392,vx:210,vy:-210,r:5},paddle:{x:330,y:430,w:100,h:8,speed:430},bricks:[],flash:0,message:'READY'
    };
  }

  #resetGame() {
    if (!this.game) return;
    if (this.gameId === 'alien') {
      const g=this.game; g.score=0;g.lives=3;g.level=1;g.player.x=(g.width-g.player.w)/2;g.bullets=[];g.bombs=[];g.explosions=[];g.shotCooldown=0;g.bombTimer=1.2;g.message='PLAY';g.preStart=false;g.countdown='';
      this.#alienBuildWave();
    } else if (this.gameId === 'mushroom') {
      const g=this.game;g.score=0;g.lives=3;g.level=1;g.player.x=(g.width-g.player.w)/2;g.player.y=414;g.bullet=null;g.shotCooldown=0;g.message='PLAY';g.preStart=false;g.countdown='';
      this.#mushroomBuildLevel(true);
    } else {
      const g=this.game;g.score=0;g.lives=3;g.level=1;g.paddle.x=(g.width-g.paddle.w)/2;g.flash=0;g.message='PLAY';g.preStart=false;g.countdown='';
      this.#blockBuildBricks();this.#blockResetBall();
    }
  }

  #drawBase(title) {
    const c=this.ctx,g=this.game;if(!c||!g)return;
    c.clearRect(0,0,g.width,g.height);c.fillStyle='#031311';c.fillRect(0,0,g.width,g.height);
    c.fillStyle='rgba(0,255,220,.025)';for(let y=0;y<g.height;y+=6)c.fillRect(0,y,g.width,2);
    c.save();
    const barX=28,barY=35,barW=704,barH=25;
    c.fillStyle='#19d8df';
    c.fillRect(barX,barY,barW,barH);
    if (this.gameId === 'block') {
      const sideW=8,sideBottom=440;
      c.fillRect(barX,barY+barH,sideW,sideBottom-(barY+barH));
      c.fillRect(barX+barW-sideW,barY+barH,sideW,sideBottom-(barY+barH));
    }
    c.font='14px ZX, "Courier New", monospace';c.fillStyle='#000';c.textBaseline='middle';
    c.textAlign='left';c.fillText(`SCORE ${String(g.score).padStart(5,'0')}`,barX+12,barY+barH/2+1);
    c.textAlign='center';c.fillText(`LIVES ${g.lives}`,g.width/2,barY+barH/2+1);
    c.textAlign='right';c.fillText(`LEVEL ${String(g.level).padStart(2,'0')}`,barX+barW-12,barY+barH/2+1);
    c.restore();
  }

  #drawMessage() {
    const c=this.ctx,g=this.game;if(!c||!g)return;
    if(!g.running||g.paused||g.preStart||g.message!=='PLAY'){
      c.save();
      c.textAlign='center';
      if (g.preStart) {
        c.fillStyle='#ef3038';
        c.shadowColor='rgba(239,48,56,.55)';
        c.shadowBlur=4;
        c.font='30px ZX, "Courier New", monospace';
        c.fillText('READY?',g.width/2,252);
        c.font='26px ZX, "Courier New", monospace';
        c.fillText(g.countdown || '',g.width/2,290);
      } else if (g.message === 'GAME OVER' && this.gameId === 'block') {
        const flashCyan=(Math.floor(performance.now()/420)%2)===0;
        const fill=flashCyan?'#19d8df':'#ef3038';
        c.shadowBlur=0;c.font='28px ZX, "Courier New", monospace';c.textBaseline='middle';
        const label='GAME OVER!',padX=24,boxH=52,boxY=241;
        const boxW=Math.ceil(c.measureText(label).width)+padX*2,boxX=(g.width-boxW)/2;
        c.fillStyle=fill;c.fillRect(boxX,boxY,boxW,boxH);
        c.fillStyle='#000';c.fillText(label,g.width/2,boxY+boxH/2+1);
        c.textBaseline='alphabetic';c.fillStyle='#19d8df';c.font='14px ZX, "Courier New", monospace';
        c.fillText('PRESS SPACE/FIRE TO PLAY AGAIN',g.width/2,318);
      } else {
        c.fillStyle=g.message==='PAUSED' ? '#1eeeee' : '#ef3038';
        c.shadowColor=c.fillStyle;c.shadowBlur=5;
        c.font='30px ZX, "Courier New", monospace';c.fillText(g.message,g.width/2,278);
        if (g.message === 'GAME OVER') {
          c.shadowBlur=2;c.fillStyle='#19d8df';c.font='14px ZX, "Courier New", monospace';
          c.fillText('PRESS SPACE/FIRE TO PLAY AGAIN',g.width/2,312);
        }
      }
      c.restore();
    }
  }

  #drawHelp(text) {
    const c=this.ctx,g=this.game;c.save();c.font='12px "Courier New", monospace';c.fillStyle='rgba(190,255,255,.72)';c.textAlign='center';c.fillText(text,g.width/2,455);c.restore();
  }

  #draw() {
    if (this.gameId === 'alien') this.#alienDraw();
    else if (this.gameId === 'mushroom') this.#mushroomDraw();
    else this.#blockDraw();
  }

  #update(dt) {
    if (this.gameId === 'alien') this.#alienUpdate(dt);
    else if (this.gameId === 'mushroom') this.#mushroomUpdate(dt);
    else this.#blockUpdate(dt);
  }

  // BLOCK BUSTER
  #blockBuildBricks(){const g=this.game;g.bricks=[];const cols=11,rows=4,w=54,h=19,gap=9,total=cols*w+(cols-1)*gap,startX=(g.width-total)/2,rowTypes=['red','green','blue','yellow'],middle=Math.floor(cols/2);for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)g.bricks.push({x:startX+c*(w+gap),y:72+r*(h+gap),w,h,alive:true,type:c===middle?'magenta':rowTypes[r]});}
  #blockResetBall(){const g=this.game;g.ball.x=g.width/2;g.ball.y=g.paddle.y-15;g.ball.vx=210*(Math.random()<.5?-1:1);g.ball.vy=-210;}
  #startGameOverFlash(){if(this.gameOverRaf)cancelAnimationFrame(this.gameOverRaf);const tick=()=>{if(!this.game||this.game.running||this.game.message!=='GAME OVER'){this.gameOverRaf=null;return;}this.#draw();this.gameOverRaf=requestAnimationFrame(tick);};this.gameOverRaf=requestAnimationFrame(tick);}
  #blockRectHit(ball,r){const x=Math.max(r.x,Math.min(ball.x,r.x+r.w)),y=Math.max(r.y,Math.min(ball.y,r.y+r.h)),dx=ball.x-x,dy=ball.y-y;return dx*dx+dy*dy<=ball.r*ball.r;}
  #blockLoseLife(){const g=this.game;this.#emitGameEvent('life-lost');g.lives--;this.#beep('life');if(g.lives<=0){g.running=false;g.message='GAME OVER';this.#emitGameEvent('game-over');this.#beep('gameover');this.#startGameOverFlash();if(this.demoMode){if(this.demoRestartTimer)clearTimeout(this.demoRestartTimer);this.demoRestartTimer=setTimeout(()=>{this.demoRestartTimer=null;if(this.demoMode&&this.gameId==='block')this.start();},1400);}return;}this.#blockResetBall();}
  #blockCompleteLevel(){const g=this.game;g.level++;g.score+=100;this.#beginNextStage(()=>{this.#blockBuildBricks();this.#blockResetBall();});}
  #blockUpdate(dt){const g=this.game,step=dt*this.#speed(),leftWall=36,rightWall=724;let dir=0;if(this.demoMode){const paddleCentre=g.paddle.x+g.paddle.w/2,dead=6;if(g.ball.x<paddleCentre-dead)dir=-1;else if(g.ball.x>paddleCentre+dead)dir=1;}else{if(this.keys.left)dir--;if(this.keys.right)dir++;}g.paddle.x=Math.max(leftWall,Math.min(rightWall-g.paddle.w,g.paddle.x+dir*g.paddle.speed*step));g.ball.x+=g.ball.vx*step;g.ball.y+=g.ball.vy*step;if(g.ball.x-g.ball.r<=leftWall||g.ball.x+g.ball.r>=rightWall){g.ball.vx*=-1;g.ball.x=Math.max(leftWall+g.ball.r,Math.min(rightWall-g.ball.r,g.ball.x));}if(g.ball.y-g.ball.r<=62){g.ball.vy=Math.abs(g.ball.vy);g.ball.y=62+g.ball.r;}if(g.ball.vy>0&&this.#blockRectHit(g.ball,g.paddle)){g.ball.y=g.paddle.y-g.ball.r;g.ball.vy=-Math.abs(g.ball.vy);const hit=(g.ball.x-(g.paddle.x+g.paddle.w/2))/(g.paddle.w/2);g.ball.vx=Math.max(-340,Math.min(340,g.ball.vx+hit*90));this.#beep('paddle');}for(const b of g.bricks){if(!b.alive||!this.#blockRectHit(g.ball,b))continue;b.alive=false;g.ball.vy*=-1;g.score+=10;g.flash=.08;this.#emitGameEvent('colour-event',{colour:b.type});if(b.type!=='magenta'&&!g.bricks.some(other=>other.alive&&other.type===b.type))this.#emitGameEvent('colour-cleared',{colour:b.type});this.#beep('hit');break;}if(g.ball.y-g.ball.r>g.height)this.#blockLoseLife();if(g.bricks.length&&g.bricks.every(b=>!b.alive))this.#blockCompleteLevel();if(g.flash>0)g.flash-=dt;}
  #blockDraw(){const g=this.game,c=this.ctx;this.#drawBase('BLOCK BUSTER');const colours={red:'#ef3038',green:'#2bd34b',blue:'#2457ff',yellow:'#f4e51d',magenta:'#ef34db'};for(const b of g.bricks){if(!b.alive)continue;const x=Math.round(b.x),y=Math.round(b.y);c.fillStyle=colours[b.type];c.fillRect(x,y,b.w,b.h);c.strokeStyle='rgba(0,0,0,.72)';c.lineWidth=1;c.strokeRect(x+.5,y+.5,b.w-1,b.h-1);c.fillStyle='rgba(255,255,255,.16)';c.fillRect(x+2,y+2,b.w-4,2);}c.fillStyle='#dffefe';c.shadowColor='rgba(100,255,255,.65)';c.shadowBlur=5;c.fillRect(Math.round(g.paddle.x),g.paddle.y,g.paddle.w,g.paddle.h);c.fillRect(Math.round(g.ball.x-g.ball.r),Math.round(g.ball.y-g.ball.r),g.ball.r*2,g.ball.r*2);c.shadowBlur=0;this.#drawMessage();}

  // ALIEN ATTACK
  #alienBuildShields(){const g=this.game;g.shields=[];const starts=[72,238,404,570],cellW=8,cellH=6,top=357,pattern=['001111111100','011111111110','011111111110','111111111111','111110011111','111100001111','111000000111'];for(const sx of starts){for(let r=0;r<pattern.length;r++)for(let c=0;c<pattern[r].length;c++)if(pattern[r][c]==='1')g.shields.push({x:sx+c*cellW,y:top+r*cellH,w:cellW-1,h:cellH-1,alive:true});}}
  #alienBuildWave(){const g=this.game;g.aliens=[];const cols=9,rows=4,w=34,h=24,gapX=10,gapY=12,total=cols*w+(cols-1)*gapX,startX=(g.width-total)/2,colours=['#ef3038','#2bd34b','#2457ff','#f4e51d'];for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)g.aliens.push({x:startX+c*(w+gapX),y:92+r*(h+gapY),w,h,alive:true,row:r,col:c,colour:colours[r]});g.alienDir=1;g.alienStepTimer=0;g.ufo.active=false;g.ufo.timer=3.2+Math.random()*4.5;g.bombs=[];g.bombTimer=1.05;this.#alienBuildShields();}
  #alienFire(){const g=this.game;if(!g?.running||g.paused||g.preStart||g.shotCooldown>0||g.bullets.length>=3)return;g.bullets.push({x:g.player.x+g.player.w/2-2,y:g.player.y-10,w:4,h:10});g.shotCooldown=.22;this.#beep('shot');}
  #alienLoseLife(explosionX=null, explosionY=null){const g=this.game;if(explosionX!=null&&explosionY!=null)this.#alienAddExplosion(explosionX,explosionY,'small');this.#emitGameEvent('life-lost');g.lives--;this.#beep('life');if(g.lives<=0){g.running=false;g.message='GAME OVER';this.#emitGameEvent('game-over');this.#beep('gameover');if(this.demoMode){if(this.demoRestartTimer)clearTimeout(this.demoRestartTimer);this.demoRestartTimer=setTimeout(()=>{this.demoRestartTimer=null;if(this.demoMode&&this.gameId==='alien')this.start();},1400);}return;}g.bullets=[];g.bombs=[];g.player.x=(g.width-g.player.w)/2;this.#alienBuildWave();}
  #alienProjectileHitsShield(p){const g=this.game;for(const s of g.shields){if(!s.alive)continue;if(p.x<s.x+s.w&&p.x+p.w>s.x&&p.y<s.y+s.h&&p.y+p.h>s.y){s.alive=false;p.dead=true;return true;}}return false;}
  #alienAddExplosion(x,y,size='small'){const g=this.game;if(!g.explosions)g.explosions=[];g.explosions.push({x,y,size,t:0,d:size==='ufo'?0.5:0.36});}
  #alienSpawnBomb(living){const g=this.game;if(!living.length)return;const maxY=Math.max(...living.map(a=>a.y));const lowest=living.filter(a=>a.y>=maxY-2);const from=lowest[Math.floor(Math.random()*lowest.length)]||living[Math.floor(Math.random()*living.length)];g.bombs.push({x:Math.round(from.x+from.w/2-2),y:Math.round(from.y+from.h+4),w:4,h:10,vy:185+g.level*12});}
  #alienUpdate(dt){const g=this.game,speed=this.#speed(),step=dt*speed;if(g.explosions){g.explosions.forEach(e=>e.t+=dt);g.explosions=g.explosions.filter(e=>e.t<e.d);}let dir=0;if(this.demoMode){const livingNow=g.aliens.filter(a=>a.alive);const target=(g.ufo?.active?g.ufo:(livingNow.length?livingNow.reduce((best,a)=>a.y>best.y?a:best,livingNow[0]):null));if(target){const targetX=target.x+(target.w||0)/2,pX=g.player.x+g.player.w/2;if(targetX<pX-5)dir=-1;else if(targetX>pX+5)dir=1;}if(g.shotCooldown<=0)this.#alienFire();}else{if(this.keys.left)dir--;if(this.keys.right)dir++;}const leftShotLane=60,rightShotLane=678,minPlayerX=leftShotLane-g.player.w/2,maxPlayerX=rightShotLane-g.player.w/2;g.player.x=Math.max(minPlayerX,Math.min(maxPlayerX,g.player.x+dir*g.player.speed*step));g.shotCooldown=Math.max(0,g.shotCooldown-dt*speed);if(!this.demoMode&&this.keys.fire&&g.shotCooldown<=0)this.#alienFire();g.bullets.forEach(b=>b.y-=520*step);g.bullets=g.bullets.filter(b=>!b.dead&&b.y>62);g.bombs.forEach(b=>b.y+=b.vy*step);g.bombs=g.bombs.filter(b=>!b.dead&&b.y<g.player.y+g.player.h);if(g.ufo.active){g.ufo.x+=g.ufo.dir*g.ufo.speed*step;if((g.ufo.dir>0&&g.ufo.x>g.width+g.ufo.w)||(g.ufo.dir<0&&g.ufo.x<-g.ufo.w)){g.ufo.active=false;g.ufo.timer=4+Math.random()*6;}}else{g.ufo.timer-=dt*speed;if(g.ufo.timer<=0){g.ufo.active=true;g.ufo.dir=Math.random()<.5?1:-1;g.ufo.x=g.ufo.dir>0?-g.ufo.w:g.width+g.ufo.w;g.ufo.y=72;g.ufo.speed=145+Math.random()*50;}}let living=g.aliens.filter(a=>a.alive);if(!living.length)return;g.bombTimer-=dt*speed;if(g.bombTimer<=0){this.#alienSpawnBomb(living);const ratio=Math.max(.1,living.length/36);const densityFactor=.65+.35*ratio;g.bombTimer=(Math.max(.32,1.18-g.level*.05)+Math.random()*.55)*densityFactor;}const minX=Math.min(...living.map(a=>a.x)),maxX=Math.max(...living.map(a=>a.x+a.w));g.alienStepTimer-=dt*speed;if(g.alienStepTimer<=0){const drop=(maxX>=g.width-35&&g.alienDir>0)||(minX<=35&&g.alienDir<0);if(drop){g.alienDir*=-1;living.forEach(a=>a.y+=18);}else living.forEach(a=>a.x+=g.alienDir*12);const ratio=Math.max(.08,living.length/36);const killSpeedFactor=.68+.32*ratio;g.alienStepTimer=Math.max(.055,(.34-g.level*.02)*killSpeedFactor);}for(const b of g.bullets){if(this.#alienProjectileHitsShield(b))continue;for(const a of living){if(!a.alive)continue;if(b.x<a.x+a.w&&b.x+b.w>a.x&&b.y<a.y+a.h&&b.y+b.h>a.y){a.alive=false;b.y=-30;g.score+=10*(4-a.row);const rowColours=['red','green','blue','yellow'],hitColour=rowColours[a.row]||'red';this.#emitGameEvent('colour-event',{colour:hitColour});if(!g.aliens.some(other=>other.alive&&other.row===a.row))this.#emitGameEvent('colour-cleared',{colour:hitColour});this.#beep('hit');break;}}if(g.ufo.active&&b.x<g.ufo.x+g.ufo.w&&b.x+b.w>g.ufo.x&&b.y<g.ufo.y+g.ufo.h&&b.y+b.h>g.ufo.y){this.#alienAddExplosion(g.ufo.x+g.ufo.w/2,g.ufo.y+g.ufo.h/2,'ufo');g.ufo.active=false;g.ufo.timer=5+Math.random()*6;b.y=-30;g.score+=75;this.#emitGameEvent('colour-event',{colour:'magenta'});this.#beep('level');}}for(const bomb of g.bombs){if(this.#alienProjectileHitsShield(bomb))continue;if(bomb.x<g.player.x+g.player.w&&bomb.x+bomb.w>g.player.x&&bomb.y<g.player.y+10&&bomb.y+bomb.h>g.player.y-11){this.#alienLoseLife(g.player.x+g.player.w/2,g.player.y+2);return;}}g.bombs=g.bombs.filter(b=>!b.dead);g.bullets=g.bullets.filter(b=>!b.dead);living=g.aliens.filter(a=>a.alive);for(const s of g.shields){if(!s.alive)continue;if(living.some(a=>a.x<s.x+s.w&&a.x+a.w>s.x&&a.y<s.y+s.h&&a.y+a.h>s.y))s.alive=false;}if(living.some(a=>a.y+a.h>=g.player.y-8)){this.#alienLoseLife();return;}if(g.aliens.every(a=>!a.alive)){g.level++;g.score+=100;this.#beginNextStage(()=>this.#alienBuildWave());}}
  #alienDrawSprite(a){const c=this.ctx,x=Math.round(a.x),y=Math.round(a.y),w=a.w;const fill=a.colour;c.fillStyle=fill;if(a.row===0){c.fillRect(x+12,y,10,3);c.fillRect(x+8,y+3,18,4);c.fillRect(x+4,y+7,26,5);c.fillRect(x+2,y+12,6,5);c.fillRect(x+26,y+12,6,5);c.fillRect(x+10,y+12,14,6);c.fillRect(x+6,y+18,4,4);c.fillRect(x+24,y+18,4,4);}else if(a.row===1){c.fillRect(x+8,y,6,4);c.fillRect(x+20,y,6,4);c.fillRect(x+4,y+4,26,5);c.fillRect(x+2,y+9,30,5);c.fillRect(x+8,y+14,18,4);c.fillRect(x+5,y+18,4,4);c.fillRect(x+25,y+18,4,4);c.fillRect(x+13,y+18,3,4);c.fillRect(x+18,y+18,3,4);}else if(a.row===2){c.fillRect(x+6,y,6,4);c.fillRect(x+22,y,6,4);c.fillRect(x+3,y+4,28,5);c.fillRect(x+7,y+9,20,5);c.fillRect(x+1,y+14,7,5);c.fillRect(x+26,y+14,7,5);c.fillRect(x+10,y+14,14,6);c.fillRect(x+5,y+19,4,3);c.fillRect(x+25,y+19,4,3);}else{c.fillRect(x+9,y,5,4);c.fillRect(x+20,y,5,4);c.fillRect(x+5,y+4,24,5);c.fillRect(x+2,y+9,9,5);c.fillRect(x+23,y+9,9,5);c.fillRect(x+10,y+9,14,7);c.fillRect(x+6,y+16,4,5);c.fillRect(x+24,y+16,4,5);c.fillRect(x+14,y+16,3,5);c.fillRect(x+18,y+16,3,5);}c.fillStyle='#06100e';c.fillRect(x+12,y+8,3,3);c.fillRect(x+19,y+8,3,3);c.fillStyle='rgba(255,255,255,.18)';c.fillRect(x+10,y+3,14,2);}
  #alienDraw(){const g=this.game,c=this.ctx;this.#drawBase('ALIEN ATTACK');for(const a of g.aliens){if(!a.alive)continue;this.#alienDrawSprite(a);}if(g.ufo.active){const x=Math.round(g.ufo.x),y=g.ufo.y,w=g.ufo.w,h=g.ufo.h;c.fillStyle='#ef34db';c.fillRect(x+12,y,w-24,3);c.fillRect(x+8,y+3,w-16,4);c.fillRect(x+4,y+7,w-8,5);c.fillRect(x,y+12,w,4);c.fillStyle='#06100e';for(let i=0;i<5;i++)c.fillRect(x+10+i*8,y+8,4,2);c.fillStyle='rgba(255,255,255,.18)';c.fillRect(x+14,y+4,w-28,2);}for(const s of g.shields){if(!s.alive)continue;c.fillStyle='#39d8e6';c.fillRect(s.x,s.y,s.w,s.h);}c.fillStyle='#f4e51d';g.bombs.forEach(b=>{const bx=Math.round(b.x),by=Math.round(b.y);c.fillRect(bx,by,b.w,b.h);c.fillRect(bx-1,by+2,b.w+2,2);c.fillRect(bx,by+6,b.w,b.h-6);});c.fillStyle='#dffefe';c.shadowColor='rgba(100,255,255,.65)';c.shadowBlur=5;const px=Math.round(g.player.x),py=g.player.y,pw=g.player.w;c.fillRect(px+10,py,pw-20,4);c.fillRect(px+6,py+4,pw-12,4);c.fillRect(px+18,py-5,pw-36,5);g.bullets.forEach(b=>c.fillRect(Math.round(b.x),Math.round(b.y),b.w,b.h));c.shadowBlur=0;if(g.explosions){for(const e of g.explosions){const p=Math.min(1,e.t/e.d),r=(e.size==='ufo'?18:11)*(0.55+p*0.9),x=e.x,y=e.y;c.fillStyle=p<0.5?'#f4e51d':'#ef3038';c.fillRect(Math.round(x-r/2),Math.round(y-2),Math.round(r),4);c.fillRect(Math.round(x-2),Math.round(y-r/2),4,Math.round(r));c.fillStyle='#f4e51d';c.fillRect(Math.round(x-r*0.35),Math.round(y-r*0.35),4,4);c.fillRect(Math.round(x+r*0.35)-4,Math.round(y-r*0.35),4,4);c.fillRect(Math.round(x-r*0.35),Math.round(y+r*0.35)-4,4,4);c.fillRect(Math.round(x+r*0.35)-4,Math.round(y+r*0.35)-4,4,4);}}this.#drawMessage();}

  // MUSHROOM RUN
  #mushroomGeom(){return{x0:28,y0:66,cellW:22,cellH:18,cols:32,rows:22,playerZoneTop:17,playerZoneBottom:21};}
  #mushroomCell(col,row){const g=this.#mushroomGeom();return{x:g.x0+col*g.cellW,y:g.y0+row*g.cellH,w:g.cellW,h:g.cellH};}
  #mushroomPlayerZoneBounds(){const m=this.#mushroomGeom();return{left:m.x0,right:m.x0+m.cols*m.cellW,top:m.y0+m.playerZoneTop*m.cellH,bottom:438};}
  #mushroomFindAt(col,row){return this.game.mushrooms.find(m=>m.col===col&&m.row===row) || null;}
  #mushroomAdd(col,row,hp=4,poison=false){const geom=this.#mushroomGeom();if(col<0||col>=geom.cols||row<0||row>=geom.rows)return;let m=this.#mushroomFindAt(col,row);if(m){m.hp=Math.max(m.hp,hp);m.poison=poison?true:m.poison;return m;}m={col,row,hp,poison};this.game.mushrooms.push(m);return m;}
  #mushroomRemove(m){this.game.mushrooms=this.game.mushrooms.filter(x=>x!==m);}
  #mushroomBuildLevel(resetField=false){const g=this.game,geom=this.#mushroomGeom();g.bullet=null;g.centipedes=[];g.spider=null;g.scorpion=null;g.moveTimer=0;g.spiderTimer=Math.max(6.5,12.5-(g.level-1)*0.45)+Math.random()*3;g.scorpionTimer=Math.max(8,18-(g.level-1)*0.65)+Math.random()*4;if(resetField){g.mushrooms=[];for(let row=2;row<16;row++){for(let col=1;col<31;col++){if(Math.random()<0.10 && !(row<4 && col<8)){this.#mushroomAdd(col,row,4,false);}}}}const baseLen=Math.max(6,10-(g.level-1));const main=[],bodyColours=['red','green','blue','yellow'];for(let i=0;i<baseLen;i++)main.push({col:baseLen-1-i,row:0,colour:i===0?'magenta':bodyColours[(i-1)%4]});g.centipedes.push({segments:main,dir:1,plunge:false});const extraHeads=Math.floor((g.level-1)/2);for(let i=0;i<extraHeads;i++){const row=(i%3)*2;const col=Math.min(geom.cols-2,10+i*6);g.centipedes.push({segments:[{col,row,colour:'magenta'}],dir:i%2===0?1:-1,plunge:false});}g.player.x=(g.width-g.player.w)/2;g.player.y=414;}
  #mushroomFire(){const g=this.game;if(!g?.running||g.paused||g.preStart||g.shotCooldown>0||g.bullet)return;g.bullet={x:g.player.x+g.player.w/2-2,y:g.player.y-10,w:4,h:10};g.shotCooldown=.14;this.#beep('shot');}
  #mushroomRepairMushrooms(){const g=this.game;let repaired=0;for(const m of g.mushrooms){if(m.hp<4||m.poison){repaired++;m.hp=4;m.poison=false;}}if(repaired)g.score+=repaired*5;}
  #mushroomLoseLife(){const g=this.game;this.#emitGameEvent('life-lost');g.lives--;this.#beep('life');if(g.lives<=0){g.running=false;g.message='GAME OVER';this.#emitGameEvent('game-over');this.#beep('gameover');if(this.demoMode){if(this.demoRestartTimer)clearTimeout(this.demoRestartTimer);this.demoRestartTimer=setTimeout(()=>{this.demoRestartTimer=null;if(this.demoMode&&this.gameId==='mushroom')this.start();},1400);}return;}this.#mushroomRepairMushrooms();this.#mushroomBuildLevel(false);}
  #mushroomSegmentHit(chainIndex,segIndex){const g=this.game,chain=g.centipedes[chainIndex];if(!chain)return;const hit=chain.segments[segIndex];if(!hit)return;const hitColour=hit.colour||'magenta',score=hitColour==='magenta'?100:10;g.score+=score;this.#emitGameEvent('colour-event',{colour:hitColour});this.#mushroomAdd(hit.col,hit.row,4,false);const leading=chain.segments.slice(0,segIndex);const trailing=chain.segments.slice(segIndex+1);const replacements=[];if(leading.length)replacements.push({segments:leading,dir:chain.dir,plunge:false});if(trailing.length)replacements.push({segments:trailing,dir:chain.dir,plunge:false});g.centipedes.splice(chainIndex,1,...replacements);if(hitColour!=='magenta'&&!g.centipedes.some(c=>c.segments.some(seg=>seg.colour===hitColour)))this.#emitGameEvent('colour-cleared',{colour:hitColour});this.#beep('hit');}
  #mushroomShotRectHit(b,x,y,w,h){return b&&b.x<x+w&&b.x+b.w>x&&b.y<y+h&&b.y+b.h>y;}
  #mushroomSpawnSpider(){const g=this.game,b=this.#mushroomPlayerZoneBounds();const fromLeft=Math.random()<0.5;g.spider={x:fromLeft?b.left+8:b.right-28,y:b.top+10+Math.random()*(b.bottom-b.top-42),w:24,h:15,vx:(fromLeft?1:-1)*(85+Math.random()*35),vy:(Math.random()<0.5?-1:1)*(55+Math.random()*30)};}
  #mushroomSpawnScorpion(){const g=this.game,geom=this.#mushroomGeom();const row=5+Math.floor(Math.random()*7);const fromLeft=Math.random()<0.5;g.scorpion={row,x:fromLeft?geom.x0-30:geom.x0+geom.cols*geom.cellW+4,y:geom.y0+row*geom.cellH+2,w:28,h:13,vx:fromLeft?125:-125};}
  #mushroomUpdateCentipedes(dt){const g=this.game,geom=this.#mushroomGeom();g.moveTimer-=dt*this.#speed();if(g.moveTimer>0)return;g.moveTimer=Math.max(.042,.185-(g.level-1)*.012);for(const chain of g.centipedes){if(!chain.segments.length)continue;const prev=chain.segments.map(s=>({...s}));const head={...chain.segments[0]};let next={...head};if(chain.plunge){next.row=Math.min(geom.rows-1,head.row+1);if(next.row>=geom.playerZoneBottom)chain.plunge=false;}else{const targetCol=head.col+chain.dir;const obstacle=targetCol<0||targetCol>=geom.cols||this.#mushroomFindAt(targetCol,head.row);if(obstacle){const hitM=targetCol<0||targetCol>=geom.cols?null:this.#mushroomFindAt(targetCol,head.row);next.row=Math.min(geom.rows-1,head.row+1);if(hitM?.poison){chain.plunge=true;}else{chain.dir*=-1;}}else{next.col=targetCol;}}chain.segments[0]=next;for(let i=1;i<chain.segments.length;i++)chain.segments[i]=prev[i-1];if(chain.segments.some(s=>{const r=this.#mushroomCell(s.col,s.row);return r.y+r.h>=g.player.y && r.x<g.player.x+g.player.w && r.x+r.w>g.player.x;})){this.#mushroomLoseLife();return false;}}return true;}
  #mushroomUpdate(dt){const g=this.game,speed=this.#speed(),step=dt*speed,zone=this.#mushroomPlayerZoneBounds(),geom=this.#mushroomGeom();let dx=0,dy=0;if(this.demoMode){let target=null;for(const chain of g.centipedes){if(chain.segments?.length){const head=chain.segments[0],r=this.#mushroomCell(head.col,head.row);if(!target||r.y>target.y)target={x:r.x+r.w/2,y:r.y+r.h/2};}}if(g.spider&&(!target||g.spider.y>target.y))target={x:g.spider.x+g.spider.w/2,y:g.spider.y+g.spider.h/2};if(target){const px=g.player.x+g.player.w/2,py=g.player.y+g.player.h/2;if(target.x<px-5)dx=-1;else if(target.x>px+5)dx=1;if(target.y>zone.top&&target.y<zone.bottom){if(target.y<py-20)dy=-1;else if(target.y>py+20)dy=1;}}if(g.bullet==null&&g.shotCooldown<=0)this.#mushroomFire();}else{dx=(this.keys.right?1:0)-(this.keys.left?1:0);dy=(this.keys.down?1:0)-(this.keys.up?1:0);}if(dx&&dy){dx*=0.7071;dy*=0.7071;}g.player.x=Math.max(zone.left,Math.min(zone.right-g.player.w,g.player.x+dx*g.player.speed*step));g.player.y=Math.max(zone.top,Math.min(zone.bottom-g.player.h,g.player.y+dy*g.player.speed*step));g.shotCooldown=Math.max(0,g.shotCooldown-dt*speed);if(!this.demoMode&&this.keys.fire&&g.shotCooldown<=0)this.#mushroomFire();if(g.bullet){g.bullet.y-=420*step;if(g.bullet.y<-20)g.bullet=null;}if(g.bullet){const b=g.bullet;let hit=false;for(let ci=0;ci<g.centipedes.length&&!hit;ci++){const chain=g.centipedes[ci];for(let si=0;si<chain.segments.length;si++){const s=chain.segments[si],r=this.#mushroomCell(s.col,s.row);if(this.#mushroomShotRectHit(b,r.x+2,r.y+2,18,14)){this.#mushroomSegmentHit(ci,si);g.bullet=null;hit=true;break;}}}if(!hit && g.spider && this.#mushroomShotRectHit(b,g.spider.x,g.spider.y,g.spider.w,g.spider.h)){const dist=Math.abs((g.spider.y+g.spider.h/2)-(g.player.y+g.player.h/2));g.score+=dist<24?900:dist<54?600:300;g.spider=null;g.bullet=null;this.#emitGameEvent('special-enemy-killed',{enemy:'spider'});this.#beep('level');hit=true;}if(!hit && g.scorpion && this.#mushroomShotRectHit(b,g.scorpion.x,g.scorpion.y,g.scorpion.w,g.scorpion.h)){g.score+=1000;g.scorpion=null;g.bullet=null;this.#emitGameEvent('special-enemy-killed',{enemy:'scorpion'});this.#beep('level');hit=true;}if(!hit){for(const m of [...g.mushrooms]){const r=this.#mushroomCell(m.col,m.row);if(this.#mushroomShotRectHit(b,r.x+4,r.y+1,14,15)){m.hp--;g.bullet=null;if(m.hp<=0){this.#mushroomRemove(m);g.score+=1;}this.#beep('hit');hit=true;break;}}}}
    g.spiderTimer-=dt*speed;if(!g.spider && g.spiderTimer<=0){this.#mushroomSpawnSpider();g.spiderTimer=Math.max(5.5,13-(g.level-1)*0.5)+Math.random()*4;}
    if(g.spider){g.spider.x+=g.spider.vx*step;g.spider.y+=g.spider.vy*step;if(g.spider.x<zone.left||g.spider.x+g.spider.w>zone.right){g.spider.vx*=-1;g.spider.x=Math.max(zone.left,Math.min(zone.right-g.spider.w,g.spider.x));}if(g.spider.y<zone.top||g.spider.y+g.spider.h>zone.bottom){g.spider.vy*=-1;g.spider.y=Math.max(zone.top,Math.min(zone.bottom-g.spider.h,g.spider.y));}for(const m of [...g.mushrooms]){const r=this.#mushroomCell(m.col,m.row);if(r.x<g.spider.x+g.spider.w&&r.x+r.w>g.spider.x&&r.y<g.spider.y+g.spider.h&&r.y+r.h>g.spider.y){this.#mushroomRemove(m);break;}}if(g.spider.x<g.player.x+g.player.w&&g.spider.x+g.spider.w>g.player.x&&g.spider.y<g.player.y+g.player.h&&g.spider.y+g.spider.h>g.player.y){this.#mushroomLoseLife();return;}}
    g.scorpionTimer-=dt*speed;if(!g.scorpion && g.scorpionTimer<=0){this.#mushroomSpawnScorpion();g.scorpionTimer=Math.max(7.5,18-(g.level-1)*0.65)+Math.random()*5;}
    if(g.scorpion){g.scorpion.x+=g.scorpion.vx*step;const col=Math.floor((g.scorpion.x-geom.x0)/geom.cellW);const hit=this.#mushroomFindAt(col,g.scorpion.row);if(hit)hit.poison=true;if(g.scorpion.x>geom.x0+geom.cols*geom.cellW+34||g.scorpion.x<geom.x0-40)g.scorpion=null;else if(g.scorpion.x<g.player.x+g.player.w&&g.scorpion.x+g.scorpion.w>g.player.x&&g.scorpion.y<g.player.y+g.player.h&&g.scorpion.y+g.scorpion.h>g.player.y){this.#mushroomLoseLife();return;}}
    if(this.#mushroomUpdateCentipedes(dt)===false)return;
    g.centipedes=g.centipedes.filter(c=>c.segments.length);
    if(!g.centipedes.length){g.level++;g.score+=100;this.#beginNextStage(()=>this.#mushroomBuildLevel(false));}
  }
  #mushroomDrawMushroom(m,index){const c=this.ctx,r=this.#mushroomCell(m.col,m.row);const damage=['#ffffff','#e2e2e2','#c2c2c2','#9a9a9a'];const cap=m.poison?'#ef34db':damage[Math.max(0,4-m.hp)%4];const stem=m.poison?'#f4e51d':cap;c.fillStyle=cap;c.fillRect(r.x+5,r.y+4,12,3);c.fillRect(r.x+3,r.y+7,16,5);c.fillStyle=stem;c.fillRect(r.x+8,r.y+11,6,6);if(!m.poison){c.fillStyle='#06100e';c.fillRect(r.x+6,r.y+8,2,2);c.fillRect(r.x+14,r.y+8,2,2);}else{c.fillStyle='#06100e';c.fillRect(r.x+9,r.y+7,4,2);}}
  #mushroomDrawCentipede(chain){const c=this.ctx,colourMap={magenta:'#ef34db',red:'#ef3038',green:'#2bd34b',blue:'#2457ff',yellow:'#f4e51d'};chain.segments.forEach((s,i)=>{const r=this.#mushroomCell(s.col,s.row),col=colourMap[s.colour]||'#f4e51d';c.fillStyle=col;if(i===0){c.fillRect(r.x+4,r.y+4,14,5);c.fillRect(r.x+2,r.y+9,18,5);c.fillRect(r.x+5,r.y+14,4,3);c.fillRect(r.x+13,r.y+14,4,3);c.fillStyle='#06100e';c.fillRect(r.x+7,r.y+7,2,2);c.fillRect(r.x+13,r.y+7,2,2);}else{c.fillRect(r.x+4,r.y+5,14,5);c.fillRect(r.x+2,r.y+10,18,4);c.fillRect(r.x+5,r.y+14,3,3);c.fillRect(r.x+14,r.y+14,3,3);c.fillStyle='rgba(255,255,255,.18)';c.fillRect(r.x+6,r.y+6,10,2);}});}
  #mushroomDraw(){const g=this.game,c=this.ctx;this.#drawBase('MUSHROOM RUN');for(let i=0;i<g.mushrooms.length;i++)this.#mushroomDrawMushroom(g.mushrooms[i],i);for(const chain of g.centipedes)this.#mushroomDrawCentipede(chain);if(g.scorpion){const x=Math.round(g.scorpion.x),y=Math.round(g.scorpion.y);c.fillStyle='#ef34db';c.fillRect(x+5,y+4,15,6);c.fillRect(x+1,y+6,6,4);c.fillRect(x+20,y+5,5,4);c.fillRect(x+23,y+2,4,5);c.fillRect(x+25,y,3,3);c.fillRect(x+3,y+10,4,2);c.fillRect(x+12,y+10,4,2);c.fillStyle='#f4e51d';c.fillRect(x+1,y+2,4,3);c.fillRect(x+20,y+9,4,3);c.fillStyle='#06100e';c.fillRect(x+8,y+5,2,2);}if(g.spider){const x=Math.round(g.spider.x),y=Math.round(g.spider.y);c.fillStyle='#ef3038';c.fillRect(x+7,y+4,10,7);c.fillRect(x+4,y+6,16,4);c.fillRect(x+1,y+2,5,2);c.fillRect(x+18,y+2,5,2);c.fillRect(x,y+12,6,2);c.fillRect(x+18,y+12,6,2);c.fillRect(x+2,y+8,4,2);c.fillRect(x+18,y+8,4,2);c.fillStyle='#06100e';c.fillRect(x+9,y+6,2,2);c.fillRect(x+13,y+6,2,2);}c.fillStyle='#dffefe';const px=Math.round(g.player.x),py=Math.round(g.player.y),pw=g.player.w;c.fillRect(px+5,py+5,pw-10,5);c.fillRect(px+2,py+8,pw-4,3);c.fillRect(px+12,py,pw-24,5);if(g.bullet)c.fillRect(Math.round(g.bullet.x),Math.round(g.bullet.y),g.bullet.w,g.bullet.h);this.#drawMessage();}
}
