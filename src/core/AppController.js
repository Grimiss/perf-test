import { OperationGate } from "./OperationGate.js";
import { AutomationManager } from "../automation/AutomationManager.js";
import { SpecialEventManager } from "../automation/SpecialEventManager.js";
import { FxModManager } from "../automation/FxModManager.js";

export class AppController {
  constructor({ store, audioEngine, repository, soundscape }) {
    this.store = store;
    this.audioEngine = audioEngine;
    this.repository = repository;
    this.soundscape = soundscape;
    this.playGate = new OperationGate();
    this.soundscapeGate = new OperationGate();
    this.loadingPromise = null;
    // Batch FX Scope state writes to one store update per animation frame.
    // Audio parameters still update immediately; this prevents CRT patching
    // many times for one visual marker position.
    this.fxModFrameRequest = null;
    this.fxModPendingTracks = new Map();
    this.fxModPendingEffects = new Map();
    this.fxModPendingGlobals = new Map();
    this.fxModPendingStatus = null;
    this.automation = new AutomationManager({
      store,
      applyValue: (id, value) => this.#applyAutomationValue(id, value),
      onStatus: (patch) => this.#updateAutomationStatus(patch)
    });
    this.specialEvent = new SpecialEventManager({
      readLevel: (name) => this.store.getState().effects[name]?.level ?? 0,
      applyLevel: (name, value) => this.#applySpecialEffectLevel(name, value),
      suspendAutomation: (id) => this.automation.suspend(id),
      resumeAutomation: (id) => this.automation.resume(id),
      onStatus: (patch) => this.#updateSpecialEventStatus(patch)
    });
    this.fxMod = new FxModManager({
      store,
      apply: (id, value) => this.#applyFxModValue(id, value),
      suspend: (id) => this.automation.suspend(id),
      resume: (id) => this.automation.resume(id),
      onStatus: (patch) => this.#updateFxModStatus(patch)
    });
  }

  async play(options = {}) {
    const state = this.store.getState();
    if (state.transport.status === "playing") return;
    const token = this.playGate.begin();
    try {
      this.#setMessage(state.soundscape.loaded ? "Starting playback…" : `Initialising audio and loading ${state.soundscape.id}…`);
      await this.audioEngine.init();
      this.#updateContextState();
      if (!this.store.getState().soundscape.loaded) {
        if (!this.loadingPromise) this.loadingPromise = this.audioEngine.loadSoundscape(this.soundscape);
        await this.loadingPromise;
        this.loadingPromise = null;
        if (!this.playGate.isCurrent(token)) return;
        this.store.update((draft) => {
          draft.soundscape.loaded = true;
          draft.soundscape.loading = false;
          draft.soundscape.error = null;
          draft.dev.engineStatus = "ready";
        }, { reason: "soundscape-loaded" });
        this.#syncTrackStateToEngine();
        this.#syncProcessingStateToEngine();
        this.automation.resetBaselines();
      }
      if (!this.playGate.isCurrent(token)) return;
      const wasStopped = state.transport.status === "stopped";
      const playOptions = { ...options };
      const rampEnabled = state.transport.rampEnabled !== false;
      if (wasStopped && playOptions.startupRateRampSeconds == null) playOptions.startupRateRampSeconds = rampEnabled ? 0.6 : 0;
      if (!wasStopped) playOptions.startupRateRampSeconds = 0;
      this.audioEngine.play(playOptions);
      this.store.update((draft) => {
        draft.transport.status = "playing";
        draft.boot.phase = "running";
        draft.dev.message = `Playing ${draft.soundscape.id}. Auto Mix ${draft.autoMix.enabled ? "active" : "off"}.`;
      }, { reason: "play" });
      this.automation.onTransport("playing");
      this.fxMod.onTransport("playing");
    } catch (error) {
      this.loadingPromise = null;
      this.#handleError(error);
    }
  }

  async pause() {
    this.playGate.invalidate();
    if (this.store.getState().transport.status !== "playing") return;
    this.automation.onTransport("paused");
    this.fxMod.onTransport("paused");
    const completed = await this.audioEngine.pause();
    if (!completed) return;
    this.store.update((draft) => {
      draft.transport.status = "paused";
      draft.dev.message = "Paused. Auto Mix is paused too; PLAY resumes from the current evolved mix.";
    }, { reason: "pause" });
  }

  async stop() {
    this.playGate.invalidate();
    this.automation.onTransport("stopped");
    this.fxMod.onTransport("stopped");
    if (this.audioEngine.context) {
      const rampEnabled = this.store.getState().transport.rampEnabled !== false;
      const completed = await this.audioEngine.stop({ fade: rampEnabled, rateRampSeconds: 0.6 });
      if (!completed) return;
    }
    this.store.update((draft) => {
      draft.transport.status = "stopped";
      draft.dev.message = `Stopped. Mix values are preserved; next PLAY starts ${draft.soundscape.id} from zero.`;
    }, { reason: "stop" });
  }

  async selectSoundscape(id) {
    const current = this.store.getState();
    if (!current.availableSoundscapes.includes(id)) return;
    if (id === current.soundscape.id || current.soundscape.loading) return;
    const token = this.soundscapeGate.begin();
    const priorTransport = current.transport.status;
    this.specialEvent.cancel({ restore: true });
    this.automation.onSoundscapeChanging();
    this.store.update((draft) => {
      draft.soundscape.loading = true;
      draft.soundscape.error = null;
      draft.dev.message = `Loading ${id}…`;
    }, { reason: "soundscape-loading" });
    try {
      const preset = await this.repository.getSoundscape(id);
      if (!this.soundscapeGate.isCurrent(token)) return;

      if (!this.audioEngine.context) await this.audioEngine.init();
      if (this.store.getState().soundscape.loaded) await this.audioEngine.switchSoundscape(preset);
      else await this.audioEngine.loadSoundscape(preset);
      if (!this.soundscapeGate.isCurrent(token)) return;

      this.soundscape = preset;
      this.store.update((draft) => {
        draft.soundscape.id = preset.id;
        draft.soundscape.name = preset.name;
        draft.soundscape.loaded = true;
        draft.soundscape.loading = false;
        draft.soundscape.error = null;
        draft.tracks = preset.tracks.map((track, index) => ({
          name: track.name,
          assetId: track.assetId,
          volume: track.volume,
          pan: track.pan ?? 0,
          filter: track.filter ?? 0,
          mute: false,
          solo: false,
          xfade: track.xfade ?? 1,
          frequency: Math.max(1, Math.min(10, Number(track.frequency) || 1)),
          frequencyMode: ["loop", "frequency", "dropout"].includes(track.frequencyMode) ? track.frequencyMode : "loop",
          frequencyRandom: Boolean(track.frequencyRandom),
          loaded: true,
          duration: this.audioEngine.tracks[index]?.buffer?.duration ?? 0
        }));
        draft.effects = structuredClone(preset.effects);
        draft.character = structuredClone(preset.character);
        draft.tapeType = preset.tapeType;
        draft.frs = preset.frs;
        draft.intensity = preset.intensity;
        draft.fxMod.enabled = preset.fxMod?.enabled ?? draft.fxMod.enabled;
        draft.fxMod.hold = preset.fxMod?.hold ?? draft.fxMod.hold ?? "normal";
        draft.fxMod.timeMode = preset.fxMod?.timeMode ?? draft.fxMod.timeMode ?? "01";
        draft.fxMod.probMode = preset.fxMod?.probMode ?? draft.fxMod.probMode ?? "x1";
        draft.fxMod.memoryX = preset.fxMod?.memoryX ?? 0;
        draft.fxMod.memoryY = preset.fxMod?.memoryY ?? 0;
        draft.fxMod.trajectory = Array.isArray(preset.fxMod?.trajectory) ? preset.fxMod.trajectory.map((p) => ({ t: Number(p?.t) || 0, x: Number(p?.x) || 0, y: Number(p?.y) || 0 })) : [];
        draft.fxMod.releaseVelocity = { x: Number(preset.fxMod?.releaseVelocity?.x) || 0, y: Number(preset.fxMod?.releaseVelocity?.y) || 0 };
        draft.fxMod.params = {intensity:true,reverb:true,width:true,tremolo:true,delay:true,filter:true,...(preset.fxMod?.params||draft.fxMod.params||{})};
        draft.transport.status = priorTransport;
        draft.autoMix.lastMove = "—";
        draft.autoMix.moving = [];
        draft.dev.engineStatus = "ready";
        draft.dev.message = priorTransport === "playing" ? `Switched to ${preset.id} while playing.` : `${preset.id} loaded.`;
      }, { reason: "soundscape-selected" });
      this.#syncTrackStateToEngine();
      this.#syncProcessingStateToEngine();
      this.automation.onSoundscapeChanged();
      this.fxMod.setEnabled(this.store.getState().fxMod.enabled);
    } catch (error) {
      this.store.update((draft) => { draft.soundscape.loading = false; }, { reason: "soundscape-loading-failed" });
      if (priorTransport === "playing" && this.store.getState().autoMix.enabled) this.automation.onTransport("playing");
      this.#handleError(error);
    }
  }

  setTrackVolume(index, value) { this.#setTrackParam(index, "volume", Math.max(0, Math.min(1, Number(value))), "manual"); }
  setTrackPan(index, value) { this.#setTrackParam(index, "pan", Math.max(-1, Math.min(1, Number(value))), "manual"); }
  setTrackFilter(index, value) { this.#setTrackParam(index, "filter", Math.max(-1, Math.min(1, Number(value))), "manual"); }

  #setTrackParam(index, param, value, source = "manual") {
    this.store.update((draft) => { draft.tracks[index][param] = value; }, { reason: source === "manual" ? `track-${param}` : `automix-track-${param}` });
    if (this.store.getState().soundscape.loaded) this.audioEngine.setTrackParam(index, param, value);
    if (source === "manual") this.automation.manualIntervention(`track:${index}:${param}`, value);
  }

  toggleMute(index) {
    this.store.update((draft) => { draft.tracks[index].mute = !draft.tracks[index].mute; }, { reason: "track-mute" });
    this.#applyMuteSolo();
    for (const param of ["volume", "pan", "filter"]) this.automation.eligibilityChanged(`track:${index}:${param}`);
  }

  toggleSolo(index) {
    this.store.update((draft) => { draft.tracks[index].solo = !draft.tracks[index].solo; }, { reason: "track-solo" });
    this.#applyMuteSolo();
  }

  toggleXFade(index, choice) {
    const next = Math.max(1, Math.min(3, Number(choice) || 1));
    this.store.update((draft) => { draft.tracks[index].xfade = next; }, { reason: "track-xfade" });
    if (this.store.getState().soundscape.loaded) this.audioEngine.setXFade(index, next);
  }

  cycleTrackFrequency(index) {
    const current = Math.max(1, Math.min(10, Number(this.store.getState().tracks[index]?.frequency) || 1));
    const next = current >= 10 ? 1 : current + 1;
    this.store.update((draft) => { draft.tracks[index].frequency = next; }, { reason: "track-frequency" });
    if (this.store.getState().soundscape.loaded) this.audioEngine.setTrackFrequency(index, next);
  }

  toggleTrackFrequencyMode(index) {
    const raw = this.store.getState().tracks[index]?.frequencyMode;
    const current = ["loop", "frequency", "dropout"].includes(raw) ? raw : "frequency";
    const next = current === "loop" ? "frequency" : current === "frequency" ? "dropout" : "loop";
    this.store.update((draft) => { draft.tracks[index].frequencyMode = next; }, { reason: "track-frequency-mode" });
    if (this.store.getState().soundscape.loaded) this.audioEngine.setTrackFrequencyMode(index, next);
  }

  toggleTrackFrequencyRandom(index) {
    const next = !Boolean(this.store.getState().tracks[index]?.frequencyRandom);
    this.store.update((draft) => { draft.tracks[index].frequencyRandom = next; }, { reason: "track-frequency-random" });
    if (this.store.getState().soundscape.loaded) this.audioEngine.setTrackFrequencyRandom(index, next);
  }

  setCharacter(name, value) {
    const safe = Math.max(0, Math.min(1, Number(value)));
    this.store.update((draft) => { draft.character[name] = safe; }, { reason: `character-${name}` });
    if (this.audioEngine.context) this.audioEngine.setCharacter(name, safe);
    this.automation.manualIntervention(`character:${name}`, safe);
  }

  setTapeType(type) {
    if (!["normal", "chrome", "metal"].includes(type)) return;
    this.store.update((draft) => { draft.tapeType = type; }, { reason: "tape-type" });
    if (this.audioEngine.context) this.audioEngine.setTapeType(type);
  }

  setEffectLevel(name, value) {
    const safe = Math.max(0, Math.min(1, Number(value)));
    this.store.update((draft) => { draft.effects[name].level = safe; }, { reason: `effect-${name}-level` });
    if (this.audioEngine.context) this.audioEngine.setEffect(name, { level: safe });
    this.automation.manualIntervention(`effect:${name}`, safe);
  }

  toggleEffect(name) {
    const current = this.store.getState().effects[name];
    if (!current) return;
    const enabled = !current.enabled;
    this.store.update((draft) => { draft.effects[name].enabled = enabled; }, { reason: `effect-${name}-enabled` });
    if (this.audioEngine.context) this.audioEngine.setEffect(name, { enabled });
    this.automation.eligibilityChanged(`effect:${name}`);
  }

  setMasterTone(value) {
    const safe = Math.max(-1, Math.min(1, Number(value)));
    this.store.update((draft) => { draft.master.tone = safe; }, { reason: "master-tone" });
    if (this.audioEngine.context) this.audioEngine.setMasterTone(safe);
  }

  setMainVolume(value) {
    const safe = Math.max(0, Math.min(1, Number(value)));
    this.store.update((draft) => { draft.master.volume = safe; }, { reason: "main-volume" });
    if (this.audioEngine.context) this.audioEngine.setMainVolume(this.store.getState().master.muted ? 0 : safe);
  }

  toggleMasterMute() {
    const next = !Boolean(this.store.getState().master.muted);
    this.store.update((draft) => { draft.master.muted = next; }, { reason: "master-mute" });
    if (this.audioEngine.context) {
      const state = this.store.getState();
      this.audioEngine.setMainVolume(next ? 0 : state.master.volume);
    }
  }

  setBrightness(value) {
    const safe = Math.max(0.15, Math.min(1, Number(value)));
    this.store.update((draft) => { draft.master.brightness = safe; }, { reason: "brightness" });
  }

  setGameVolume(value) {
    const safe = Math.max(0, Math.min(1, Number(value)));
    this.store.update((draft) => { draft.auxiliary.gameVolume = safe; }, { reason: "game-volume" });
  }

  setFRS(mode) {
    if (!["focus", "relax", "sleep"].includes(mode)) return;
    if (this.store.getState().frs === mode) return;
    this.store.update((draft) => { draft.frs = mode; }, { reason: "frs" });
    if (this.audioEngine.context) this.audioEngine.setTiming(mode, this.store.getState().intensity);
    this.fxMod.onFRSChanged();
  }

  setIntensity(value) {
    const safe = Math.max(-1, Math.min(1, Number(value)));
    const prior = this.store.getState().intensity;
    this.store.update((draft) => { draft.intensity = safe; }, { reason: "intensity" });
    if (this.audioEngine.context) this.audioEngine.setTiming(this.store.getState().frs, safe);
    this.fxMod.triggerFromIntensity(safe - prior);
  }

  setFxModEnabled(enabled) {
    const safe=Boolean(enabled);
    this.store.update(draft=>{draft.fxMod.enabled=safe;}, {reason:'fxmod-enabled'});
    this.fxMod.setEnabled(safe);
  }
  toggleFxMod(){ this.setFxModEnabled(!this.store.getState().fxMod.enabled); }
  setFxModHold(mode){
    const safe=["normal","5x","10x","infinity"].includes(mode)?mode:"normal";
    this.store.update(draft=>{draft.fxMod.hold=safe;},{reason:"fxmod-hold"});
    this.fxMod.onHoldChanged(safe);
  }
  setFxModTime(mode){
    const safe=['01','02','05','10','INF'].includes(mode)?mode:'01';
    const current=this.store.getState().fxMod?.timeMode || '01';
    this.store.update(d=>{d.fxMod.timeMode=safe; d.fxMod.hold=safe==='INF'?'infinity':'normal';}, {reason:'fxmod-time'});
    this.fxMod.onTimeChanged?.(safe,{fromInfinity:current==='INF'});
    this.#persistFxScopePreset();
  }
  cycleFxModTime(){
    const order=['01','02','05','10','INF'];
    const current=this.store.getState().fxMod?.timeMode || '01';
    const next=order[(order.indexOf(current)+1+order.length)%order.length] || '01';
    this.setFxModTime(next);
  }
  setFxModProb(mode){
    const safe=(['x1','x2','x5','x10','RND'].includes(mode)?mode:'x1');
    this.store.update(d=>{d.fxMod.probMode=safe;}, {reason:'fxmod-prob'});
    this.fxMod.onProbabilityChanged?.(safe);
    this.#persistFxScopePreset();
  }
  cycleFxModProb(){
    const order=['x1','x2','x5','x10','RND'];
    const current=this.store.getState().fxMod?.probMode || 'x1';
    const next=order[(order.indexOf(current)+1+order.length)%order.length] || 'x1';
    this.setFxModProb(next);
  }
  resetFxModPattern(){
    this.fxMod.cancel?.(true);
    this.store.update(d=>{
      d.fxMod.timeMode='01';
      d.fxMod.probMode='x1';
      d.fxMod.hold='normal';
      d.fxMod.memoryX=0;
      d.fxMod.memoryY=0;
      d.fxMod.trajectory=[];
      d.fxMod.releaseVelocity={x:0,y:0};
      d.fxMod.scopePassCount=0;
      d.fxMod.x=0;
      d.fxMod.y=0;
    }, {reason:'fxmod-reset'});
    this.fxMod.onTimeChanged?.('01');
    this.#persistFxScopePreset();
  }
  toggleFxModParam(param){
    const allowed=["pan","reverb","width","tremolo","delay","filter"]; if(!allowed.includes(param))return;
    this.store.update(d=>{d.fxMod.params=d.fxMod.params||{};d.fxMod.params[param]=d.fxMod.params[param]===false;},{reason:`fxmod-param-${param}`});
    this.fxMod.onParamsChanged?.();
  }
  beginFxModManual(){ return this.fxMod.beginManual(); }
  moveFxModManual(x,y){ this.fxMod.moveManual(x,y); }
  endFxModManual(vx=0,vy=0){ this.fxMod.endManual(vx,vy); }
  triggerFxMod(source='game'){ return this.fxMod.triggerRandom(source); }
  setGameSpecialEventControl(enabled){ this.fxMod.setGameControlled?.(Boolean(enabled)); }

  triggerGameAutoMixColor(color, source = "game") {
    const safe = String(color || "").toLowerCase();
    if (safe === "magenta") return this.triggerSpecialEvent(`${source}:magenta`);
    return this.automation.triggerGameColor(safe);
  }

  triggerGameAutoMixColorCleared(color, source = "game") {
    const safe = String(color || "").toLowerCase();
    if (!safe || safe === "magenta") return false;
    return this.automation.triggerGameColorCleared(safe, source);
  }

  setAutoMixEnabled(enabled) {
    const safe = Boolean(enabled);
    if (this.store.getState().autoMix.enabled === safe) return;
    this.store.update((draft) => {
      draft.autoMix.enabled = safe;
      draft.dev.message = `Auto Mix ${safe ? "ON" : "OFF"}. ${safe ? "Current values become the starting point." : "Current evolved values are frozen."}`;
    }, { reason: "automix-enabled" });
    this.automation.setEnabled(safe);
  }

  toggleAutoMix() { this.setAutoMixEnabled(!this.store.getState().autoMix.enabled); }

  setRampEnabled(enabled) {
    const safe = Boolean(enabled);
    if ((this.store.getState().transport.rampEnabled !== false) === safe) return;
    this.store.update((draft) => {
      draft.transport.rampEnabled = safe;
      draft.dev.message = `Tape speed ramp ${safe ? "enabled" : "disabled"}.`;
    }, { reason: "transport-ramp-enabled" });
  }

  toggleRamp() { this.setRampEnabled(!(this.store.getState().transport.rampEnabled !== false)); }

  forceAutoMixEvent() {
    if (!this.store.getState().autoMix.enabled || this.store.getState().transport.status !== "playing") {
      this.#setMessage("Auto Mix test event requires PLAYING transport and Auto Mix ON.");
      return false;
    }
    const ok = this.automation.forceRandomEvent();
    if (!ok) this.#setMessage("No eligible Auto Mix parameter is currently available.");
    return ok;
  }

  triggerSpecialEvent(source = "dev") {
    if (this.store.getState().transport.status !== "playing") {
      if (source === "dev") this.#setMessage("Special Event test requires PLAYING transport.");
      return false;
    }
    const ok = this.fxMod.triggerRandom(source);
    if (!ok && source === "dev") this.#setMessage("FX Scope Special Event is unavailable right now.");
    return ok;
  }

  toggleSecondaryScreen(screen) {
    if (!["byd", "control-centre", "user-guides"].includes(screen)) return;
    this.store.update((draft) => {
      draft.display.secondary = draft.display.secondary === screen ? null : screen;
    }, { reason: `display-secondary-${screen}` });
  }

  closeSecondaryScreen() {
    this.store.update((draft) => { draft.display.secondary = null; }, { reason: "display-secondary-close" });
  }

  showBaseScreen(screen, { dismissOverlay = false } = {}) {
    if (!["welcome", "game-placeholder", "tv"].includes(screen)) return;
    this.store.update((draft) => {
      draft.display.baseScreen = screen;
      draft.tv.active = screen === "tv";
      if (screen !== "game-placeholder") draft.game.screen = "inactive";
      else draft.game.screen = "menu-placeholder";
      if (dismissOverlay) draft.display.secondary = null;
    }, { reason: `display-base-${screen}${dismissOverlay ? "-dismiss-overlay" : ""}` });
  }

  showBaseScreenFromPhysical(screen) { this.showBaseScreen(screen, { dismissOverlay: true }); }

  showWelcome() { this.showBaseScreen("welcome"); }
  toggleTV() { this.showBaseScreen("tv"); }
  showGamePlaceholder() { this.showBaseScreen("game-placeholder"); }

  setOutputMode(mode) {
    if (!["mono", "stereo"].includes(mode)) return;
    this.store.update((draft) => { draft.master.outputMode = mode; }, { reason: "output-mode" });
    if (this.audioEngine.context) this.audioEngine.setOutputMode(mode);
  }

  resetTrackParamToPreset(index, param) {
    const value = this.soundscape?.tracks?.[index]?.[param];
    if (value === undefined) return;
    if (param === "volume") this.setTrackVolume(index, value);
    else if (param === "pan") this.setTrackPan(index, value);
    else if (param === "filter") this.setTrackFilter(index, value);
  }

  resetEffectToPreset(name) {
    const value = this.soundscape?.effects?.[name]?.level;
    if (value !== undefined) this.setEffectLevel(name, value);
  }

  resetCharacterToPreset(name) {
    const value = this.soundscape?.character?.[name];
    if (value !== undefined) this.setCharacter(name, value);
  }

  handleEngineEvent(event) {
    if (event.type === "engine-created") {
      this.store.update((draft) => { draft.dev.engineStatus = "initialised"; draft.dev.contextState = event.contextState; }, { reason: "engine-created" });
    } else if (event.type === "context-state") {
      this.store.update((draft) => { draft.dev.contextState = event.contextState; }, { reason: "context-state" });
    } else if (event.type === "track-load-start") {
      this.#setMessage(`Loading CH${event.trackIndex + 1}: ${event.assetId}…`);
    } else if (event.type === "track-loaded") {
      if (!this.store.getState().soundscape.loading) {
        this.store.update((draft) => {
          draft.tracks[event.trackIndex].loaded = true;
          draft.tracks[event.trackIndex].duration = event.duration;
          draft.dev.message = `Loaded CH${event.trackIndex + 1} (${event.duration.toFixed(1)} s).`;
        }, { reason: "track-loaded" });
      }
    } else if (event.type === "processing-asset-loaded") {
      this.#setMessage(`Processing asset ready: ${event.asset}.`);
    } else if (event.type === "processing-asset-warning") {
      console.warn(`Processing asset unavailable: ${event.asset}`, event.error);
      this.#setMessage(`WARNING: ${event.asset} unavailable; remaining processing stays functional.`);
    } else if (event.type === "xfade-timing" && event.detail.clamped) {
      console.info(`Track ${event.trackIndex + 1} XFade duration clamped`, event.detail);
    }
  }

  #applyAutomationValue(id, value) {
    const trackMatch = /^track:(\d+):(volume|pan|filter)$/.exec(id);
    if (trackMatch) {
      const index = Number(trackMatch[1]);
      const param = trackMatch[2];
      const safe = param === "volume" ? Math.max(0, Math.min(1, value)) : Math.max(-1, Math.min(1, value));
      this.#setTrackParam(index, param, safe, "automation");
      return;
    }
    const effectMatch = /^effect:(tremolo|delay|reverb|width)$/.exec(id);
    if (effectMatch) {
      const name = effectMatch[1];
      const safe = Math.max(0, Math.min(1, value));
      this.store.update((draft) => { draft.effects[name].level = safe; }, { reason: `automix-effect-${name}` });
      if (this.audioEngine.context) this.audioEngine.setEffect(name, { level: safe });
      return;
    }
    const charMatch = /^character:(age|hiss|wowFlutter)$/.exec(id);
    if (charMatch) {
      const name = charMatch[1];
      const safe = Math.max(0, Math.min(1, value));
      this.store.update((draft) => { draft.character[name] = safe; }, { reason: `automix-character-${name}` });
      if (this.audioEngine.context) this.audioEngine.setCharacter(name, safe);
    }
  }

  #applySpecialEffectLevel(name, value) {
    const safe = Math.max(0, Math.min(1, Number(value)));
    this.store.update((draft) => { draft.effects[name].level = safe; }, { reason: `special-event-${name}` });
    if (this.audioEngine.context) this.audioEngine.setEffect(name, { level: safe });
  }

  #persistFxScopePreset() {
    if (!this.soundscape) return;
    const fx = this.store.getState().fxMod || {};
    this.soundscape.fxMod = {
      ...(this.soundscape.fxMod || {}),
      enabled: fx.enabled,
      hold: fx.hold,
      timeMode: fx.timeMode,
      probMode: fx.probMode,
      memoryX: Number(fx.memoryX) || 0,
      memoryY: Number(fx.memoryY) || 0,
      trajectory: Array.isArray(fx.trajectory) ? fx.trajectory.map((p) => ({ t: Number(p?.t) || 0, x: Number(p?.x) || 0, y: Number(p?.y) || 0 })) : [],
      releaseVelocity: { x: Number(fx.releaseVelocity?.x) || 0, y: Number(fx.releaseVelocity?.y) || 0 },
      params: { ...(fx.params || {}) }
    };
  }

  #queueFxModFlush() {
    if (this.fxModFrameRequest !== null) return;
    // RC204: audio is still applied immediately, but FX Scope state/UI snapshots
    // are deliberately limited to 5 Hz to keep tablet rendering rock solid.
    this.fxModFrameRequest = setTimeout(() => {
      this.fxModFrameRequest = null;
      const tracks = new Map(this.fxModPendingTracks);
      const effects = new Map(this.fxModPendingEffects);
      const globals = new Map(this.fxModPendingGlobals);
      const patch = this.fxModPendingStatus ? { ...this.fxModPendingStatus } : null;
      this.fxModPendingTracks.clear();
      this.fxModPendingEffects.clear();
      this.fxModPendingGlobals.clear();
      this.fxModPendingStatus = null;
      if (!tracks.size && !effects.size && !globals.size && !patch) return;

      this.store.update(d => {
        for (const [key, value] of tracks) {
          const [indexText, param] = key.split(':');
          const index = Number(indexText);
          if (d.tracks[index]) d.tracks[index][param] = value;
        }
        for (const [name, value] of effects) {
          if (d.effects[name]) d.effects[name].level = value;
        }
        if (globals.has('intensity')) d.intensity = globals.get('intensity');
        if (patch) {
          if(patch.active!==undefined)d.fxMod.active=!!patch.active;
          if(patch.stage)d.fxMod.stage=patch.stage;
          if(patch.source)d.fxMod.source=patch.source;
          if(patch.x!==undefined)d.fxMod.x=patch.x;
          if(patch.y!==undefined)d.fxMod.y=patch.y;
          if(patch.memoryX!==undefined)d.fxMod.memoryX=patch.memoryX;
          if(patch.memoryY!==undefined)d.fxMod.memoryY=patch.memoryY;
          if(patch.trajectory!==undefined)d.fxMod.trajectory=Array.isArray(patch.trajectory)?patch.trajectory.map((p)=>({t:Number(p?.t)||0,x:Number(p?.x)||0,y:Number(p?.y)||0})):[];
          if(patch.releaseVelocity!==undefined)d.fxMod.releaseVelocity={x:Number(patch.releaseVelocity?.x)||0,y:Number(patch.releaseVelocity?.y)||0};
          if(patch.timeMode)d.fxMod.timeMode=patch.timeMode;
          if(patch.probMode)d.fxMod.probMode=patch.probMode;
          if(patch.scopeEpochMs!==undefined)d.fxMod.scopeEpochMs=patch.scopeEpochMs;
          if(patch.scopeCycleMs!==undefined)d.fxMod.scopeCycleMs=patch.scopeCycleMs;
          if(patch.scopePassCount!==undefined)d.fxMod.scopePassCount=patch.scopePassCount;
        }
      },{reason:'fxmod-frame'});

      if (patch && (patch.memoryX !== undefined || patch.memoryY !== undefined || patch.trajectory !== undefined || patch.releaseVelocity !== undefined || patch.timeMode || patch.probMode)) this.#persistFxScopePreset();
    }, 200);
  }

  #applyFxModValue(id, value) {
    const track=/^track:(\d+):(pan|filter)$/.exec(id);
    if(track){
      const i=Number(track[1]),param=track[2],safe=Math.max(-1,Math.min(1,Number(value)));
      this.fxModPendingTracks.set(`${i}:${param}`,safe);
      if(this.audioEngine.context)this.audioEngine.setTrackParam(i,param,safe);
      this.#queueFxModFlush();
      return;
    }
    if(id==='global:intensity'){
      const safe=Math.max(-1,Math.min(1,Number(value)));
      this.fxModPendingGlobals.set('intensity',safe);
      if(this.audioEngine.context)this.audioEngine.setTiming(this.store.getState().frs,safe);
      this.#queueFxModFlush();
      return;
    }
    const effect=/^effect:(tremolo|delay|reverb|width)$/.exec(id);
    if(effect){
      const name=effect[1],safe=Math.max(0,Math.min(1,Number(value)));
      this.fxModPendingEffects.set(name,safe);
      if(this.audioEngine.context)this.audioEngine.setEffect(name,{level:safe});
      this.#queueFxModFlush();
    }
  }

  #updateFxModStatus(patch) {
    const prior=this.fxModPendingStatus||{};
    const merged={...prior,...patch};
    this.fxModPendingStatus=merged;
    this.#queueFxModFlush();
  }

  #updateSpecialEventStatus(patch) {
    this.store.update((draft) => {
      if (patch.active !== undefined) draft.specialEvent.active = Boolean(patch.active);
      if (patch.stage) draft.specialEvent.stage = patch.stage;
      if (patch.increment) draft.specialEvent.count += patch.increment;
      if (patch.source) draft.specialEvent.source = patch.source;
      if (patch.active === true && patch.stage === "SPIKE") draft.dev.message = "SPECIAL EVENT: Delay + Reverb spike, then slow recovery to the captured pre-event values.";
      if (patch.active === false) draft.dev.message = "Special Event recovered to the exact pre-event Delay/Reverb values.";
    }, { reason: "special-event-status" });
  }

  #updateAutomationStatus(patch) {
    this.store.update((draft) => {
      if (patch.active !== undefined) draft.autoMix.active = Boolean(patch.active);
      if (patch.eventIncrement) draft.autoMix.eventCount += patch.eventIncrement;
      if (patch.lastMove) draft.autoMix.lastMove = patch.lastMove;
      if (Array.isArray(patch.moving)) draft.autoMix.moving = [...patch.moving];
      if (patch.movingAdd && !draft.autoMix.moving.includes(patch.movingAdd)) draft.autoMix.moving.push(patch.movingAdd);
      if (patch.movingRemove) draft.autoMix.moving = draft.autoMix.moving.filter((id) => id !== patch.movingRemove);
    }, { reason: "automix-status" });
  }

  #syncTrackStateToEngine() {
    const state = this.store.getState();
    state.tracks.forEach((track, index) => {
      this.audioEngine.setTrackParam(index, "volume", track.volume);
      this.audioEngine.setTrackParam(index, "pan", track.pan);
      this.audioEngine.setTrackParam(index, "filter", track.filter);
      this.audioEngine.setTrackMute(index, track.mute);
      this.audioEngine.setXFade(index, track.xfade);
      this.audioEngine.setTrackFrequency(index, track.frequency ?? 1);
      this.audioEngine.setTrackFrequencyMode(index, track.frequencyMode ?? "loop");
      this.audioEngine.setTrackFrequencyRandom(index, track.frequencyRandom ?? false);
    });
    this.audioEngine.setSoloState(state.tracks.map((track) => track.solo));
  }

  #syncProcessingStateToEngine() {
    if (!this.audioEngine.context) return;
    const state = this.store.getState();
    this.audioEngine.setProcessingState(state);
    this.audioEngine.setMainVolume(state.master.muted ? 0 : state.master.volume);
  }

  #applyMuteSolo() {
    if (!this.store.getState().soundscape.loaded) return;
    const tracks = this.store.getState().tracks;
    tracks.forEach((track, index) => this.audioEngine.setTrackMute(index, track.mute));
    this.audioEngine.setSoloState(tracks.map((track) => track.solo));
  }

  #setMessage(message) { this.store.update((draft) => { draft.dev.message = message; }, { reason: "message" }); }
  #updateContextState() { this.store.update((draft) => { draft.dev.contextState = this.audioEngine.context?.state ?? "not-created"; }, { reason: "context-state" }); }

  #handleError(error) {
    this.automation.pause();
    this.store.update((draft) => {
      draft.soundscape.error = error.message;
      draft.soundscape.loading = false;
      draft.dev.engineStatus = "error";
      draft.dev.message = `ERROR: ${error.message}`;
    }, { reason: "error" });
    console.error(error);
  }
}
