import { CRTSystem } from "./CRTSystem.js";
import { getPerformanceMode, getPerformanceProfile, togglePerformanceMode } from "../perf/PerformanceProfile.js";
export class MachineView {
  constructor({ store, controller }) {
    this.store = store;
    this.controller = controller;
    this.osdTimer = null;
    this.futureMessageTimer = null;
    this.ssFlashTimer = null;
    this.lastSoundscapeId = null;
    this.sleepTimer = { optionLabel: 'OFF', durationMs: 0, remainingMs: 0, running: false, paused: false, interval: null, lastTickAt: 0, menuOpen: false, expiring: false };
    this.wakeLock = null;
    this.lastTimerDisplayText = null;
    this.lastTimerOptionLabel = null;
    this.#buildSmallLevels();
    this.crt = new CRTSystem({ store, controller, root: document.querySelector('#crt-screen-root') });
    this.#bind();
    this.renderFrame = null;
    this.renderTimer = null;
    this.lastVisualRenderAt = 0;
    this.pendingRenderState = null;
    this.pendingRenderMeta = null;
    this.unsubscribe = store.subscribe((state, meta) => {
      if (meta?.reason === 'initial') this.render(state, meta);
      else this.#scheduleRender(state, meta);
    });
    this.#fitStage();
    window.addEventListener('resize', () => this.#fitStage());
  }

  #scheduleRender(state, meta) {
    this.pendingRenderState = state;
    this.pendingRenderMeta = meta;
    const reason=String(meta?.reason||'');
    const automationVisual=/^(automix-|special-event-|fxmod-frame)/.test(reason);
    const liveControl=/^(track-(volume|pan|filter)|effect-|character-|intensity|master-(tone|brightness)|game-volume|main-volume)/.test(reason);
    const perf=getPerformanceProfile();
    const minGap=automationVisual?perf.automationVisualMs:(liveControl?perf.liveControlMs:0);
    const elapsed=performance.now()-this.lastVisualRenderAt;
    const run=()=>{
      this.renderFrame=null;
      if(this.renderTimer){clearTimeout(this.renderTimer);this.renderTimer=null;}
      const nextState=this.pendingRenderState;
      const nextMeta=this.pendingRenderMeta;
      this.pendingRenderState=null;this.pendingRenderMeta=null;
      if(nextState){this.lastVisualRenderAt=performance.now();this.render(nextState,nextMeta||{revision:this.store.revision});}
    };
    if(minGap>0 && elapsed<minGap){
      if(!this.renderTimer) this.renderTimer=setTimeout(run,Math.max(0,minGap-elapsed));
      return;
    }
    if(this.renderFrame||this.renderTimer)return;
    this.renderFrame=requestAnimationFrame(run);
  }

  #buildSmallLevels() {
    const root = document.querySelector('#small-levels');
    root.innerHTML = '';
    for (let i=0;i<4;i++) {
      const row = document.createElement('div');
      row.className = 'small-row';
      const label = document.createElement('span'); label.textContent = `CH${i+1}`;
      const bar = document.createElement('div'); bar.className = 'small-bar'; bar.dataset.index = String(i);
      for (let s=0;s<16;s++) bar.append(document.createElement('i'));
      const value = document.createElement('span'); value.className='small-value'; value.textContent='0';
      row.append(label,bar,value); root.append(row);
      this.#bindSmallLevelBar(bar, i);
    }
  }

  #bind() {
    const requestWake=()=>this.#requestWakeLock();
    window.addEventListener('pointerdown', requestWake, {once:true, capture:true});
    document.addEventListener('visibilitychange',()=>{ if(!document.hidden)this.#requestWakeLock(); });
    document.querySelectorAll('[data-soundscape]').forEach(btn => btn.addEventListener('click', () => this.controller.selectSoundscape(btn.dataset.soundscape)));
    document.querySelector('#play-button').addEventListener('click', () => { this.controller.play(); this.crt.startGame(); });
    document.querySelector('#pause-button').addEventListener('click', () => {
      const status = this.store.getState().transport.status;
      if (status === 'paused') {
        this.controller.play({ startupRateRampSeconds: 0 });
        this.crt.startGame();
      } else if (status === 'playing') {
        this.controller.pause();
        this.crt.pauseGame();
      }
    });
    document.querySelector('#stop-button').addEventListener('click', () => { this.controller.stop(); this.crt.stopGame(); });
    document.querySelector('#space-key').addEventListener('click', () => { if (this.crt.currentScreen==='user-guides') this.crt.openSelectedGuide(); else if (this.crt.currentScreen==='game-placeholder') this.crt.launchSelectedGame(); else this.#togglePlayPause(); });
    document.querySelector('#master-mute-button').addEventListener('click', () => {
      this.controller.toggleMasterMute();
      const muted = Boolean(this.store.getState().master.muted);
      this.#showOsd('MUTE', muted ? 'ON' : 'OFF');
    });

    document.querySelectorAll('[data-effect-button]').forEach(btn => btn.addEventListener('click', () => this.controller.toggleEffect(btn.dataset.effectButton)));
    document.querySelectorAll('[data-frs]').forEach(btn => btn.addEventListener('click', () => this.controller.setFRS(btn.dataset.frs)));
    document.querySelector('#intensity').addEventListener('input', e => this.controller.setIntensity(Number(e.target.value)/50));

    document.querySelectorAll('[data-rocker]').forEach(btn => this.#bindRocker(btn));
    document.querySelectorAll('[data-future]').forEach(btn => btn.addEventListener('click', () => {
      if (this.crt.currentScreen==='user-guides' && !this.crt.guideId) {
        if (btn.classList.contains('z-key')) { this.crt.moveGuideSelection(-1); return; }
        if (btn.classList.contains('x-key')) { this.crt.moveGuideSelection(1); return; }
      }
      if (this.crt.currentScreen==='game-placeholder') {
        if (!this.crt.gameLaunchId) {
          if (btn.classList.contains('z-key')) { this.crt.moveGameSelection(-1); return; }
          if (btn.classList.contains('x-key')) { this.crt.moveGameSelection(1); return; }
        } else {
          return;
        }
      }
      this.#showFuture(btn.dataset.future);
    }));
    document.querySelector('#byd-button').addEventListener('click', () => this.crt.openGameAwareSecondary('byd'));
    document.querySelector('#cc-button').addEventListener('click', () => this.crt.openGameAwareSecondary('control-centre'));
    document.querySelector('#guides-button').addEventListener('click', () => this.crt.openGameAwareSecondary('user-guides'));
    document.querySelector('#tv-button').addEventListener('click', () => this.crt.handlePhysicalTVButton());
    document.querySelector('#game-button').addEventListener('click', () => this.crt.handlePhysicalGameButton());
    this.#bindSleepTimer();

    document.querySelector('#automix-toggle').addEventListener('click', () => this.controller.toggleAutoMix());
    document.querySelector('#small-automix').addEventListener('click', () => this.controller.toggleAutoMix());
    document.querySelector('#small-ramp').addEventListener('click', () => this.controller.toggleRamp());
    document.querySelector('#automix-force').addEventListener('click', () => this.controller.forceAutoMixEvent());
    document.querySelector('#special-event-force').addEventListener('click', () => this.controller.triggerSpecialEvent());

    this.performanceModeButton=document.querySelector('#performance-mode-button');
    const syncPerformanceButton=()=>{
      if(!this.performanceModeButton)return;
      const mode=getPerformanceMode();
      this.performanceModeButton.textContent=`PERF: ${mode.toUpperCase()}`;
      this.performanceModeButton.setAttribute('aria-pressed',String(mode==='smooth'));
      this.performanceModeButton.dataset.mode=mode;
    };
    syncPerformanceButton();
    this.performanceModeButton?.addEventListener('click',()=>{togglePerformanceMode();syncPerformanceButton();});
    window.addEventListener('d8m4-performance-mode',syncPerformanceButton);

    const bindGameDirection = (selector, key) => {
      const btn=document.querySelector(selector);
      if (!btn) return;
      const down=(e)=>{ if(this.crt.currentScreen==='game-placeholder'&&this.crt.gameLaunchId){ e.preventDefault(); this.crt.setGameKey(key,true); btn.classList.add('pressed'); }};
      const up=(e)=>{ if(this.crt.setGameKey(key,false)){ e.preventDefault(); btn.classList.remove('pressed'); }};
      btn.addEventListener('pointerdown',down);
      ['pointerup','pointercancel','pointerleave','lostpointercapture'].forEach(type=>btn.addEventListener(type,up));
    };
    bindGameDirection('.z-key','left');
    bindGameDirection('.x-key','right');

    window.addEventListener('keydown', e => {
      const gameKeyMap={KeyZ:'left',KeyX:'right',ArrowUp:'up',ArrowDown:'down'};
      if (this.crt.currentScreen==='game-placeholder' && this.crt.gameLaunchId && gameKeyMap[e.code]) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault(); e.stopImmediatePropagation();
        this.crt.setGameKey(gameKeyMap[e.code],true);
        return;
      }
      if ((e.code !== 'Space' && e.key !== ' ') || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t=e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || t.tagName==='TEXTAREA' || (t.tagName==='INPUT' && t.getAttribute('type')!=='range'))) return;
      e.preventDefault(); if (this.crt.currentScreen==='user-guides') this.crt.openSelectedGuide(); else if (this.crt.currentScreen==='game-placeholder') this.crt.launchSelectedGame(); else this.#togglePlayPause();
    }, true);
    window.addEventListener('keyup', e => {
      if (this.crt.currentScreen!=='game-placeholder' || !this.crt.gameLaunchId) return;
      const gameKeyMap={KeyZ:'left',KeyX:'right',ArrowUp:'up',ArrowDown:'down'};
      if (gameKeyMap[e.code]) { e.preventDefault(); this.crt.setGameKey(gameKeyMap[e.code],false); }
    }, true);
  }

  async #requestWakeLock() {
    if (document.hidden || this.wakeLock || !('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release',()=>{ this.wakeLock=null; });
    } catch {}
  }

  #togglePlayPause() {
    if (this.store.getState().transport.status === 'playing') this.controller.pause();
    else this.controller.play();
  }


  #bindSmallLevelBar(bar, index) {
    let dragging = false;
    const apply = (event) => {
      const rect = bar.getBoundingClientRect();
      const raw = (event.clientX - rect.left) / rect.width;
      const clamped = Math.max(0, Math.min(1, raw));
      this.controller.setTrackVolume(index, clamped);
    };
    const stop = (event) => {
      dragging = false;
      try { bar.releasePointerCapture?.(event.pointerId); } catch {}
    };
    bar.addEventListener('pointerdown', (event) => {
      dragging = true;
      bar.setPointerCapture?.(event.pointerId);
      apply(event);
    });
    bar.addEventListener('pointermove', (event) => {
      if (dragging) apply(event);
    });
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
    bar.addEventListener('lostpointercapture', () => { dragging = false; });
  }

  #bindRocker(btn) {
    let repeatTimer=null, delayTimer=null;
    const stop=()=>{ clearTimeout(delayTimer); clearInterval(repeatTimer); delayTimer=repeatTimer=null; };
    const apply=(event)=>{
      const rect=btn.getBoundingClientRect();
      const direction=(event.clientY - rect.top) < rect.height/2 ? 1 : -1;
      this.#stepRocker(btn.dataset.rocker, direction);
    };
    const release=()=>{
      btn.classList.remove('rocker-up','rocker-down');
      stop();
    };
    btn.addEventListener('pointerdown', e=>{
      e.preventDefault(); btn.setPointerCapture?.(e.pointerId);
      const rect=btn.getBoundingClientRect(); const direction=(e.clientY-rect.top)<rect.height/2?1:-1;
      btn.classList.toggle('rocker-up', direction>0);
      btn.classList.toggle('rocker-down', direction<0);
      apply(e);
      delayTimer=setTimeout(()=>{ repeatTimer=setInterval(()=>this.#stepRocker(btn.dataset.rocker,direction),140); },400);
    });
    btn.addEventListener('pointerup', release); btn.addEventListener('pointercancel', release); btn.addEventListener('lostpointercapture', release);
  }

  #stepRocker(kind, direction) {
    const s=this.store.getState();
    if (kind==='brightness') {
      const next=Math.max(.15,Math.min(1,s.master.brightness + direction*.05));
      this.controller.setBrightness(next); this.#showOsd('BRIGHTNESS', Math.round(next*100));
    } else if (kind==='tone') {
      const next=Math.max(-1,Math.min(1,s.master.tone + direction*.08));
      this.controller.setMasterTone(next); this.#showToneOsd(Math.round(next*100));
    } else if (kind==='gameVolume') {
      const next=Math.max(0,Math.min(1,s.auxiliary.gameVolume + direction*.05));
      this.controller.setGameVolume(next); this.#showOsd('GAME VOL', Math.round(next*100));
    } else if (kind==='mainVolume') {
      const next=Math.max(0,Math.min(1,s.master.volume + direction*.05));
      this.controller.setMainVolume(next); this.#showOsd('MAIN VOL', Math.round(next*100));
    }
  }

  #getOsdParts(){
    const osd=document.querySelector('#osd');
    if(!osd)return null;
    if(!osd.querySelector('.osd-label')){
      osd.innerHTML='<span class="osd-label"></span><span class="osd-meter"></span><span class="osd-value"></span>';
    }
    return {osd,label:osd.querySelector('.osd-label'),meter:osd.querySelector('.osd-meter'),value:osd.querySelector('.osd-value')};
  }

  #showOsd(label, value, bipolar=false) {
    const parts=this.#getOsdParts(); if(!parts)return;
    const numeric=Number(value), isNumeric=Number.isFinite(numeric);
    const count=isNumeric?(bipolar?Math.round(Math.abs(numeric)/5):Math.round(numeric/5)):0;
    const bars=isNumeric?'|'.repeat(Math.max(0,Math.min(20,count))):'';
    const display=isNumeric?(bipolar?`${numeric>0?'+':''}${numeric}`:`${numeric}`):String(value);
    parts.label.textContent=label; parts.meter.textContent=bars; parts.value.textContent=display;
    parts.osd.classList.add('show'); clearTimeout(this.osdTimer); this.osdTimer=setTimeout(()=>parts.osd.classList.remove('show'),1800);
  }

  #showToneOsd(value){
    const parts=this.#getOsdParts(); if(!parts)return;
    const numeric=Math.max(-100,Math.min(100,Number(value)||0));
    const width=21, centre=10, pos=Math.max(0,Math.min(width-1,Math.round(((numeric+100)/200)*(width-1))));
    const chars=Array(width).fill('-'); chars[centre]='+'; chars[pos]='I';
    parts.label.textContent='BASS'; parts.meter.textContent=chars.join(''); parts.value.textContent=`TREB ${numeric>0?'+':''}${numeric}`;
    parts.osd.classList.add('show'); clearTimeout(this.osdTimer); this.osdTimer=setTimeout(()=>parts.osd.classList.remove('show'),1800);
  }


  #showSSFlash(id) {
    const flash = document.querySelector('#ss-flash');
    if (!flash) return;
    flash.textContent = id.slice(2);
    flash.classList.add('show');
    clearTimeout(this.ssFlashTimer);
    this.ssFlashTimer = setTimeout(() => flash.classList.remove('show'), 1800);
  }

  #showFuture(name) {
    const msg=document.querySelector('#crt-message');
    clearTimeout(this.futureMessageTimer);
    msg.textContent=`${name} · CHECKPOINT 6/7`;
    this.futureMessageTimer=setTimeout(()=>this.#updateCrtMessage(this.store.getState()),1800);
  }

  #updateCrtMessage(state) {
    const msg=document.querySelector('#crt-message');
    if (state.soundscape.loading) msg.textContent=`LOADING ${state.soundscape.id}...`;
    else if (state.transport.status==='playing') msg.textContent=`AUTO MIX ${state.autoMix.enabled?'ON':'OFF'} · ${state.frs.toUpperCase()} · INTENSITY ${Math.round(state.intensity*50)}%`;
    else if (state.transport.status==='paused') msg.textContent='PAUSED · PRESS PLAY OR SPACE TO RESUME';
    else msg.textContent='PRESS PLAY TO START';
  }


  #bindSleepTimer() {
    this.timerDisplay = document.querySelector('#timer-display');
    this.timerSetButton = document.querySelector('#timer-set-button');
    this.timerStartButton = document.querySelector('#timer-start-button');
    this.timerResetButton = document.querySelector('#timer-reset-button');
    this.timerOptionMenu = document.querySelector('#timer-option-menu');
    if (!this.timerDisplay || !this.timerSetButton || !this.timerStartButton || !this.timerResetButton || !this.timerOptionMenu) return;
    this.timerSetButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#toggleTimerMenu();
    });
    this.timerStartButton.addEventListener('click', () => this.#toggleTimerCountdown());
    this.timerResetButton.addEventListener('click', () => this.#resetTimerCountdown());
    this.timerOptionMenu.querySelectorAll('[data-timer-option]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const seconds = Number(button.dataset.timerOption || 0);
        this.#selectTimerOption(button.textContent.trim(), Number.isFinite(seconds) ? seconds : 0);
      });
    });
    document.addEventListener('click', (event) => {
      if (!this.sleepTimer.menuOpen || !this.timerOptionMenu) return;
      if (event.target.closest('#timer-option-menu, #timer-set-button')) return;
      this.#toggleTimerMenu(false);
    });
    this.#renderSleepTimer();
  }

  #toggleTimerMenu(force) {
    if (!this.timerOptionMenu) return;
    const open = typeof force === 'boolean' ? force : !this.sleepTimer.menuOpen;
    this.sleepTimer.menuOpen = open;
    this.timerOptionMenu.hidden = !open;
    this.timerSetButton?.classList.toggle('is-active', open);
  }

  #selectTimerOption(label, seconds) {
    const safeSeconds = Math.max(0, Number(seconds) || 0);
    this.sleepTimer.optionLabel = label || 'OFF';
    this.sleepTimer.durationMs = safeSeconds * 1000;
    this.sleepTimer.remainingMs = safeSeconds * 1000;
    this.sleepTimer.paused = false;
    this.sleepTimer.expiring = false;
    if (safeSeconds > 0) this.#startTimerInterval();
    else this.#stopTimerInterval();
    this.#toggleTimerMenu(false);
    this.#renderSleepTimer();
  }

  #toggleTimerCountdown() {
    if (this.sleepTimer.durationMs <= 0) return;
    if (this.sleepTimer.running) {
      this.sleepTimer.paused = true;
      this.#stopTimerInterval();
    } else {
      this.sleepTimer.paused = false;
      this.#startTimerInterval();
    }
    this.#renderSleepTimer();
  }

  #resetTimerCountdown() {
    if (this.sleepTimer.durationMs <= 0) {
      this.sleepTimer.remainingMs = 0;
      this.sleepTimer.paused = false;
      this.#stopTimerInterval();
      this.#renderSleepTimer();
      return;
    }
    this.sleepTimer.remainingMs = this.sleepTimer.durationMs;
    this.sleepTimer.paused = false;
    this.sleepTimer.expiring = false;
    this.#startTimerInterval();
    this.#renderSleepTimer();
  }

  #startTimerInterval() {
    this.#stopTimerInterval();
    this.sleepTimer.running = true;
    this.sleepTimer.lastTickAt = performance.now();
    this.sleepTimer.interval = setInterval(() => this.#tickTimerCountdown(), 100);
  }

  #stopTimerInterval() {
    if (this.sleepTimer.interval) clearInterval(this.sleepTimer.interval);
    this.sleepTimer.interval = null;
    this.sleepTimer.running = false;
    this.sleepTimer.lastTickAt = 0;
  }

  #tickTimerCountdown() {
    if (!this.sleepTimer.running) return;
    const now = performance.now();
    const last = this.sleepTimer.lastTickAt || now;
    const elapsed = Math.max(0, now - last);
    this.sleepTimer.lastTickAt = now;
    this.sleepTimer.remainingMs = Math.max(0, this.sleepTimer.remainingMs - elapsed);
    if (this.sleepTimer.remainingMs <= 0) {
      this.sleepTimer.remainingMs = 0;
      this.sleepTimer.paused = false;
      this.#stopTimerInterval();
      this.#renderSleepTimer();
      if (!this.sleepTimer.expiring) {
        this.sleepTimer.expiring = true;
        this.#showOsd('TIMER', 'FADING');
        Promise.resolve(this.controller.timerFadeOutAndStop(10)).finally(()=>{
          this.sleepTimer.expiring = false;
          this.crt.stopGame();
          this.#showOsd('TIMER', 'END');
        });
      }
      return;
    }
    this.#renderSleepTimer();
  }

  #formatSleepTimer(ms) {
    if (this.sleepTimer.durationMs <= 0) return 'OFF';
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  #sevenSegmentDigit(digit) {
    const map = {
      '0': ['a','b','c','d','e','f'],
      '1': ['b','c'],
      '2': ['a','b','g','e','d'],
      '3': ['a','b','c','d','g'],
      '4': ['f','g','b','c'],
      '5': ['a','f','g','c','d'],
      '6': ['a','f','g','e','c','d'],
      '7': ['a','b','c'],
      '8': ['a','b','c','d','e','f','g'],
      '9': ['a','b','c','d','f','g'],
      'O': ['a','b','c','d','e','f'],
      'F': ['a','f','g','e']
    };
    const on = new Set(map[digit] || []);
    return `<span class="seg-digit" aria-hidden="true">${['a','b','c','d','e','f','g'].map(s=>`<i class="seg seg-${s}${on.has(s)?' on':''}"></i>`).join('')}</span>`;
  }

  #renderSegmentedTime(value) {
    return [...value].map(ch => ch === ':'
      ? '<span class="seg-colon" aria-hidden="true"><i></i><i></i></span>'
      : this.#sevenSegmentDigit(ch)
    ).join('');
  }

  #renderSleepTimer() {
    if (!this.timerDisplay) return;
    const displayText = this.#formatSleepTimer(this.sleepTimer.remainingMs);
    if (displayText !== this.lastTimerDisplayText) {
      this.timerDisplay.innerHTML = this.#renderSegmentedTime(displayText);
      this.timerDisplay.setAttribute('aria-label', displayText);
      this.lastTimerDisplayText = displayText;
    }
    this.timerDisplay.classList.toggle('is-off', this.sleepTimer.durationMs <= 0);
    this.timerDisplay.classList.toggle('is-running', this.sleepTimer.running);

    // PAUSE is normally unlit. It lights only while the countdown is paused.
    if (this.timerStartButton) {
      this.timerStartButton.textContent = 'PAUSE';
      this.timerStartButton.classList.toggle('is-active', this.sleepTimer.paused);
      this.timerStartButton.setAttribute('aria-pressed', String(this.sleepTimer.paused));
    }

    // RESET remains visually neutral at all times.
    if (this.timerResetButton) {
      this.timerResetButton.classList.remove('is-active');
      this.timerResetButton.setAttribute('aria-pressed', 'false');
    }

    if (this.timerOptionMenu && this.lastTimerOptionLabel !== this.sleepTimer.optionLabel) {
      this.timerOptionMenu.querySelectorAll('[data-timer-option]').forEach((button) => {
        button.classList.toggle('is-selected', button.textContent.trim().toUpperCase() === String(this.sleepTimer.optionLabel).toUpperCase());
      });
      this.lastTimerOptionLabel = this.sleepTimer.optionLabel;
    }
  }

  render(state, meta) {
    const reason=String(meta?.reason||'');
    document.querySelector('#machine').style.setProperty('--unit-brightness', String(state.master.brightness));
    // Physical TV/main rockers do not require a CRT-page repaint. Avoiding that
    // broad render path is particularly important on tablets while an OSD is up.
    if (/^(master-(tone|brightness)|game-volume|main-volume)$/.test(reason)) {
      if (reason === 'game-volume' || reason === 'main-volume') this.crt.gameRuntime?.syncAudioLevels?.();
      return;
    }
    if (this.lastSoundscapeId !== state.soundscape.id) {
      if (this.lastSoundscapeId !== null) this.#showSSFlash(state.soundscape.id);
      this.lastSoundscapeId = state.soundscape.id;
    }
    this.crt.render(state);
    this.crt.gameRuntime?.syncAudioLevels?.();
    document.querySelector('#dev-status').textContent=state.dev.message;

    document.querySelectorAll('[data-soundscape]').forEach(btn=>{
      const selected=btn.dataset.soundscape===state.soundscape.id;
      btn.setAttribute('aria-pressed',String(selected));
      if (btn.dataset.soundscape) btn.disabled=state.soundscape.loading || !state.availableSoundscapes.includes(btn.dataset.soundscape);
    });

    const play=document.querySelector('#play-button'), pause=document.querySelector('#pause-button'), stop=document.querySelector('#stop-button');
    play.classList.toggle('is-active',state.transport.status==='playing');
    play.classList.toggle('is-paused',state.transport.status==='paused');
    pause.classList.toggle('is-active',state.transport.status==='paused');
    stop.classList.toggle('is-active',state.transport.status==='stopped');
    pause.disabled=state.transport.status==='stopped';

    document.querySelectorAll('[data-effect-button]').forEach(btn=>btn.classList.toggle('is-active',Boolean(state.effects[btn.dataset.effectButton]?.enabled)));
    document.querySelectorAll('[data-frs]').forEach(btn=>btn.classList.toggle('is-active',btn.dataset.frs===state.frs));
    const intensity=document.querySelector('#intensity'); if(document.activeElement!==intensity) intensity.value=String(Math.round(state.intensity*50));

    document.querySelector('#automix-toggle').textContent=`AUTO MIX ${state.autoMix.enabled?'ON':'OFF'}`;
    document.querySelector('#automix-force').disabled=!(state.autoMix.enabled && state.transport.status==='playing');
    document.querySelector('#special-event-force').disabled=state.specialEvent.active || state.transport.status!=='playing';

    document.querySelector('#small-ss').textContent=`${state.soundscape.id.slice(2)}: ${state.soundscape.name.toUpperCase()}`;
    const rows=[...document.querySelectorAll('.small-row')];
    state.tracks.forEach((track,i)=>{
      const percent=Math.round(track.volume*100); rows[i].querySelector('.small-value').textContent=String(percent);
      const lit=Math.round(percent/100*16); [...rows[i].querySelectorAll('.small-bar i')].forEach((seg,n)=>seg.classList.toggle('lit',n<lit));
    });
    document.querySelector('#small-automix').textContent=`AUTO MIX: ${state.autoMix.enabled?'ON':'OFF'}`;
    document.querySelector('#small-ramp').textContent=`RAMP: ${state.transport.rampEnabled!==false?'ON':'OFF'}`;
    const tapeLabel = state.tapeType==='normal'?'I':state.tapeType==='chrome'?'II':'IV';
    document.querySelector('#small-tape').textContent=`TYPE ${tapeLabel}`;
    document.querySelector('#small-transport').textContent=(state.tv.active?'TV · ':'')+state.transport.status.toUpperCase();
    document.querySelector('#byd-button').classList.toggle('is-active', state.display.secondary==='byd');
    document.querySelector('#cc-button').classList.toggle('is-active', state.display.secondary==='control-centre');
    document.querySelector('#guides-button').classList.toggle('is-active', state.display.secondary==='user-guides');
    document.querySelector('#tv-button').classList.toggle('is-active', state.display.baseScreen==='tv');
    document.querySelector('#game-button').classList.toggle('is-active', state.display.baseScreen==='game-placeholder');
    const masterMute = document.querySelector('#master-mute-button');
    masterMute.classList.toggle('is-active', Boolean(state.master.muted));
    masterMute.setAttribute('aria-pressed', String(Boolean(state.master.muted)));
  }

  #fitStage() {
    const viewport=document.querySelector('#stage-viewport'); const stage=document.querySelector('#stage');
    const availableW=Math.max(320,window.innerWidth-20); const availableH=Math.max(220,window.innerHeight-92);
    const scale=Math.min(availableW/1536,availableH/1024,1);
    stage.style.transform=`scale(${scale})`; viewport.style.width=`${1536*scale}px`; viewport.style.height=`${1024*scale}px`;
  }
}
