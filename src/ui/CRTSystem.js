import { GameRuntime } from "./GameRuntime.js";

export class CRTSystem {
  constructor({ store, controller, root }) {
    this.store = store;
    this.controller = controller;
    this.root = root;
    this.guideId = null;
    this.selectedGuideId = 'main';
    this.selectedGameId = 'block';
    this.gameLoadingScreens = false;
    this.gameLoadingLoop = true;
    this.gameLaunchId = null;
    this.gameLoaderActive = false;
    this.gamePendingLaunchId = null;
    this.gameLoaderLoopActive = false;
    this.gameLoaderLoopIndex = 0;
    this.gameLoaderLoopPaused = false;
    this.gameLoaderLoopVideo = null;
    this.gameLoaderLoopHost = null;
    this.adventurePlaceholder = false;
    this.gameSecondaryActive = false;
    this.gameSecondaryPausedByUs = false;
    this.gameExitConfirm = false;
    this.gameExitDestination = 'game-placeholder';
    this.gameExitWasPaused = false;
    this.gameExitPreviousFocus = null;
    this.gameRuntime = new GameRuntime({
      store,
      onGameEvent: (event) => this.handleGameEvent(event)
    });
    this.bound = false;
    this.interacting = false;
    this.interactionReleaseTimer = null;
    this.pendingState = null;
    this.currentScreen = null;
    this.mountedScreen = null;
    this.typeTimer = null;
    this.cursorFlashTimer = null;
    this.welcomeTypedIndex = 0;
    this.welcomeTypingComplete = false;
    this.welcomeIntroAnimating = false;
    this.fxStationIntroShown = false;
    this.fxStationTypeTimer = null;
    this.fxStationCursorTimer = null;
    this.pageTransitioning = false;
    this.uiAudio = null;
    this.scopeSweepFrame = null;
    this.scopeMarkerX = 0;
    this.scopeMarkerY = 0;
    this.domCache = new Map();
    this.scopeLastFrameMs = 0;
    this.bind();
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden) this.stopScopeSweepClock();
      else if(this.currentScreen==='control-centre') this.startScopeSweepClock();
    });
  }

  clearDomCache() { this.domCache.clear(); }

  cached(selector, all=false) {
    const key=(all?'A:':'Q:')+selector;
    if(this.domCache.has(key)) return this.domCache.get(key);
    const value=all?[...this.root.querySelectorAll(selector)]:this.root.querySelector(selector);
    this.domCache.set(key,value);
    return value;
  }

  startScopeSweepClock() {
    if (this.scopeSweepFrame || this.currentScreen !== 'control-centre' || document.hidden) return;
    const tick = () => {
      if (this.currentScreen !== 'control-centre' || document.hidden) {
        this.scopeSweepFrame = null;
        return;
      }
      const nowMs=performance.now();
      if(nowMs-this.scopeLastFrameMs<100){ this.scopeSweepFrame=window.requestAnimationFrame(tick); return; }
      this.scopeLastFrameMs=nowMs;
      const state = this.store.getState();
      const sweep = this.cached('.cc2-radar-sweep');
      if (sweep) {
        const cycle = Number(state.fxMod?.scopeCycleMs) || (state.frs === 'sleep' ? 12800 : state.frs === 'relax' ? 6400 : 3200);
        const epoch = Number(state.fxMod?.scopeEpochMs) || Date.now();
        const phase = ((Date.now() - epoch) % cycle + cycle) % cycle;
        const angle = -90 + (phase / cycle) * 360;
        sweep.style.animation = 'none';
        sweep.style.transform = `rotate(${angle}deg)`;
        sweep.dataset.frs = state.frs;
      }
      const nav = this.cached('.cc2-fxmod-nav');
      if (nav && !this.interacting) {
        const x = Math.max(-1,Math.min(1,Number(state.fxMod?.x)||0));
        const y = Math.max(-1,Math.min(1,Number(state.fxMod?.y)||0));
        this.scopeMarkerX = x;
        this.scopeMarkerY = y;
        nav.style.left = `${50+x*43}%`;
        nav.style.top = `${50-y*43}%`;
        nav.classList.toggle('active',Boolean(state.fxMod?.active));
      }
      this.scopeSweepFrame = window.requestAnimationFrame(tick);
    };
    this.scopeSweepFrame = window.requestAnimationFrame(tick);
  }

  stopScopeSweepClock() {
    if (this.scopeSweepFrame) cancelAnimationFrame(this.scopeSweepFrame);
    this.scopeSweepFrame = null;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.root.addEventListener('contextmenu', (e) => {
      if (e.target.closest?.('button,input,[data-menu-item],.cc2-radar,[data-fxmod-pad]')) e.preventDefault();
    }, true);

    this.root.addEventListener('pointerdown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'range') {
        clearTimeout(this.interactionReleaseTimer);
        this.interacting = true;
      }
    }, true);
    window.addEventListener('pointerup', () => {
      if (!this.interacting) return;
      clearTimeout(this.interactionReleaseTimer);
      this.interactionReleaseTimer = setTimeout(() => {
        this.interacting = false;
        if (this.pendingState) {
          const s=this.pendingState;
          this.pendingState=null;
          // Keep the current CRT DOM mounted after a slider drag. Replacing
          // innerHTML here caused a visible flicker before the final value appeared.
          this.patchScreen(s, this.currentScreen);
        }
      }, 60);
    }, true);

    // BYD track-volume sliders use an explicit pointer mapping rather than relying
    // on the browser's native range drag math. The whole machine is responsively
    // scaled, and native range controls can report values unevenly inside that
    // transformed coordinate space. This mirrors the small CRT behaviour: map the
    // pointer directly to the slider's on-screen bounds, update the number/thumb
    // immediately, and then commit the same value to the shared state/audio engine.
    this.root.addEventListener('pointerdown', (e) => {
      const slider=e.target.closest?.('.byd-screen input[data-kind="track-volume"]');
      if (!(slider instanceof HTMLInputElement)) return;
      e.preventDefault();
      clearTimeout(this.interactionReleaseTimer);
      this.interacting=true;
      slider.setPointerCapture?.(e.pointerId);
      const index=Number(slider.dataset.index);
      let lastCommit=0, pendingValue=null, commitTimer=null;
      const commit=(value,force=false)=>{
        pendingValue=value;
        const now=performance.now();
        const wait=Math.max(0,67-(now-lastCommit));
        if(force || wait<=0){
          if(commitTimer){clearTimeout(commitTimer);commitTimer=null;}
          lastCommit=now; const next=pendingValue; pendingValue=null;
          this.controller.setTrackVolume(index,next/100);
        }else if(!commitTimer){
          commitTimer=setTimeout(()=>{commitTimer=null;if(pendingValue!==null){lastCommit=performance.now();const next=pendingValue;pendingValue=null;this.controller.setTrackVolume(index,next/100);}},wait);
        }
      };
      const apply=(ev,force=false)=>{
        const rect=slider.getBoundingClientRect();
        if (!rect.width) return;
        const raw=(ev.clientX-rect.left)/rect.width;
        const clamped=Math.max(0,Math.min(1,raw));
        const value=Math.round(clamped*100);
        slider.value=String(value);
        commit(value,force);
      };
      const move=(ev)=>{ if (ev.pointerId===e.pointerId) apply(ev); };
      const end=(ev)=>{
        if (ev.pointerId!==e.pointerId) return;
        apply(ev,true);
        try { slider.releasePointerCapture?.(e.pointerId); } catch {}
        window.removeEventListener('pointermove',move,true);
        window.removeEventListener('pointerup',end,true);
        window.removeEventListener('pointercancel',end,true);
      };
      apply(e);
      window.addEventListener('pointermove',move,true);
      window.addEventListener('pointerup',end,true);
      window.addEventListener('pointercancel',end,true);
    }, true);

    // Reliable menu hover state. This is deliberately class-driven as well as
    // CSS :hover so it also works while the layout-dev selection overlay is active.
    this.root.addEventListener('pointerover', (e) => {
      const btn = e.target.closest?.('[data-menu-item]');
      if (btn && !btn.disabled) btn.classList.add('menu-hovered');
    }, true);
    this.root.addEventListener('pointerout', (e) => {
      const btn = e.target.closest?.('[data-menu-item]');
      if (btn && !btn.contains(e.relatedTarget)) btn.classList.remove('menu-hovered');
    }, true);

    // CC FX MOD XY pad: capture current values, temporarily suspend Auto Mix on
    // affected parameters, then drift home and hand them back on release.
    this.root.addEventListener('pointerdown', (e) => {
      const pad=e.target.closest?.('.cc2-radar[data-fxmod-pad]'); if(!pad)return;
      if(!this.controller.beginFxModManual())return;
      e.preventDefault(); this.interacting=true; pad.setPointerCapture?.(e.pointerId); pad.classList.add('fxmod-grabbed');
      let lastSample=null, vx=0, vy=0;
      const move=(ev)=>{const r=pad.getBoundingClientRect(),x=Math.max(-1,Math.min(1,((ev.clientX-r.left)/r.width)*2-1)),y=Math.max(-1,Math.min(1,-(((ev.clientY-r.top)/r.height)*2-1))),now=performance.now();if(lastSample){const dt=Math.max(.008,(now-lastSample.t)/1000),ivx=(x-lastSample.x)/dt,ivy=(y-lastSample.y)/dt;vx=vx*.58+ivx*.42;vy=vy*.58+ivy*.42;}lastSample={x,y,t:now};const nav=pad.querySelector('.cc2-fxmod-nav');this.scopeMarkerX=x;this.scopeMarkerY=y;if(nav){nav.style.left=`${50+x*43}%`;nav.style.top=`${50-y*43}%`;nav.classList.add('active');}this.controller.moveFxModManual(x,y);};
      move(e);
      const end=(ev)=>{pad.classList.remove('fxmod-grabbed');pad.releasePointerCapture?.(e.pointerId);const age=lastSample?performance.now()-lastSample.t:999;if(age>110){vx=0;vy=0;}this.controller.endFxModManual(vx,vy);this.interacting=false;window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',end,true);window.removeEventListener('pointercancel',end,true);if(this.pendingState){const st=this.pendingState;this.pendingState=null;this.patchScreen(st,'control-centre');}};
      window.addEventListener('pointermove',move,true);window.addEventListener('pointerup',end,true);window.addEventListener('pointercancel',end,true);
    }, true);

    this.root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      if (action === 'select-ss') this.controller.selectSoundscape(el.dataset.id);
      else if (action === 'play' && this.currentScreen === 'welcome') { this.startWelcomeSequence(); return; }
      else if (action === 'skip-welcome-intro' && this.currentScreen === 'welcome') { this.skipWelcomeIntro(); return; }
      else if (action === 'play') this.controller.play();
      else if (action === 'pause') this.controller.pause();
      else if (action === 'stop') this.controller.stop();
      else if (action === 'effect') this.controller.toggleEffect(el.dataset.name);
      else if (action === 'frs') this.controller.setFRS(el.dataset.mode);
      else if (action === 'mute') this.controller.toggleMute(Number(el.dataset.index));
      else if (action === 'solo') this.controller.toggleSolo(Number(el.dataset.index));
      else if (action === 'xfade') this.controller.toggleXFade(Number(el.dataset.index), Number(el.dataset.choice));
      else if (action === 'frequency-mode') this.controller.toggleTrackFrequencyMode(Number(el.dataset.index));
      else if (action === 'frequency') this.controller.cycleTrackFrequency(Number(el.dataset.index));
      else if (action === 'frequency-random') this.controller.toggleTrackFrequencyRandom(Number(el.dataset.index));
      else if (action === 'tape') this.controller.setTapeType(el.dataset.type);
      else if (action === 'automix') this.controller.toggleAutoMix();
      else if (action === 'fxmod-toggle') this.controller.toggleFxMod();
      else if (action === 'fxmod-hold') this.controller.setFxModHold(el.dataset.mode);
      else if (action === 'fxmod-time') this.controller.cycleFxModTime();
      else if (action === 'fxmod-prob') this.controller.cycleFxModProb();
      else if (action === 'fxmod-time-select') this.controller.setFxModTime(el.dataset.mode);
      else if (action === 'fxmod-prob-select') this.controller.setFxModProb(el.dataset.mode);
      else if (action === 'fxmod-reset') this.controller.resetFxModPattern();
      else if (action === 'fxmod-param') this.controller.toggleFxModParam(el.dataset.param);
      else if (action === 'output') this.controller.setOutputMode(el.dataset.mode);
      else if (action === 'tv') this.controller.showBaseScreen('tv');
      else if (action === 'game') this.controller.showBaseScreen('game-placeholder');
      else if (action === 'base-screen' && this.currentScreen === 'welcome') { this.transitionTo(()=>this.controller.showBaseScreen(el.dataset.screen)); return; }
      else if (action === 'base-screen') this.controller.showBaseScreen(el.dataset.screen);
      else if (action === 'welcome-from-overlay') this.controller.showBaseScreen('welcome', { dismissOverlay: true });
      else if (action === 'secondary-screen' && this.currentScreen === 'welcome') { this.transitionTo(()=>this.controller.toggleSecondaryScreen(el.dataset.screen)); return; }
      else if (action === 'secondary-screen') this.openGameAwareSecondary(el.dataset.screen);
      else if (action === 'close-secondary') this.closeGameAwareSecondary();
      else if (action === 'game-select') { this.selectedGameId = el.dataset.gameId || 'block'; this.updateGameMenuSelection(); if (!this.gameLaunchId) this.launchSelectedGame(); }
      else if (action === 'game-loading-screens') { this.gameLoadingScreens = el.dataset.value === 'on'; this.updateGameMenuOptions(); }
      else if (action === 'game-loading-loop') { this.startLoaderLoop(); }
      else if (action === 'game-launch') { this.launchSelectedGame(); }
      else if (action === 'game-demo-toggle') { this.gameRuntime.toggleDemoMode(); this.updateGamePlayControls(); }
      else if (action === 'game-pause-local') { this.gameRuntime.togglePause(); this.updateGamePlayControls(); }
      else if (action === 'game-back-menu') { this.requestGameExitConfirmation(); }
      else if (action === 'game-exit-yes') { this.confirmGameExit(); }
      else if (action === 'game-exit-cancel') { this.cancelGameExit(); }
      else if (action === 'game-loader-loop-close') { this.closeLoaderLoop(); }
      else if (action === 'game-loader-loop-pause') { this.toggleLoaderLoopPause(); }
      else if (action === 'game-adventure-back') { this.adventurePlaceholder=false; this.render(this.store.getState(), true); }
      else if (action === 'guide') { this.selectedGuideId = el.dataset.id; this.guideId = el.dataset.id; this.render(this.store.getState(), true); }
      else if (action === 'guide-back') { this.guideId = null; this.render(this.store.getState(), true); queueMicrotask(()=>this.focusSelectedGuide()); }
    });

    // Global CRT menu keyboard rule: Up/Down moves through the active menu.
    // On the Welcome soundscape menu it also changes the active soundscape.
    // Enter activates the focused menu item. In layout edit mode the arrow keys
    // remain reserved for pixel nudging instead.
    this.root.addEventListener('keydown', (e) => {
      if (document.body.classList.contains('welcome-layout-edit')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const items = [...this.root.querySelectorAll('.crt-screen [data-menu-item]:not(:disabled)')].filter(el => el.offsetParent !== null);
        if (!items.length) return;
        e.preventDefault();
        const current = items.findIndex(el => el === document.activeElement || el.classList.contains('selected') || el.getAttribute('aria-current') === 'true');
        const step = e.key === 'ArrowUp' ? -1 : 1;
        const nextIndex = current < 0 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length;
        const next = items[nextIndex];
        next.focus({ preventScroll: true });
        if (next.dataset.action === 'select-ss' && next.dataset.id) this.controller.selectSoundscape(next.dataset.id);
        return;
      }
      if (e.key === 'Enter') {
        const active = document.activeElement?.closest?.('[data-menu-item]');
        if (active && this.root.contains(active)) { e.preventDefault(); active.click(); }
      }
    }, true);

    this.root.addEventListener('input', (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement)) return;
      const kind = el.dataset.kind;
      const value = Number(el.value);

      if (kind === 'track-volume') this.controller.setTrackVolume(Number(el.dataset.index), value / 100);
      else if (kind === 'track-pan') this.controller.setTrackPan(Number(el.dataset.index), value / 100);
      else if (kind === 'track-filter') this.controller.setTrackFilter(Number(el.dataset.index), value / 100);
      else if (kind === 'effect-level') this.controller.setEffectLevel(el.dataset.name, value / 100);
      else if (kind === 'character') this.controller.setCharacter(el.dataset.name, value / 100);
      else if (kind === 'intensity') this.controller.setIntensity(value / 50);
      else if (kind === 'main-volume') this.controller.setMainVolume(value / 100);
      else if (kind === 'game-volume') this.controller.setGameVolume(value / 100);
      else if (kind === 'brightness') this.controller.setBrightness(value / 100);
      else if (kind === 'tone') this.controller.setMasterTone(value / 100);
    });

    this.root.addEventListener('dblclick', (e) => {
      const el = e.target.closest('input[data-reset]');
      if (!el) return;
      const reset = el.dataset.reset;
      if (reset === 'track') this.controller.resetTrackParamToPreset(Number(el.dataset.index), el.dataset.param);
      else if (reset === 'effect') this.controller.resetEffectToPreset(el.dataset.name);
      else if (reset === 'character') this.controller.resetCharacterToPreset(el.dataset.name);
    });


    // Standing CRT accessibility/navigation rule: Up/Down moves through the
    // currently visible CRT menu; Enter activates the focused item. Soundscape
    // menus opt into immediate selection while moving, matching the hardware feel.
    window.addEventListener('keydown', (e) => {
      if (document.body.classList.contains('welcome-layer-edit')) return;
      const t=e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || t.tagName==='TEXTAREA' || (t.tagName==='INPUT' && t.getAttribute('type')!=='range'))) return;
      if (this.currentScreen === 'user-guides' && !this.guideId && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Enter'].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.key === 'Enter') { this.openSelectedGuide(); return; }
        const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -2 : 2;
        this.moveGuideSelection(delta); return;
      }
      if (!['ArrowUp','ArrowDown','Enter'].includes(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
      const items=[...this.root.querySelectorAll('[data-menu-item]:not(:disabled)')].filter(el=>{
        const r=el.getBoundingClientRect(); return r.width>0 && r.height>0;
      });
      if (!items.length) return;
      if (e.key==='Enter') {
        const active=document.activeElement;
        if (active && items.includes(active)) { e.preventDefault(); active.click(); }
        return;
      }
      e.preventDefault();
      let index=items.indexOf(document.activeElement);
      if (index<0) index=items.findIndex(el=>el.classList.contains('selected') || el.classList.contains('active'));
      if (index<0) index=0;
      else index=(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;
      const next=items[index]; next.focus({preventScroll:true});
      if (next.dataset.keynavActivate==='true') next.click();
    }, true);
  }

  render(state, force=false) {
    const screen = this.resolveScreen(state);
    if (!force && this.interacting && screen === this.currentScreen) {
      this.pendingState = state;
      return;
    }
    const preservingGameUnderSecondary = state.display.baseScreen === 'game-placeholder' && Boolean(this.gameLaunchId) && Boolean(state.display.secondary);
    if (this.currentScreen === 'game-placeholder' && screen !== 'game-placeholder' && !preservingGameUnderSecondary) this.gameRuntime.detach();
    this.currentScreen = screen;
    if (screen === 'control-centre') this.startScopeSweepClock();
    else this.stopScopeSweepClock();
    if (this.welcomeIntroAnimating && screen === 'welcome' && this.mountedScreen === 'welcome') { this.patchScreen(state, screen); return; }

    // WELCOME changes its structure after the first PLAY, even though it remains
    // the same base screen. Force one remount for that phase transition.
    if (!force && screen === 'welcome' && this.mountedScreen === 'welcome') {
      const hasGuidance = Boolean(this.root.querySelector('[data-layout-key="typed-line"]'));
      const shouldHaveGuidance = state.boot.phase === 'running';
      if (hasGuidance !== shouldHaveGuidance) force = true;
    }

    // IMPORTANT: Auto Mix can update state many times per second.
    // Replacing innerHTML on every update destroys the element between
    // pointerdown and click, which made CRT buttons appear dead while playing.
    // Mount a screen only when the screen itself changes; otherwise patch
    // the existing controls/readouts in place.
    if (!force && this.mountedScreen === screen) {
      this.patchScreen(state, screen);
      return;
    }

    this.clearDomCache();

    if (screen === 'welcome') this.renderWelcome(state);
    else if (screen === 'byd') this.renderBYD(state);
    else if (screen === 'control-centre') this.renderControlCentre(state);
    else if (screen === 'user-guides') this.renderGuides(state);
    else if (screen === 'tv') this.renderTV(state);
    else if (screen === 'game-placeholder') this.renderGamePlaceholder(state);
    else this.renderIdle(state);

    this.mountedScreen = screen;
    this.patchScreen(state, screen);
  }

  patchScreen(state, screen=this.currentScreen) {
    const setRange = (selector, value) => {
      const el = this.cached(selector);
      if (!el || el === document.activeElement || this.interacting) return;
      const next=String(value);
      if(el.value!==next) el.value=next;
    };
    const setText = (selector, value) => {
      const el = this.cached(selector);
      if (!el) return;
      const next=String(value);
      if(el.textContent!==next) el.textContent=next;
    };
    const toggle = (selector, active, className='active') => {
      const el = this.cached(selector);
      if (el) el.classList.toggle(className, Boolean(active));
    };

    if (screen === 'byd') {
      state.tracks.forEach((track, i) => {
        for (const [kind, param, scale] of [
          ['track-volume','volume',100],
          ['track-pan','pan',100]
        ]) {
          setRange(`input[data-kind="${kind}"][data-index="${i}"]`, Math.round(track[param]*scale));
        }
        this.cached(`[data-action="xfade"][data-index="${i}"]`,true).forEach(el =>
          el.classList.toggle('active', Number(el.dataset.choice) === track.xfade));
        setText(`[data-frequency-mode][data-index="${i}"]`, track.frequencyMode === 'loop' ? 'LOOP' : track.frequencyMode === 'dropout' ? 'DROPOUT' : 'FREQUENCY');
        setText(`[data-frequency-value][data-index="${i}"]`, track.frequency ?? 1);
        toggle(`[data-action="frequency-random"][data-index="${i}"]`, track.frequencyRandom);
        const rnd=this.root.querySelector(`[data-action="frequency-random"][data-index="${i}"]`);
        if(rnd) rnd.setAttribute('aria-pressed', track.frequencyRandom?'true':'false');
        toggle(`[data-action="mute"][data-index="${i}"]`, track.mute);
        toggle(`[data-action="solo"][data-index="${i}"]`, track.solo);
      });
      for (const name of ['age','hiss','wowFlutter']) {
        setRange(`input[data-kind="character"][data-name="${name}"]`, Math.round(state.character[name]*100));
      }
      this.root.querySelectorAll('[data-action="frs"]').forEach(el =>
        el.classList.toggle('active', el.dataset.mode === state.frs));
      this.root.querySelectorAll('[data-action="tape"]').forEach(el =>
        el.classList.toggle('active', el.dataset.type === state.tapeType));
      return;
    }

    if (screen === 'control-centre') {
      state.tracks.forEach((track, i) => {
        setRange(`input[data-kind="track-filter"][data-index="${i}"]`, Math.round(track.filter*100));
      });

      for (const name of ['tremolo','delay','reverb','width']) {
        setRange(`input[data-kind="effect-level"][data-name="${name}"]`, Math.round(state.effects[name].level*100));
        const btn = this.root.querySelector(`[data-action="effect"][data-name="${name}"]`);
        if (btn) {
          const enabled=Boolean(state.effects[name].enabled);
          btn.classList.toggle('active',enabled);
          btn.setAttribute('aria-pressed',enabled?'true':'false');
          const slider=this.root.querySelector(`input[data-kind="effect-level"][data-name="${name}"]`);
          slider?.classList.toggle('fx-off',!enabled);
          if (!btn.classList.contains('cc3-label-toggle')) btn.textContent = enabled ? 'ON' : 'OFF';
        }
      }

      for (const name of ['age','hiss','wowFlutter']) {
        setRange(`input[data-kind="character"][data-name="${name}"]`, Math.round(state.character[name]*100));
      }

      this.root.querySelectorAll('[data-action="tape"]').forEach(el =>
        el.classList.toggle('active', el.dataset.type === state.tapeType));
      this.root.querySelectorAll('[data-action="output"]').forEach(el =>
        el.classList.toggle('active', el.dataset.mode === state.master.outputMode));
      const auto = this.root.querySelector('[data-action="automix"]');
      if (auto) {
        auto.classList.toggle('active', state.autoMix.enabled);
        auto.textContent = `AUTO MIX ${state.autoMix.enabled ? 'ON' : 'OFF'}`;
      }
      const fxmod=this.root.querySelector('[data-action="fxmod-toggle"]');
      if(fxmod){fxmod.classList.toggle('active',state.fxMod.enabled);fxmod.textContent=state.fxMod.enabled?'ON':'OFF';}
      const timeReadout=this.root.querySelector('[data-fxmod-time-value]');
      if(timeReadout) timeReadout.textContent=state.fxMod.timeMode||'01';
      const probReadout=this.root.querySelector('[data-fxmod-prob-value]');
      if(probReadout) probReadout.textContent=state.fxMod.probMode||'x1';
      const timeBox=this.root.querySelector('[data-fx-option-value="time"]');
      if(timeBox) timeBox.textContent=String(state.fxMod.timeMode||'01').replace(/^0/,'');
      const probBox=this.root.querySelector('[data-fx-option-value="prob"]');
      if(probBox) probBox.textContent=String(state.fxMod.probMode||'x1').toUpperCase();
      this.root.querySelectorAll('[data-action="fxmod-time-select"]').forEach(b=>b.classList.toggle('active',b.dataset.mode===String(state.fxMod.timeMode||'01')));
      this.root.querySelectorAll('[data-action="fxmod-prob-select"]').forEach(b=>b.classList.toggle('active',b.dataset.mode===String(state.fxMod.probMode||'x1')));
      const nav=this.root.querySelector('.cc2-fxmod-nav');
      if(nav) nav.classList.toggle('active',state.fxMod.active);

      const sweep=this.root.querySelector('.cc2-radar-sweep');
      if(sweep) sweep.dataset.frs=state.frs;
      const enabledParams=state.fxMod.params||{intensity:true,reverb:true,width:true,tremolo:true,delay:true,filter:true};
      this.root.querySelectorAll('[data-action="fxmod-param"]').forEach(b=>b.classList.toggle('active',enabledParams[b.dataset.param]!==false));
      this.root.querySelectorAll('[data-action="frs"]').forEach(el=>el.classList.toggle('active',el.dataset.mode===state.frs));
      setRange('input[data-kind="intensity"]', Math.round(state.intensity*50));
      return;
    }

    if (screen === 'welcome') {
      this.root.querySelectorAll('[data-action="select-ss"]').forEach(el => {
        const selected = el.dataset.id === state.soundscape.id;
        el.classList.toggle('selected', selected);
        const name = el.querySelector('.welcome-ss-name');
        if (name && !el.disabled) name.textContent = selected ? state.soundscape.name.toUpperCase() : `SOUNDSCAPE ${el.dataset.id.slice(2)}`;
      });
      if (state.boot.phase === 'running') this.ensureWelcomeGuidance();
      return;
    }

    if (screen === 'game-placeholder') {
      this.gameRuntime.syncAudioLevels?.();
      const fallbackLevel = state.master?.muted ? 0 :
        Math.max(0, Math.min(1,
          Number(state.auxiliary?.gameVolume ?? .5) *
          Number(state.master?.volume ?? .5) * 1.0
        ));
      this.root.querySelectorAll('video.game-loader-video').forEach(video=>{
        try { video.disablePictureInPicture = true; } catch {}
        video.muted=false;
        if (!this.gameRuntime.attachLoaderVideo?.(video)) video.volume=fallbackLevel;
      });
    }

    if (screen === 'game-placeholder' && this.gameLaunchId) {
      const mode=this.root.querySelector('.game-play-topbar span:last-child');
      if (mode) mode.textContent=`FRS: ${state.frs.toUpperCase()}`;
      return;
    }

    if (screen === 'tv') {
      setText('.missing-note', `TV MODE · ${state.frs.toUpperCase()} ${state.frs==='focus'?'100':state.frs==='relax'?'75':'50'}%`);
    }
  }

  resolveScreen(state) {
    if (state.display.secondary) return state.display.secondary;
    if (state.display.baseScreen === 'tv') return 'tv';
    if (state.display.baseScreen === 'game-placeholder') return 'game-placeholder';
    return 'welcome';
  }

  baseFooter(current) {
    const labels = { welcome:'WELCOME', 'game-placeholder':'GAME', tv:'TV' };
    return `<div class="base-footer">${Object.keys(labels).filter(k=>k!==current).map(k=>`<button class="ecosystem-button d8m4-menu-button" data-menu-item data-action="base-screen" data-screen="${k}">${labels[k]}</button>`).join('')}</div>`;
  }

  overlayFooter(current) {
    const labels = { byd:'BUILD YOUR DRONE', 'control-centre':'FX STATION', 'user-guides':'USER GUIDES' };
    const links = Object.keys(labels).filter(k=>k!==current).map(k=>`<button class="ecosystem-button overlay-link d8m4-menu-button" data-menu-item data-action="secondary-screen" data-screen="${k}">${labels[k]}</button>`).join('');
    return `<div class="overlay-footer">${links}<button class="ecosystem-button overlay-close d8m4-menu-button" data-menu-item data-action="close-secondary">CLOSE</button></div>`;
  }

  renderWelcome(state) {
    const list = Array.from({length: 6}, (_, i) => {
      const id = `SS0${i+1}`;
      const available = state.availableSoundscapes.includes(id);
      const selected = state.soundscape.id === id;
      const label = available
        ? (id === state.soundscape.id ? state.soundscape.name.toUpperCase() : `SOUNDSCAPE ${String(i+1).padStart(2,'0')}`)
        : 'COMING SOON';
      return `<button data-action="select-ss" data-id="${id}" data-menu-item data-keynav-activate="true" class="welcome-ss-row d8m4-menu-button ${selected?'selected':''}" ${available?'':'disabled'}><span class="welcome-ss-number">${String(i+1).padStart(2,'0')}</span><span class="welcome-ss-name">${label}</span><span class="welcome-ss-arrow">▶</span></button>`;
    }).join('');

    const running = state.boot.phase === 'running';
    const initialPhase = !running;
    const typedText = 'Now build your drone...';

    const initialDesign = initialPhase
      ? `<div class="welcome-design-text design-instruction welcome-edit-target" data-welcome-editable data-layer="design" data-layout-key="instruction" data-edit-text>Choose a soundscape and then press play</div>`
      : '';

    const initialLive = initialPhase
      ? `<div class="welcome-soundscape-menu welcome-edit-target" data-welcome-editable data-layer="live" data-layout-key="soundscape-menu">${list}</div>
         <button class="welcome-start-play d8m4-menu-button welcome-edit-target d8m4-pulse-button" data-welcome-editable data-layer="live" data-layout-key="play-button" data-menu-item data-action="play">PLAY</button>`
      : '';

    const guidanceLive = running
      ? `<div class="welcome-typed-block welcome-edit-target" data-welcome-editable data-layer="live" data-layout-key="typed-line" data-edit-text data-typed-text="Welcome to planet AMBIENT. Here you can create your own evolving soundscape.

First BUILD YOUR DRONE by setting channel volumes and effect levels. Then create some movement in the FX STATION.

At any point, you can relax and listen to your mix via TV MODE, or let GAME MODE take over!

Remember, there are no right or wrong settings — just play around and see what happens. And there’s always the USER GUIDES button if you need a little help!

Choose your destination:  "><div class="spectrum-typed-line"><span class="typed-copy"></span><span class="spectrum-type-cursor">L</span></div></div>
         <button class="welcome-skip-intro d8m4-menu-button welcome-edit-target" data-welcome-editable data-layer="live" data-layout-key="skip-intro-button" data-menu-item data-action="skip-welcome-intro">SKIP INTRO</button>
         <div class="welcome-path-stack" data-welcome-path-stack hidden>
           <button class="welcome-path-button d8m4-menu-button d8m4-pulse-button welcome-edit-target" data-welcome-editable data-layer="live" data-layout-key="byd-button" data-child-relative="true" data-welcome-path data-menu-item data-action="secondary-screen" data-screen="byd">BUILD YOUR DRONE</button>
           <button class="welcome-path-button d8m4-menu-button d8m4-pulse-button welcome-edit-target" data-welcome-editable data-layer="live" data-layout-key="cc-button" data-child-relative="true" data-welcome-path data-menu-item data-action="secondary-screen" data-screen="control-centre">FX STATION</button>
           <button class="welcome-path-button d8m4-menu-button d8m4-pulse-button welcome-edit-target" data-welcome-editable data-layer="live" data-layout-key="tv-button" data-child-relative="true" data-welcome-path data-menu-item data-action="base-screen" data-screen="tv">TV MODE</button>
           <button class="welcome-path-button d8m4-menu-button d8m4-pulse-button welcome-edit-target" data-welcome-editable data-layer="live" data-layout-key="game-button" data-child-relative="true" data-welcome-path data-menu-item data-action="base-screen" data-screen="game-placeholder">GAME MODE</button>
           <button class="welcome-path-button d8m4-menu-button d8m4-pulse-button welcome-edit-target" data-welcome-editable data-layer="live" data-layout-key="ug-button" data-child-relative="true" data-welcome-path data-menu-item data-action="secondary-screen" data-screen="user-guides">USER GUIDES</button>
         </div>`
      : '';

    this.root.innerHTML = `<div class="crt-screen welcome-screen welcome-final-screen ${initialPhase?'welcome-phase-select':'welcome-phase-guidance'}">
      <div class="welcome-background-layer" data-welcome-layer="background">
        <img class="welcome-art" src="assets/visuals/d8m4-welcome-background-only.png" alt="" aria-hidden="true">
      </div>

      <div class="welcome-design-layer" data-welcome-layer="design">
        ${initialPhase ? `<div class="welcome-header-block welcome-edit-target" data-welcome-editable data-layer="design" data-layout-key="header-block" data-lock-aspect="true" aria-label="Grouped D8M4 title block">
          <svg class="welcome-header-svg" viewBox="0 0 620 118" role="img" aria-label="DRONE MACHINE D8M4 title block">
            <text class="header-drone" x="2" y="31">DRONE MACHINE</text>
            <text class="header-model" x="430" y="31">D84M</text>
            <g class="header-colour-bar" transform="translate(2 47)">
              <rect x="0" y="0" width="142" height="18" fill="#ff2638"/>
              <rect x="142" y="0" width="142" height="18" fill="#22d84a"/>
              <rect x="284" y="0" width="142" height="18" fill="#1c88ff"/>
              <rect x="426" y="0" width="142" height="18" fill="#ffe21d"/>
            </g>
            <text class="header-strapline" x="2" y="96" textLength="568" lengthAdjust="spacingAndGlyphs">AMBIENT SOUNDSCAPES FOR A CALMER MIND</text>
          </svg>
        </div>
        <div class="welcome-brand-logo welcome-edit-target" data-welcome-editable data-layer="design" data-layout-key="brand-logo" data-lock-aspect="true" aria-label="Grimiss Ambient logo">
          <img src="assets/visuals/ga-reel-logo-grey-source.png" alt="Grimiss Ambient">
        </div>` : ''}
        ${initialDesign}
        <div class="welcome-design-text design-copyright welcome-edit-target" data-welcome-editable data-layer="design" data-layout-key="copyright" data-edit-text>© 1984 Grimiss Ambient</div>
      </div>

      <div class="welcome-live-layer" data-welcome-layer="live">
        ${initialLive}
        ${guidanceLive}
      </div>
    </div>`;
    if (running) this.ensureWelcomeGuidance();
  }

  // Standing CRT rule: all progressively typed CRT text uses the Spectrum L cursor: one character cell immediately after the typed text, flashing between normal and inverse-video states.
  startSpectrumCursorFlash(cursorSelector) {
    clearInterval(this.cursorFlashTimer);
    this.cursorFlashTimer = null;
    let inverse = false;
    const cursor = this.root.querySelector(cursorSelector);
    if (cursor) {
      cursor.hidden = false;
      cursor.classList.remove('is-inverse');
    }
    this.cursorFlashTimer = setInterval(() => {
      const live = this.root.querySelector(cursorSelector);
      if (!live || live.hidden) return;
      inverse = !inverse;
      live.classList.toggle('is-inverse', inverse);
    }, 320);
  }

  typeSpectrumText({ text, copySelector, cursorSelector, onComplete }) {
    const copy = this.root.querySelector(copySelector);
    const cursor = this.root.querySelector(cursorSelector);
    if (!copy || !cursor) return;
    // If a normal state/render patch calls this again while typing is already
    // underway, leave the active timers completely untouched. In RC11 these
    // clears happened before the guard, which cancelled the next character and
    // left the cursor stranded.
    if (this.welcomeTypingActive) return;
    clearTimeout(this.typeTimer);
    clearInterval(this.cursorFlashTimer);
    this.welcomeTypingActive = true;

    // A generation token still protects against genuinely stale callbacks.
    this.welcomeTypeGeneration = (this.welcomeTypeGeneration || 0) + 1;
    const generation = this.welcomeTypeGeneration;
    this.startSpectrumCursorFlash(cursorSelector);

    const finish = () => {
      if (generation !== this.welcomeTypeGeneration) return;
      clearTimeout(this.typeTimer);
      this.welcomeTypingComplete = true;
      this.welcomeTypingActive = false;
      const liveCursor = this.root.querySelector(cursorSelector);
      if (liveCursor) { liveCursor.hidden = false; liveCursor.classList.remove('is-inverse'); }
      onComplete?.();
    };

    if (this.welcomeTypingComplete) {
      copy.textContent = text;
      finish();
      return;
    }

    this.welcomeTypedIndex = Math.min(this.welcomeTypedIndex || 0, text.length);
    copy.textContent = text.slice(0, this.welcomeTypedIndex);
    const firstPauseAt = text.indexOf('\n\n');

    const step = () => {
      if (generation !== this.welcomeTypeGeneration) return;
      const activeCopy = this.root.querySelector(copySelector);
      if (!activeCopy) return;
      if (this.welcomeTypedIndex >= text.length) { finish(); return; }

      const ch = text[this.welcomeTypedIndex];
      this.welcomeTypedIndex += 1;
      activeCopy.textContent = text.slice(0, this.welcomeTypedIndex);
      if (ch && ch !== ' ' && ch !== '\n') this.playTypeClick();

      // Pause only once: immediately after sentence one, before the blank line.
      const delay = (firstPauseAt >= 0 && this.welcomeTypedIndex === firstPauseAt) ? 1050 : 72;
      this.typeTimer = setTimeout(step, delay);
    };
    this.typeTimer = setTimeout(step, this.welcomeTypedIndex ? 72 : 650);
  }

  ensureWelcomeGuidance() {
    const typedBlock = this.root.querySelector('[data-layout-key="typed-line"]');
    const copy = this.root.querySelector('.typed-copy');
    if (!typedBlock || !copy) return;
    const text = typedBlock.dataset.typedText || 'Now build your drone...';
    const done = () => {
      // Pause, then reveal the five path choices one-by-one. After the final
      // choice settles, type the closing Spectrum-style instruction.
      setTimeout(() => {
        const stack = this.root.querySelector('[data-welcome-path-stack]');
        if (!stack) return;
        stack.hidden = false;
        const buttons = [...stack.querySelectorAll('[data-welcome-path]')];
        buttons.forEach((el, i) => {
          el.style.setProperty('--path-delay', `${i * 190}ms`);
          el.classList.add('welcome-path-reveal');
        });

      }, 1050);
    };
    if (this.welcomeTypingComplete) {
      copy.textContent = text;
      const cursor=this.root.querySelector('.spectrum-type-cursor');
      if(cursor){
        cursor.hidden=false;
        cursor.classList.remove('is-inverse');
      }
      if(!this.cursorFlashTimer) this.startSpectrumCursorFlash('.spectrum-type-cursor');
      done();
      return;
    }
    this.typeSpectrumText({ text, copySelector:'.typed-copy', cursorSelector:'.spectrum-type-cursor', onComplete:done });
  }

  skipWelcomeIntro() {
    const typedBlock = this.root.querySelector('[data-layout-key="typed-line"]');
    const copy = this.root.querySelector('.typed-copy');
    const cursor = this.root.querySelector('.spectrum-type-cursor');
    const stack = this.root.querySelector('[data-welcome-path-stack]');
    if (!typedBlock || !copy) return;
    const text = typedBlock.dataset.typedText || '';

    clearTimeout(this.typeTimer);
    clearInterval(this.cursorFlashTimer);
    this.typeTimer = null;
    this.cursorFlashTimer = null;
    this.welcomeTypeGeneration = (this.welcomeTypeGeneration || 0) + 1;
    this.welcomeTypedIndex = text.length;
    this.welcomeTypingComplete = true;
    this.welcomeTypingActive = false;
    copy.textContent = text;
    if (cursor) {
      cursor.hidden = false;
      cursor.classList.remove('is-inverse');
    }
    this.startSpectrumCursorFlash('.spectrum-type-cursor');
    if (stack) {
      stack.hidden = false;
      [...stack.querySelectorAll('[data-welcome-path]')].forEach(el => {
        el.style.setProperty('--path-delay','0ms');
        el.classList.add('welcome-path-reveal');
      });
    }
    const skip = this.root.querySelector('[data-action="skip-welcome-intro"]');
    if (skip) skip.hidden = true;
  }

  typeWelcomeProgressPrompt() {
    if (this.welcomeProgressStarted) return;
    const block = this.root.querySelector('[data-progress-prompt]');
    const copy = block?.querySelector('.progress-copy');
    const cursor = block?.querySelector('.progress-cursor');
    if (!block || !copy || !cursor) return;
    this.welcomeProgressStarted = true;
    block.hidden = false;
    const text = 'Click a button to progress.';
    let i = 0, inverse = false;
    cursor.hidden = false;
    const flash = setInterval(() => { inverse = !inverse; cursor.classList.toggle('is-inverse', inverse); }, 320);
    const step = () => {
      if (!copy.isConnected) { clearInterval(flash); return; }
      if (i >= text.length) { clearInterval(flash); cursor.hidden = true; cursor.classList.remove('is-inverse'); return; }
      const ch = text[i++]; copy.textContent = text.slice(0, i);
      if (ch !== ' ') this.playTypeClick();
      setTimeout(step, 72);
    };
    setTimeout(step, 420);
  }

  startFxStationIntro() {
    const panel = this.root.querySelector('.cc3-fxstation-copy-panel');
    const copy = this.root.querySelector('.cc3-fxstation-copy');
    const cursor = this.root.querySelector('.cc3-fxstation-cursor');
    if (!panel || !copy || !cursor) return;
    const text = panel.dataset.typedText || 'Shape Your Own Special Events';

    clearTimeout(this.fxStationTypeTimer);
    clearInterval(this.fxStationCursorTimer);

    if (this.fxStationIntroShown) {
      copy.textContent = text;
      cursor.hidden = true;
      cursor.classList.remove('is-inverse');
      return;
    }

    this.fxStationIntroShown = true;
    copy.textContent = '';
    cursor.hidden = false;
    cursor.classList.remove('is-inverse');

    let index = 0;
    let inverse = false;
    this.fxStationCursorTimer = setInterval(() => {
      const live = this.root.querySelector('.cc3-fxstation-cursor');
      if (!live) {
        clearInterval(this.fxStationCursorTimer);
        this.fxStationCursorTimer = null;
        return;
      }
      inverse = !inverse;
      live.classList.toggle('is-inverse', inverse);
    }, 320);

    const finish = () => {
      clearTimeout(this.fxStationTypeTimer);
      clearInterval(this.fxStationCursorTimer);
      this.fxStationTypeTimer = null;
      this.fxStationCursorTimer = null;
      const liveCopy = this.root.querySelector('.cc3-fxstation-copy');
      const liveCursor = this.root.querySelector('.cc3-fxstation-cursor');
      if (liveCopy) liveCopy.textContent = text;
      if (liveCursor) {
        liveCursor.hidden = true;
        liveCursor.classList.remove('is-inverse');
      }
    };

    const step = () => {
      const liveCopy = this.root.querySelector('.cc3-fxstation-copy');
      if (!liveCopy) {
        clearTimeout(this.fxStationTypeTimer);
        clearInterval(this.fxStationCursorTimer);
        this.fxStationTypeTimer = null;
        this.fxStationCursorTimer = null;
        return;
      }
      if (index >= text.length) { finish(); return; }
      const ch = text[index++];
      liveCopy.textContent = text.slice(0, index);
      if (ch !== ' ') this.playTypeClick();
      this.fxStationTypeTimer = setTimeout(step, 72);
    };

    this.fxStationTypeTimer = setTimeout(step, 350);
  }

  ensureUiAudio(){ if(!this.uiAudio) this.uiAudio=new (window.AudioContext||window.webkitAudioContext)(); if(this.uiAudio.state==='suspended') this.uiAudio.resume(); return this.uiAudio; }
  playTypeClick(){
    try{
      const c=this.ensureUiAudio(), now=c.currentTime;
      const o=c.createOscillator(), g=c.createGain(), f=c.createBiquadFilter();
      o.type='square'; o.frequency.value=1120+Math.random()*190;
      f.type='highpass'; f.frequency.value=560;
      g.gain.setValueAtTime(.052+Math.random()*.012,now);
      g.gain.exponentialRampToValueAtTime(.0001,now+.026);
      o.connect(f).connect(g).connect(c.destination); o.start(now); o.stop(now+.03);
    }catch{}
  }
  playMachineStart(){
    try{
      const c=this.ensureUiAudio(), now=c.currentTime;
      // Soft transport/relay engagement.
      const clunk=c.createOscillator(), clunkGain=c.createGain();
      clunk.type='triangle'; clunk.frequency.setValueAtTime(105,now); clunk.frequency.exponentialRampToValueAtTime(42,now+.16);
      clunkGain.gain.setValueAtTime(.13,now); clunkGain.gain.exponentialRampToValueAtTime(.0001,now+.2);
      clunk.connect(clunkGain).connect(c.destination); clunk.start(now); clunk.stop(now+.21);

      // Tape hiss/contact noise, gently rising as the tape settles on the head.
      const length=Math.floor(c.sampleRate*2.25), buffer=c.createBuffer(1,length,c.sampleRate), data=buffer.getChannelData(0);
      for(let i=0;i<length;i++) data[i]=(Math.random()*2-1);
      const noise=c.createBufferSource(), nf=c.createBiquadFilter(), ng=c.createGain();
      noise.buffer=buffer; nf.type='bandpass'; nf.Q.value=.7;
      nf.frequency.setValueAtTime(650,now+.08); nf.frequency.exponentialRampToValueAtTime(2500,now+1.65);
      ng.gain.setValueAtTime(.0001,now+.08); ng.gain.exponentialRampToValueAtTime(.026,now+.42); ng.gain.setValueAtTime(.026,now+1.45); ng.gain.exponentialRampToValueAtTime(.0001,now+2.15);
      noise.connect(nf).connect(ng).connect(c.destination); noise.start(now+.08); noise.stop(now+2.2);

      // Motor/capstan run-up: low mechanical tone climbs gradually to speed.
      const motor=c.createOscillator(), mg=c.createGain(), mf=c.createBiquadFilter();
      motor.type='sawtooth'; mf.type='lowpass'; mf.frequency.value=520;
      motor.frequency.setValueAtTime(28,now+.08); motor.frequency.exponentialRampToValueAtTime(92,now+1.55);
      mg.gain.setValueAtTime(.0001,now+.08); mg.gain.exponentialRampToValueAtTime(.055,now+.28); mg.gain.setValueAtTime(.05,now+1.45); mg.gain.exponentialRampToValueAtTime(.0001,now+2.2);
      motor.connect(mf).connect(mg).connect(c.destination); motor.start(now+.08); motor.stop(now+2.25);
    }catch{}
  }
  startWelcomeSequence(){
    if(this.welcomeIntroAnimating) return;
    this.welcomeIntroAnimating=true;
    this.controller.play();
    const screen=this.root.querySelector('.welcome-final-screen');
    if(screen) screen.classList.add('welcome-recede');
    setTimeout(()=>{this.welcomeIntroAnimating=false;this.render(this.store.getState(),true)},1050);
  }

  transitionTo(action){ if(this.pageTransitioning)return;this.pageTransitioning=true;const old=this.root.querySelector('.crt-screen');old?.classList.add('d8m4-crt-dissolve-out');setTimeout(()=>{action();requestAnimationFrame(()=>{const fresh=this.root.querySelector('.crt-screen');fresh?.classList.add('d8m4-crt-dissolve-in');setTimeout(()=>{fresh?.classList.remove('d8m4-crt-dissolve-in');this.pageTransitioning=false},850)})},620); }

  renderBYD(state) {
    const channelColors=['red','green','blue','yellow'];
    const channels=state.tracks.map((t,i)=>`<section data-dev-layer="live" data-dev-key="ch${i+1}" class="byd2-channel byd2-${channelColors[i]}">
      <div class="byd2-channel-title">CH${i+1}</div>
      ${[
        ['LOOP VOL','track-volume','volume',0,100,Math.round(t.volume*100)],
        ['PAN','track-pan','pan',-100,100,Math.round(t.pan*100)]
      ].map(([label,kind,param,min,max,val])=>`<div class="byd2-param"><div class="byd2-param-head"><span>${label}</span></div><div class="byd2-slider-wrap"><i class="byd2-mid" aria-hidden="true"></i><input class="byd2-slider" data-kind="${kind}" data-reset="track" data-param="${param}" data-index="${i}" type="range" min="${min}" max="${max}" value="${val}"></div></div>`).join('')}
      <div class="byd2-ms"><button data-action="mute" data-index="${i}" data-menu-item class="byd2-button ${t.mute?'active':''}">MUTE</button><button data-action="solo" data-index="${i}" data-menu-item class="byd2-button ${t.solo?'active':''}">SOLO</button></div>
      <div class="byd2-xf-title">X-FADE</div>
      <div class="byd2-xf">${[1,2,3].map(c=>`<button data-action="xfade" data-index="${i}" data-choice="${c}" data-menu-item class="byd2-button byd2-xf-button ${t.xfade===c?'active':''}">${c}</button>`).join('')}</div>
      <div class="byd2-frequency"><button data-action="frequency-mode" data-index="${i}" data-menu-item class="byd2-button byd2-frequency-mode" aria-label="Loop, Frequency or Dropout mode"><span data-frequency-mode data-index="${i}">${t.frequencyMode==='loop'?'LOOP':t.frequencyMode==='dropout'?'DROPOUT':'FREQUENCY'}</span></button><div class="byd2-frequency-controls"><button data-action="frequency" data-index="${i}" data-menu-item class="byd2-button byd2-frequency-value" aria-label="Frequency or Dropout count"><b data-frequency-value data-index="${i}">${t.frequency??1}</b></button><button data-action="frequency-random" data-index="${i}" data-menu-item class="byd2-button byd2-frequency-random ${t.frequencyRandom?'active':''}" aria-pressed="${t.frequencyRandom?'true':'false'}">RND</button></div></div>
    </section>`).join('');

    const chars=[['age','AGE'],['hiss','HISS'],['wowFlutter','W & F']].map(([name,label])=>`<div class="byd2-global-row byd2-char-row"><span>${label}</span><input data-kind="character" data-reset="character" data-name="${name}" type="range" min="0" max="100" value="${Math.round(state.character[name]*100)}"></div>`).join('');

    this.root.innerHTML=`<div class="crt-screen byd-screen byd2-screen" data-dev-page="byd">
      <header data-dev-layer="design" data-dev-key="header" class="d8m4-zone-header" aria-label="Empty header placeholder"></header>
      <main class="d8m4-zone-main byd2-main">
        <div class="byd2-channel-row">${channels}</div>
        <section data-dev-layer="live" data-dev-key="character" class="byd2-panel byd2-character"><div class="byd2-panel-title">CHARACTER</div>${chars}<div class="byd2-tape"><span>TAPE TYPE</span><button data-action="tape" data-type="normal" data-menu-item class="byd2-button ${state.tapeType==='normal'?'active':''}">NORMAL</button><button data-action="tape" data-type="chrome" data-menu-item class="byd2-button ${state.tapeType==='chrome'?'active':''}">CHROME</button><button data-action="tape" data-type="metal" data-menu-item class="byd2-button ${state.tapeType==='metal'?'active':''}">METAL</button></div></section>
        <div class="byd2-page-nav byd2-page-nav-bottom"><button data-menu-item data-action="secondary-screen" data-screen="control-centre">FX STATION</button><button data-menu-item data-action="close-secondary">CLOSE</button></div>
      </main>
      <footer data-dev-layer="design" data-dev-key="footer" class="d8m4-zone-footer" aria-label="Empty footer placeholder"></footer>
    </div>`;
  }

  renderControlCentre(state) {
    const channelColors=['red','green','blue','yellow'];
    const enabledParams=state.fxMod.params||{intensity:true,reverb:true,width:true,tremolo:true,delay:true,filter:true};
    const channels=state.tracks.map((t,i)=>`<section data-dev-layer="live" data-dev-key="ch${i+1}" class="cc3-channel cc3-${channelColors[i]}">
      <div class="cc3-channel-title">CH${i+1}</div>
      <div class="cc3-param cc3-filter-only"><div class="cc3-param-head"><span>FILTER</span></div><div class="cc3-slider-wrap"><i class="cc3-mid" aria-hidden="true"></i><input class="cc3-slider" data-kind="track-filter" data-reset="track" data-param="filter" data-index="${i}" type="range" min="-100" max="100" value="${Math.round(t.filter*100)}"></div></div>
    </section>`).join('');
    const fx=['tremolo','delay','reverb','width'].map(name=>`<div class="cc3-effect-card cc3-fx-${name}"><div class="cc3-effect-top"><button data-action="effect" data-name="${name}" data-menu-item aria-pressed="${state.effects[name].enabled?'true':'false'}" class="cc3-label-toggle ${state.effects[name].enabled?'active':''}">${name==='tremolo'?'TREMOLO':name.toUpperCase()}</button></div><div class="cc3-effect-sliderline"><input class="${state.effects[name].enabled?'':'fx-off'}" data-kind="effect-level" data-reset="effect" data-name="${name}" type="range" min="0" max="100" value="${Math.round(state.effects[name].level*100)}"></div></div>`).join('');

    const fxTimeValue=(state.fxMod.timeMode||'01').replace(/^0/,'');
    const fxProbValue=String(state.fxMod.probMode||'x1').toUpperCase();
    const fxOptions=`<section class="cc3-panel cc3-fx-options-panel"><div class="cc3-fx-options-grid"><div class="cc3-fx-options-col"><div class="cc3-fx-options-title">TIME</div><div class="cc3-fx-options-value" data-fx-option-value="time">${fxTimeValue}</div><button data-action="fxmod-time" data-menu-item class="cc4-side-button cc3-fx-options-set">SET</button></div><div class="cc3-fx-options-col"><div class="cc3-fx-options-title">PROB</div><div class="cc3-fx-options-value" data-fx-option-value="prob">${fxProbValue}</div><button data-action="fxmod-prob" data-menu-item class="cc4-side-button cc3-fx-options-set">SET</button></div><button data-action="fxmod-reset" data-menu-item class="cc4-side-button cc4-reset-button cc3-fx-options-reset">RESET</button></div></section>`;
    const scope=`<section data-dev-layer="live" data-dev-key="scope" class="cc2-radar-panel ccv2-scope"><div class="cc2-fxmod-head"><span>FX SCOPE</span></div><div class="cc2-radar-zone"><div class="cc2-radar-wrap"><div class="cc2-radar" data-fxmod-pad role="slider" aria-label="FX Mod XY pad"><i class="cc2-radar-ring r1"></i><i class="cc2-radar-ring r2"></i><i class="cc2-radar-v"></i><i class="cc2-radar-h"></i><i class="cc2-radar-sweep"></i><i class="cc2-fxmod-nav" aria-label="FX Scope ship"></i></div></div></div><div class="cc2-fxmod-params"><div><b>X</b><button data-action="fxmod-param" data-param="intensity" data-menu-item class="cc2-param ${enabledParams.intensity!==false?'active':''}">INTENSITY</button><button data-action="fxmod-param" data-param="reverb" data-menu-item class="cc2-param ${enabledParams.reverb!==false?'active':''}">REVERB</button><button data-action="fxmod-param" data-param="width" data-menu-item class="cc2-param ${enabledParams.width!==false?'active':''}">WIDTH</button></div><div><b>Y</b><button data-action="fxmod-param" data-param="tremolo" data-menu-item class="cc2-param ${enabledParams.tremolo!==false?'active':''}">TREM</button><button data-action="fxmod-param" data-param="delay" data-menu-item class="cc2-param ${enabledParams.delay!==false?'active':''}">DELAY</button><button data-action="fxmod-param" data-param="filter" data-menu-item class="cc2-param ${enabledParams.filter!==false?'active':''}">FILTER</button></div></div></section>`;

    this.root.innerHTML=`<div class="crt-screen cc2-screen ccv2-screen cc3-screen" data-dev-page="cc">
      <header data-dev-layer="design" data-dev-key="header" class="d8m4-zone-header" aria-label="Empty header placeholder"></header>
      <main class="d8m4-zone-main cc3-main">
        <section data-dev-layer="live" data-dev-key="effects" class="cc3-panel cc3-effects"><div class="cc3-panel-title">EFFECTS</div><div class="cc3-effects-grid">${fx}</div><div class="cc3-intensity"><span>INTENSITY</span><div class="cc3-intensity-sliderline"><input data-kind="intensity" type="range" min="-50" max="50" value="${Math.round(state.intensity*50)}"></div></div></section>
        ${scope}
        ${fxOptions}
        <div class="cc3-channel-group-frame" aria-hidden="true"></div><div class="cc3-channel-row">${channels}</div>
        <div class="cc3-page-nav cc3-page-nav-bottom"><button data-menu-item data-action="secondary-screen" data-screen="byd">BUILD YOUR DRONE</button><button data-menu-item data-action="close-secondary">CLOSE</button></div>
      </main>
      <footer data-dev-layer="design" data-dev-key="footer" class="d8m4-zone-footer" aria-label="Empty footer placeholder"></footer>
    </div>`;
  }

  guideOrder() { return ['main','block','alien','mushroom']; }

  focusSelectedGuide() {
    const el=this.root.querySelector(`[data-guide-id="${this.selectedGuideId}"]`);
    if (el) el.focus({preventScroll:true});
  }

  moveGuideSelection(delta) {
    if (this.currentScreen!=='user-guides' || this.guideId) return;
    const ids=this.guideOrder();
    let i=Math.max(0,ids.indexOf(this.selectedGuideId));
    i=(i+delta+ids.length)%ids.length;
    this.selectedGuideId=ids[i];
    this.root.querySelectorAll('[data-guide-id]').forEach(el=>{
      const selected=el.dataset.guideId===this.selectedGuideId;
      el.classList.toggle('selected',selected); el.setAttribute('aria-current',selected?'true':'false');
    });
    this.focusSelectedGuide();
  }

  openSelectedGuide() {
    if (this.currentScreen!=='user-guides') return;
    if (this.guideId) { const back=this.root.querySelector('[data-action="guide-back"]'); back?.click(); return; }
    const el=this.root.querySelector(`[data-guide-id="${this.selectedGuideId}"]`);
    el?.click();
  }

  animateGuideManualOpen() {
    const stage = this.root.querySelector('[data-guide-manual-stage]');
    if (!stage) return;
    requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.add('is-open')));
  }

  renderGuides() {
    const guides={
      main:{title:'D8M4',subtitle:'DRONE MACHINE',identity:'red',asset:'assets/manuals/d84m-guide.png',unfoldAsset:'assets/manuals/d84m-guide-unfolded.png'},
      block:{title:'BLOCK BUSTER',subtitle:'USER GUIDE',identity:'green',asset:'assets/manuals/block-buster-guide.png'},
      alien:{title:'ALIEN ATTACK',subtitle:'USER GUIDE',identity:'blue',asset:'assets/manuals/alien-attack-guide.png'},
      mushroom:{title:'MUSHROOM RUN',subtitle:'USER GUIDE',identity:'yellow',asset:'assets/manuals/mushroom-run-guide.png'}
    };
    if (this.guideId) {
      const g=guides[this.guideId]||guides.main;
      if (this.guideId === 'main') {
        this.root.innerHTML=`<div class="crt-screen guides-screen guide-manual-screen guide-${g.identity}">
          <div class="guide-manual-stage" data-guide-manual-stage>
            <div class="guide-manual-topline">D84M USER GUIDE · SCROLL HORIZONTALLY TO READ</div>
            <div class="guide-manual-viewport">
              <div class="guide-manual-scroll" tabindex="0" aria-label="Scrollable unfolded D84M user guide">
                <div class="guide-manual-reveal">
                  <img class="guide-jcard-image" src="${g.unfoldAsset}" alt="Unfolded D84M user guide artwork" draggable="false">
                </div>
              </div>
            </div>
            <button class="guide-back guide-manual-back d8m4-menu-button" data-menu-item data-action="guide-back">[ BACK ]</button>
          </div>
        </div>`;
        queueMicrotask(()=>{ this.root.querySelector('[data-action="guide-back"]')?.focus({preventScroll:true}); this.animateGuideManualOpen(); });
        return;
      }
      this.root.innerHTML=`<div class="crt-screen guides-screen guide-holding guide-${g.identity}">
        <div class="guide-holding-copy"><div class="guide-holding-title">${g.title}</div><div class="guide-holding-subtitle">${g.subtitle}</div><div class="guide-holding-kicker">USER GUIDE</div><div class="guide-holding-rule"></div><div class="guide-holding-text">OPERATING INSTRUCTIONS</div><div class="guide-holding-soon">COMING SOON</div><button class="guide-back d8m4-menu-button" data-menu-item data-action="guide-back">[ BACK ]</button></div>
      </div>`;
      queueMicrotask(()=>this.root.querySelector('[data-action="guide-back"]')?.focus({preventScroll:true}));
      return;
    }
    const cards=this.guideOrder().map(id=>{const g=guides[id],selected=id===this.selectedGuideId;return `<button class="guide-cassette ${selected?'selected':''}" data-menu-item data-action="guide" data-id="${id}" data-guide-id="${id}" aria-label="Open ${g.title} user guide" aria-current="${selected?'true':'false'}"><img src="${g.asset}" alt="${g.title} user guide cassette artwork" draggable="false"></button>`}).join('');
    this.root.innerHTML=`<div class="crt-screen guides-screen guides-library">
      <div class="guides-header"><img src="assets/manuals/user-guides-header.png" alt="USER GUIDES"></div>
      <div class="guides-prompt">Please select your user guide:</div>
      <div class="guide-cassette-grid">${cards}</div>
      ${this.overlayFooter('user-guides')}
    </div>`;
    queueMicrotask(()=>this.focusSelectedGuide());
  }

  renderTV(state) {
    const filename=`D8M4_${state.soundscape.id}_TV.mp4`;
    this.root.innerHTML=`<div class="crt-screen missing-screen"><div class="missing-big">MISSING ASSET</div><div class="missing-file">${filename}</div><div class="missing-note">TV MODE · ${state.frs.toUpperCase()} ${state.frs==='focus'?'100':state.frs==='relax'?'75':'50'}%</div>${this.baseFooter('tv')}</div>`;
  }

  gameOrder() { return ['block','alien','mushroom','adventure']; }

  moveGameSelection(delta) {
    if (this.currentScreen !== 'game-placeholder' || this.gameLaunchId) return;
    const ids=this.gameOrder();
    let i=Math.max(0,ids.indexOf(this.selectedGameId));
    i=(i+delta+ids.length)%ids.length;
    this.selectedGameId=ids[i];
    this.updateGameMenuSelection();
    this.root.querySelector(`[data-game-id="${this.selectedGameId}"]`)?.focus({preventScroll:true});
  }

  updateGameMenuSelection() {
    this.root.querySelectorAll('[data-game-id]').forEach(el=>{
      const selected=el.dataset.gameId===this.selectedGameId;
      el.classList.toggle('selected',selected);
      el.setAttribute('aria-current',selected?'true':'false');
    });
  }

  updateGameMenuOptions() {
    this.root.querySelectorAll('[data-action="game-loading-screens"]').forEach(el=>{
      const active=(el.dataset.value==='on')===this.gameLoadingScreens;
      el.classList.toggle('active',active); el.setAttribute('aria-pressed',active?'true':'false');
    });
  }

  handleGameEvent(event) {
    if (!event?.type) return;
    if (event.type === 'colour-event') {
      this.controller.triggerGameAutoMixColor(event.colour, `game:${event.game}`);
      return;
    }
    if (event.type === 'colour-cleared') {
      this.controller.triggerGameAutoMixColorCleared(event.colour, `game:${event.game}:cleared`);
      return;
    }
    if (event.type === 'life-lost') {
      this.controller.triggerSpecialEvent(`game:${event.game}:life-lost`);
      return;
    }
    if (event.type === 'stage-complete') {
      this.controller.triggerSpecialEvent(`game:${event.game}:stage-${event.level ?? 'complete'}-complete`);
      return;
    }
    if (event.type === 'game-over') {
      this.controller.triggerSpecialEvent(`game:${event.game}:game-over`);
      return;
    }
    if (event.type === 'special-enemy-killed' && event.game === 'mushroom') {
      this.controller.triggerSpecialEvent(`game:mushroom:${event.enemy}`);
    }
  }

  launchSelectedGame() {
    if (this.currentScreen !== 'game-placeholder') return;
    if (this.gameLoaderActive) { this.finishGameLoader(); return; }
    if (this.gameLaunchId) { this.gameRuntime.fire(); return; }
    if (this.selectedGameId === 'adventure') {
      this.adventurePlaceholder=true;
      this.render(this.store.getState(), true);
      return;
    }
    if (this.gameLoadingScreens) {
      this.gamePendingLaunchId = this.selectedGameId;
      this.gameLoaderActive = true;
      this.render(this.store.getState(), true);
      return;
    }
    this.gameLaunchId=this.selectedGameId;
    this.controller.setGameSpecialEventControl(true);
    this.render(this.store.getState(), true);
  }

  finishGameLoader() {
    if (!this.gameLoaderActive) return;
    const id=this.gamePendingLaunchId || this.selectedGameId;
    const video=this.root.querySelector('[data-game-loader-video]');
    if (video) { try { video.pause(); } catch {} }
    this.gameRuntime.stopLoaderSound?.();
    this.gameLoaderActive=false;
    this.gamePendingLaunchId=null;
    this.gameLaunchId=id;
    this.controller.setGameSpecialEventControl(true);
    this.render(this.store.getState(), true);
  }

  setGameKey(name, pressed) {
    if (this.currentScreen !== 'game-placeholder' || !this.gameLaunchId) return false;
    this.gameRuntime.setKey(name, pressed);
    return true;
  }

  startGame() {
    if (this.currentScreen !== 'game-placeholder' || !this.gameLaunchId) return false;
    this.gameRuntime.start();
    return true;
  }

  pauseGame() {
    if (this.currentScreen !== 'game-placeholder' || !this.gameLaunchId) return false;
    this.gameRuntime.pause();
    return true;
  }

  toggleGamePause() {
    if (this.currentScreen !== 'game-placeholder' || !this.gameLaunchId) return false;
    this.gameRuntime.togglePause();
    return true;
  }

  stopGame() {
    if (this.currentScreen !== 'game-placeholder' || !this.gameLaunchId) return false;
    this.gameRuntime.stop();
    return true;
  }

  handlePhysicalModeButton(mode) {
    if (mode !== 'game-placeholder' && mode !== 'tv') return false;

    // If a game is actively running, either physical mode button uses the
    // existing leave-game confirmation. The chosen button becomes the exit
    // destination if the user confirms.
    if (this.currentScreen === 'game-placeholder' && this.gameLaunchId) {
      this.requestGameExitConfirmation(mode);
      return true;
    }

    // Pressing the already-selected mode while sitting on its menu disengages
    // that mode and returns to Welcome. Pressing the other mode switches menus
    // immediately. Secondary overlays are dismissed by the physical controls.
    if (this.currentScreen === mode) {
      this.controller.showBaseScreenFromPhysical('welcome');
      return true;
    }

    this.controller.showBaseScreenFromPhysical(mode);
    return true;
  }

  handlePhysicalGameButton() { return this.handlePhysicalModeButton('game-placeholder'); }
  handlePhysicalTVButton() { return this.handlePhysicalModeButton('tv'); }

  requestGameExitConfirmation(destination = 'game-placeholder') {
    if (this.currentScreen !== 'game-placeholder' || !this.gameLaunchId || this.gameExitConfirm) return false;
    this.gameExitDestination = destination === 'tv' ? 'tv' : 'game-placeholder';
    this.gameExitConfirm = true;
    this.gameExitWasPaused = this.gameRuntime.isPaused();
    this.gameExitPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!this.gameExitWasPaused) this.gameRuntime.pause();
    const screen = this.root.querySelector('.game-play-screen');
    if (!screen) return false;
    const overlay = document.createElement('div');
    overlay.className = 'game-exit-overlay';
    overlay.innerHTML = `<div class="game-exit-shade" aria-hidden="true"></div><div class="game-exit-dialog" role="dialog" aria-modal="true" aria-labelledby="game-exit-title"><div id="game-exit-title" class="game-exit-title">DO YOU WANT TO LEAVE THE GAME?</div><div class="game-exit-actions"><button class="game-exit-button yes" data-menu-item data-action="game-exit-yes">YES</button><button class="game-exit-button cancel" data-menu-item data-action="game-exit-cancel">CANCEL</button></div></div>`;
    screen.appendChild(overlay);
    queueMicrotask(() => overlay.querySelector('[data-action="game-exit-cancel"]')?.focus({ preventScroll:true }));
    return true;
  }

  cancelGameExit() {
    if (!this.gameExitConfirm) return;
    this.root.querySelector('.game-exit-overlay')?.remove();
    this.gameExitConfirm = false;
    if (!this.gameExitWasPaused) this.gameRuntime.start();
    this.updateGamePlayControls();
    const focus = this.gameExitPreviousFocus;
    this.gameExitPreviousFocus = null;
    queueMicrotask(() => focus?.focus?.({ preventScroll:true }));
  }

  confirmGameExit() {
    if (!this.gameExitConfirm) return;
    const destination = this.gameExitDestination || 'game-placeholder';
    this.root.querySelector('.game-exit-overlay')?.remove();
    this.gameExitConfirm = false;
    this.gameExitWasPaused = false;
    this.gameExitPreviousFocus = null;
    this.gameRuntime.detach();
    this.controller.setGameSpecialEventControl(false);
    this.gameLoaderActive = false;
    this.gamePendingLaunchId = null;
    this.gameLaunchId = null;
    this.gameExitDestination = 'game-placeholder';
    if (destination === 'tv') {
      this.controller.showBaseScreenFromPhysical('tv');
      return;
    }
    this.render(this.store.getState(), true);
    queueMicrotask(() => this.root.querySelector(`[data-game-id="${this.selectedGameId}"]`)?.focus({ preventScroll:true }));
  }

  openGameAwareSecondary(screen) {
    if(!['byd','control-centre','user-guides'].includes(screen)) return;
    const state=this.store.getState();
    const gameIsActive=state.display.baseScreen==='game-placeholder' && (Boolean(this.gameLaunchId) || this.gameLoaderLoopActive);
    if(!gameIsActive){ this.controller.toggleSecondaryScreen(screen); return; }
    const current=state.display.secondary;
    if(current===screen){ this.closeGameAwareSecondary(); return; }
    if(!this.gameSecondaryActive){
      this.gameSecondaryActive=true;
      this.gameSecondaryPausedByUs=!this.gameRuntime.isDemoMode();
      if(this.gameSecondaryPausedByUs) this.gameRuntime.pause();
    }
    this.controller.toggleSecondaryScreen(screen);
  }

  closeGameAwareSecondary() {
    const state=this.store.getState();
    const returningToGame=state.display.baseScreen==='game-placeholder' && (Boolean(this.gameLaunchId) || this.gameLoaderLoopActive);
    this.controller.closeSecondaryScreen();
    if(returningToGame){
      const resumeWithCountdown=Boolean(this.gameLaunchId) && this.gameSecondaryPausedByUs;
      this.gameSecondaryActive=false;
      this.gameSecondaryPausedByUs=false;
      setTimeout(()=>{
        if(this.gameLaunchId){
          const canvas=this.root.querySelector('[data-game-canvas]');
          if(canvas) this.gameRuntime.rebindCanvas(canvas);
          if(resumeWithCountdown) this.gameRuntime.resumeWithReadyCountdown();
          this.updateGamePlayControls();
        }
      },0);
    }
  }

  loaderLoopPaths() {
    return [
      'assets/video/loaders/D8M4_GAME_BLOCKBUSTER_LOADING.mp4',
      'assets/video/loaders/D8M4_GAME_ALIENATTACK_LOADING.mp4',
      'assets/video/loaders/D8M4_GAME_MUSHROOMRUN_LOADING.mp4'
    ];
  }

  ensureLoaderLoopVideo() {
    if (this.gameLoaderLoopVideo?.isConnected) return this.gameLoaderLoopVideo;
    const mainCrt=this.root.closest('.main-crt');
    if(!mainCrt) return null;

    const host=document.createElement('div');
    host.className='game-loader-persistent-host';
    const video=document.createElement('video');
    video.className='game-loader-video game-loader-persistent-video';
    video.autoplay=true;
    video.playsInline=true;
    video.preload='auto';
    video.muted=false;
    video.volume=1;
    try { video.disablePictureInPicture=true; } catch {}
    video.setAttribute('disablePictureInPicture','');
    video.setAttribute('controlsList','nodownload noplaybackrate noremoteplayback');

    host.appendChild(video);
    mainCrt.insertBefore(host, this.root);
    this.gameLoaderLoopHost=host;
    this.gameLoaderLoopVideo=video;
    this.gameRuntime.attachLoaderVideo?.(video);

    video.addEventListener('timeupdate',()=>{
      // The loading artwork is fully resolved at about 51 s in all three
      // supplied MP4s. Hold the completed screen/beep for ~5 s, then advance.
      if(this.gameLoaderLoopActive && !this.gameLoaderLoopPaused && video.currentTime >= 56){
        this.advanceLoaderLoop();
      }
    });
    video.addEventListener('ended',()=>{
      if(this.gameLoaderLoopActive) this.advanceLoaderLoop();
    });
    return video;
  }

  playLoaderLoopIndex() {
    const video=this.ensureLoaderLoopVideo();
    if(!video) return;
    const paths=this.loaderLoopPaths();
    video.src=paths[this.gameLoaderLoopIndex % paths.length];
    video.currentTime=0;
    video.muted=false;
    video.volume=1;
    this.gameRuntime.attachLoaderVideo?.(video);
    if(!this.gameLoaderLoopPaused){
      const attempt=video.play();
      if(attempt?.catch) attempt.catch(()=>{});
    }
  }

  advanceLoaderLoop() {
    if(!this.gameLoaderLoopActive) return;
    this.gameLoaderLoopIndex=(this.gameLoaderLoopIndex+1)%this.loaderLoopPaths().length;
    this.playLoaderLoopIndex();
  }

  startLoaderLoop() {
    this.gameLoaderLoopActive=true;
    this.gameLoaderLoopPaused=false;
    this.gameLoaderLoopIndex=0;
    this.playLoaderLoopIndex();
    this.render(this.store.getState(), true);
  }

  toggleLoaderLoopPause() {
    if(!this.gameLoaderLoopActive) return;
    const video=this.ensureLoaderLoopVideo();
    if(!video) return;
    this.gameLoaderLoopPaused=!this.gameLoaderLoopPaused;
    if(this.gameLoaderLoopPaused){
      try{ video.pause(); }catch{}
    }else{
      const attempt=video.play();
      if(attempt?.catch) attempt.catch(()=>{});
    }
    const btn=this.root.querySelector('[data-action="game-loader-loop-pause"]');
    if(btn) btn.textContent=this.gameLoaderLoopPaused?'RESUME':'PAUSE';
  }

  closeLoaderLoop() {
    const video=this.gameLoaderLoopVideo;
    try{ video?.pause(); }catch{}
    this.gameRuntime.stopLoaderSound?.();
    this.gameLoaderLoopActive=false;
    this.gameLoaderLoopPaused=false;
    this.gameLoaderLoopIndex=0;
    try{ this.gameLoaderLoopHost?.remove(); }catch{}
    this.gameLoaderLoopHost=null;
    this.gameLoaderLoopVideo=null;
    this.render(this.store.getState(), true);
  }

  updateGamePlayControls() {
    const demo=this.gameRuntime.isDemoMode();
    const paused=this.gameRuntime.isPaused();
    const demoBtn=this.root.querySelector('[data-action="game-demo-toggle"]');
    const pauseBtn=this.root.querySelector('[data-action="game-pause-local"]');
    if(demoBtn){demoBtn.classList.toggle('active',demo);demoBtn.setAttribute('aria-pressed',demo?'true':'false');demoBtn.textContent=demo?'LIVE PLAY':'DEMO MODE';}
    if(pauseBtn){pauseBtn.classList.toggle('active',paused);pauseBtn.setAttribute('aria-pressed',paused?'true':'false');pauseBtn.textContent=paused?'RESUME':'PAUSE';}
  }

  renderGamePlaceholder() {
    const games={
      block:{title:'BLOCK',title2:'BUSTER',asset:'assets/games/rc188/block-buster-card-square.png'},
      alien:{title:'ALIEN',title2:'ATTACK',asset:'assets/games/rc188/alien-attack-card-square.png'},
      mushroom:{title:'MUSHROOM',title2:'RUN',asset:'assets/games/rc188/mushroom-run-card-square.png'},
      adventure:{title:'ADVENTURE',title2:'MODE',asset:'assets/games/rc188/adventure-mode-card.png'}
    };
    if(this.gameLoaderLoopActive){
      this.ensureLoaderLoopVideo();
      this.root.innerHTML=`<div class="crt-screen d8m4-game-screen game-loader-screen game-loader-loop-screen">
        <div class="game-loader-loop-controls">
          <button class="game-loader-close d8m4-menu-button" data-menu-item data-action="game-loader-loop-close">CLOSE</button>
          <button class="game-loader-pause d8m4-menu-button" data-menu-item data-action="game-loader-loop-pause">${this.gameLoaderLoopPaused?'RESUME':'PAUSE'}</button>
        </div>
      </div>`;
      return;
    }
    if(this.adventurePlaceholder){
      const story=`Welcome to the tranquil planet AMBIENT, a world where peace and harmony rules.

At least it did until the evil humanoid robots descended to disturb the peace!

There is only one way to defeat these robots...and that is to chill them out!

Are you ready to create a soundscape to save our planet? 

Select a button to begin your adventure and please help us...you're our only hope!!!`;
      this.root.innerHTML=`<div class="crt-screen game-adventure-placeholder">
        <img class="welcome-art game-adventure-bg" src="assets/visuals/d8m4-welcome-background-only.png" alt="" aria-hidden="true">
        <div class="game-adventure-title">ADVENTURE MODE</div>
        <div class="game-adventure-story">${story.replace(/\n/g,'<br>')}</div>
        <div class="game-adventure-buttons">
          <button data-menu-item data-action="secondary-screen" data-screen="byd">BUILD YOUR DRONE</button>
          <button data-menu-item data-action="secondary-screen" data-screen="control-centre">FX STATION</button>
          <button data-menu-item data-action="base-screen" data-screen="tv">TV MODE</button>
          <button data-menu-item data-action="game-adventure-back">GAME MODE</button>
          <button data-menu-item data-action="secondary-screen" data-screen="user-guides">USER GUIDES</button>
        </div>
      </div>`;
      return;
    }
    if(this.gameLoaderActive){
      const loaderId=this.gamePendingLaunchId || this.selectedGameId;
      const g=games[loaderId]||games.block;
      const loaderPaths={
        block:'assets/video/loaders/D8M4_GAME_BLOCKBUSTER_LOADING.mp4',
        alien:'assets/video/loaders/D8M4_GAME_ALIENATTACK_LOADING.mp4',
        mushroom:'assets/video/loaders/D8M4_GAME_MUSHROOMRUN_LOADING.mp4'
      };
      const src=loaderPaths[loaderId]||loaderPaths.block;
      this.root.innerHTML=`<div class="crt-screen d8m4-game-screen game-loader-screen">
        <video class="game-loader-video" data-game-loader-video src="${src}" autoplay playsinline preload="auto" disablePictureInPicture controlsList="nodownload noplaybackrate noremoteplayback" aria-label="${g.title} ${g.title2} loading screen"></video>
      </div>`;
      queueMicrotask(()=>{
        const video=this.root.querySelector('[data-game-loader-video]');
        if(!video)return;
        video.muted=false; video.volume=1;
        this.gameRuntime.attachLoaderVideo?.(video);
        video.addEventListener('ended',()=>this.finishGameLoader(),{once:true});
        video.addEventListener('error',()=>this.finishGameLoader(),{once:true});
        const attempt=video.play();
        if(attempt?.catch)attempt.catch(()=>{});
      });
      return;
    }
    if(this.gameLaunchId){
      const g=games[this.gameLaunchId]||games.block;
      this.root.innerHTML=`<div class="crt-screen d8m4-game-screen game-play-screen game-${this.gameLaunchId}">
        <canvas class="d8m4-game-canvas" data-game-canvas width="760" height="470" aria-label="${g.title} ${g.title2} game"></canvas>
        <button class="game-menu-back d8m4-menu-button game-play-demo" data-menu-item data-action="game-demo-toggle" aria-pressed="false">DEMO MODE</button>
        <button class="game-menu-back d8m4-menu-button game-play-pause" data-menu-item data-action="game-pause-local" aria-pressed="false">PAUSE</button>
        <button class="game-menu-back d8m4-menu-button game-play-back" data-menu-item data-action="game-back-menu">GAME MENU</button>
      </div>`;
      queueMicrotask(()=>{
        const canvas=this.root.querySelector('[data-game-canvas]');
        if(this.gameRuntime.game && this.gameRuntime.gameId===this.gameLaunchId) this.gameRuntime.rebindCanvas(canvas);
        else this.gameRuntime.attach(this.gameLaunchId, canvas);
        this.updateGamePlayControls();
      });
      return;
    }
    const cards=this.gameOrder().map(id=>{const g=games[id];return `<button class="game-card game-card-${id} ${id===this.selectedGameId?'selected':''}" data-menu-item data-action="game-select" data-game-id="${id}" aria-label="Select ${g.title} ${g.title2}" aria-current="${id===this.selectedGameId?'true':'false'}"><img src="${g.asset}" alt="${g.title} ${g.title2}" draggable="false"></button>`}).join('');
    this.root.innerHTML=`<div class="crt-screen d8m4-game-screen game-menu-screen">
      <img class="game-bg-layer" src="assets/visuals/d8m4-game-background-reference.png" alt="" aria-hidden="true">
      <div class="game-menu-live">
        <div class="game-cards-layer">${cards}</div>
        <div class="game-live-toggles" aria-label="Game Mode options">
          <div class="game-option-label game-option-label-screens">SPECCY LOADING SCREENS</div>
          <div class="game-option-label game-option-label-loop">LOADING SCREEN LOOP</div>
          <button data-menu-item data-action="game-loading-screens" data-value="on" class="game-option-button game-load-on ${this.gameLoadingScreens?'active':''}" aria-pressed="${this.gameLoadingScreens?'true':'false'}">ON</button>
          <button data-menu-item data-action="game-loading-screens" data-value="off" class="game-option-button game-load-off ${!this.gameLoadingScreens?'active':''}" aria-pressed="${!this.gameLoadingScreens?'true':'false'}">OFF</button>
          <button data-menu-item data-action="game-loading-loop" class="game-option-button game-loop-play">PLAY</button>
        </div>
      </div>
    </div>`;
    queueMicrotask(()=>{this.updateGameMenuSelection();this.updateGameMenuOptions();this.root.querySelector(`[data-game-id="${this.selectedGameId}"]`)?.focus({preventScroll:true});});
  }

  renderIdle(state) { this.renderWelcome(state); }

}