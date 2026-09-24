import { TransportClock } from "./TransportClock.js";
import { TrackPlayer } from "./TrackPlayer.js";
import { ProcessingChain } from "./ProcessingChain.js";

class SoundscapeBank {
  constructor({ context, clock, destination, bankId, playbackModulations, onEvent }) {
    this.context = context;
    this.clock = clock;
    this.bankId = bankId;
    this.onEvent = onEvent;
    this.gain = context.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(destination);
    this.tracks = Array.from({ length: 4 }, (_, index) => new TrackPlayer({
      context,
      clock,
      destination: this.gain,
      index,
      playbackModulations,
      onEvent
    }));
    this.loadedId = null;
  }

  loadBuffers(definition, buffers) {
    buffers.forEach((buffer, index) => this.tracks[index].loadBuffer(buffer));
    definition.tracks.forEach((track, index) => {
      this.tracks[index].setVolume(track.volume);
      this.tracks[index].setPan(track.pan ?? 0);
      this.tracks[index].setFilter(track.filter ?? 0);
      this.tracks[index].setUserMuted(false);
      this.tracks[index].setSoloSuppressed(false);
      this.tracks[index].setXFade(track.xfade ?? 1);
      this.tracks[index].setFrequency(track.frequency ?? 1);
      this.tracks[index].setFrequencyMode(track.frequencyMode ?? "loop");
      this.tracks[index].setFrequencyRandom(track.frequencyRandom ?? false);
    });
    this.loadedId = definition.id;
  }

  play(when) {
    this.tracks.forEach((track) => track.play(when));
    this.tracks.forEach((track) => track.activateCrossfade());
  }
  pause(now) { this.tracks.forEach((track) => track.pause(now)); }
  stop() { this.tracks.forEach((track) => track.stop()); }
}

export class AudioEngine {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.context = null;
    this.clock = null;
    this.mixBus = null;
    this.transportGain = null;
    this.processing = null;
    this.masterGain = null;
    this.stereoModeGain = null;
    this.monoModeGain = null;
    this.monoSplitter = null;
    this.monoSum = null;
    this.monoMerger = null;
    this.outputMode = "stereo";
    this.startupGate = null;
    this.startupGateOpened = false;
    this.transportFadeSeconds = 0.040;
    this.soundscapeFadeSeconds = 0.120;
    this.transportTransition = 0;
    this.banks = [];
    this.activeBankIndex = 0;
    this.loaded = false;
    this.transport = "stopped";
    this.playbackRate = 1;
  }

  get activeBank() { return this.banks[this.activeBankIndex]; }
  get inactiveBank() { return this.banks[1 - this.activeBankIndex]; }
  get tracks() { return this.activeBank?.tracks ?? []; }

  async init() {
    if (!this.context) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error("This browser does not support the Web Audio API.");
      this.context = new AudioContextCtor({ latencyHint: "playback" });
      this.clock = new TransportClock(1, this.context.sampleRate);
      this.mixBus = this.context.createGain();
      this.transportGain = this.context.createGain();
      this.processing = new ProcessingChain({ context: this.context, clock: this.clock, onEvent: (event) => this.onEvent(event) });
      this.startupGate = this.context.createGain();
      this.masterGain = this.context.createGain();
      this.stereoModeGain = this.context.createGain();
      this.monoModeGain = this.context.createGain();
      this.monoSplitter = this.context.createChannelSplitter(2);
      this.monoSum = this.context.createGain();
      this.monoMerger = this.context.createChannelMerger(2);
      this.transportGain.gain.value = 0;
      // Keep the complete output muted while a newly-created AudioContext,
      // processing graph, oscillators and looping noise assets settle.
      // This gate opens once on the first PLAY only.
      this.startupGate.gain.value = 0;
      this.masterGain.gain.value = 0.50;
      this.stereoModeGain.gain.value = 1;
      this.monoModeGain.gain.value = 0;
      this.monoSum.gain.value = 0.5;

      // Transport safety gain is PRE-effects so Delay/Reverb tails can decay naturally.
      this.mixBus.connect(this.transportGain);
      this.transportGain.connect(this.processing.input);
      this.processing.output.connect(this.startupGate);

      // Final output mode stage. Stereo is direct. Mono sums L+R at -6 dB each
      // then duplicates the mono signal to both output channels without touching pan state.
      this.startupGate.connect(this.stereoModeGain);
      this.stereoModeGain.connect(this.masterGain);
      this.startupGate.connect(this.monoSplitter);
      this.monoSplitter.connect(this.monoSum, 0);
      this.monoSplitter.connect(this.monoSum, 1);
      this.monoSum.connect(this.monoMerger, 0, 0);
      this.monoSum.connect(this.monoMerger, 0, 1);
      this.monoMerger.connect(this.monoModeGain);
      this.monoModeGain.connect(this.masterGain);
      this.masterGain.connect(this.context.destination);

      this.banks = [0, 1].map((bankId) => new SoundscapeBank({
        context: this.context,
        clock: this.clock,
        destination: this.mixBus,
        bankId,
        playbackModulations: this.processing.playbackModulations,
        onEvent: (event) => this.onEvent(event)
      }));
      this.banks[0].gain.gain.value = 1;
      this.banks[1].gain.gain.value = 0;
      this.banks.forEach((bank) => bank.tracks.forEach((track) => track.setPlaybackRate(this.playbackRate)));
      this.onEvent({ type: "engine-created", contextState: this.context.state });
      await this.processing.initAssets();
    }
    if (this.context.state !== "running") await this.context.resume();
    this.onEvent({ type: "context-state", contextState: this.context.state });
  }

  async #decodeSoundscape(definition) {
    if (!definition?.tracks || definition.tracks.length !== 4) throw new Error("D8M4 requires exactly four Soundscape tracks.");
    return Promise.all(definition.tracks.map(async (track, index) => {
      this.onEvent({ type: "track-load-start", trackIndex: index, assetId: track.assetId });
      const response = await fetch(track.assetUrl);
      if (!response.ok) throw new Error(`Failed to load ${track.assetId}: HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      let buffer;
      try { buffer = await this.context.decodeAudioData(data.slice(0)); }
      catch (error) { throw new Error(`Failed to decode ${track.assetId}: ${error.message}`); }
      this.onEvent({ type: "track-loaded", trackIndex: index, assetId: track.assetId, duration: buffer.duration });
      return buffer;
    }));
  }

  async loadSoundscape(definition) {
    if (!this.context) throw new Error("AudioEngine.init() must run before loadSoundscape().");
    if (this.loaded) return this.switchSoundscape(definition);
    const buffers = await this.#decodeSoundscape(definition);
    this.activeBank.loadBuffers(definition, buffers);
    this.activeBank.gain.gain.setValueAtTime(1, this.context.currentTime);
    this.inactiveBank.gain.gain.setValueAtTime(0, this.context.currentTime);
    this.loaded = true;
    this.transport = "stopped";
    this.onEvent({ type: "soundscape-loaded", id: definition.id });
  }

  async switchSoundscape(definition) {
    if (!this.loaded) return this.loadSoundscape(definition);
    const priorStatus = this.transport;
    const target = this.inactiveBank;
    const old = this.activeBank;
    target.stop();
    const buffers = await this.#decodeSoundscape(definition);
    target.loadBuffers(definition, buffers);
    const now = this.context.currentTime;
    target.gain.gain.cancelScheduledValues(now);
    old.gain.gain.cancelScheduledValues(now);
    if (priorStatus === "playing") {
      const when = now + 0.025;
      target.gain.gain.setValueAtTime(0, now);
      target.gain.gain.setValueAtTime(0, when);
      old.gain.gain.setValueAtTime(1, when);
      target.play(when);
      target.gain.gain.linearRampToValueAtTime(1, when + this.soundscapeFadeSeconds);
      old.gain.gain.linearRampToValueAtTime(0, when + this.soundscapeFadeSeconds);
      await new Promise((resolve) => window.setTimeout(resolve, Math.ceil((0.025 + this.soundscapeFadeSeconds + 0.02) * 1000)));
      old.stop();
    } else {
      old.stop();
      old.gain.gain.setValueAtTime(0, now);
      target.gain.gain.setValueAtTime(1, now);
    }
    this.activeBankIndex = 1 - this.activeBankIndex;
    this.transport = priorStatus;
    this.onEvent({ type: "soundscape-loaded", id: definition.id, switched: true, transport: priorStatus });
  }

  play({ startupRateRampSeconds = 0 } = {}) {
    if (!this.loaded) throw new Error("No Soundscape is loaded.");
    if (this.transport === "playing") return;
    this.transportTransition += 1;
    const now = this.context.currentTime;
    const hasOverlapResume = this.tracks.some((track) => track.xfadeResume?.overlap);
    const when = now + (hasOverlapResume ? 0.15 : 0.02);
    const gain = this.transportGain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(0, now);
    gain.setValueAtTime(0, when);
    gain.linearRampToValueAtTime(1, when + this.transportFadeSeconds);
    this.processing.setTransportActive(true, this.transportFadeSeconds);
    this.activeBank.play(when);
    if (startupRateRampSeconds > 0) {
      const seconds = Math.max(0.05, Number(startupRateRampSeconds) || 2);
      this.activeBank.tracks.forEach((track) => track.rampPlaybackRateFromStop(this.playbackRate, seconds, when));
    }

    // Browser/Web Audio implementations can emit a one-off transient when a
    // freshly created/resumed graph first becomes audible (especially with
    // oscillators, Convolver and looping noise sources already running).
    // Keep a post-processing startup gate closed through that instant, then
    // fade it open once. Later PLAY/PAUSE/STOP operations bypass this gate.
    if (!this.startupGateOpened && this.startupGate) {
      const gate = this.startupGate.gain;
      const openAt = when + 0.055;
      gate.cancelScheduledValues(now);
      gate.setValueAtTime(0, now);
      gate.setValueAtTime(0, openAt);
      gate.linearRampToValueAtTime(1, openAt + 0.080);
      this.startupGateOpened = true;
    }

    this.transport = "playing";
    this.onEvent({ type: "transport", status: "playing" });
  }

  async pause() {
    if (this.transport !== "playing") return false;
    const transition = ++this.transportTransition;
    const now = this.context.currentTime;
    const end = now + this.transportFadeSeconds;
    const gain = this.transportGain.gain;
    if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now); else gain.cancelScheduledValues(now);
    gain.linearRampToValueAtTime(0, end);
    this.processing.setTransportActive(false, this.transportFadeSeconds);
    await this.#waitForFade();
    if (transition !== this.transportTransition) return false;
    const pauseTime = this.context.currentTime;
    this.activeBank.pause(pauseTime);
    gain.cancelScheduledValues(pauseTime);
    gain.setValueAtTime(0, pauseTime);
    this.transport = "paused";
    this.onEvent({ type: "transport", status: "paused" });
    return true;
  }

  async stop({ fade = true, rateRampSeconds = 0.6 } = {}) {
    const transition = ++this.transportTransition;
    const wasPlaying = this.transport === "playing" && this.context;

    if (wasPlaying) {
      const now = this.context.currentTime;

      if (fade) {
        const rampSeconds = Math.max(0.08, Number(rateRampSeconds) || 0.6);
        this.activeBank.tracks.forEach((track) => track.rampPlaybackRateToStop(rampSeconds, now));

        // Let the tape-style speed ramp do almost all of the audible stop.
        await new Promise((resolve) => window.setTimeout(resolve, Math.ceil(Math.max(0, rampSeconds - 0.10) * 1000)));
        if (transition !== this.transportTransition) return false;
      }

      // Anti-pop fade: always reach true silence before disposing source nodes.
      // This is deliberately short enough not to sound like a separate fade-out,
      // and it is retained even when the optional speed RAMP is switched off.
      const fadeNow = this.context.currentTime;
      const antiPopFadeSeconds = 0.18;
      const gain = this.transportGain.gain;
      if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(fadeNow); else gain.cancelScheduledValues(fadeNow);
      gain.linearRampToValueAtTime(0, fadeNow + antiPopFadeSeconds);
      this.processing.setTransportActive(false, antiPopFadeSeconds);

      // Give the audio graph a small safety margin after the gain reaches zero
      // before stopping/disposing buffers; this prevents the end-of-stop click.
      await new Promise((resolve) => window.setTimeout(resolve, Math.ceil((antiPopFadeSeconds + 0.04) * 1000)));
      if (transition !== this.transportTransition) return false;
    } else if (this.processing) {
      this.processing.setTransportActive(false, 0.02);
    }

    this.banks.forEach((bank) => bank.stop());
    if (this.transportGain) {
      const now = this.context.currentTime;
      this.transportGain.gain.cancelScheduledValues(now);
      this.transportGain.gain.setValueAtTime(0, now);
    }
    this.transport = "stopped";
    this.onEvent({ type: "transport", status: "stopped" });
    return true;
  }

  #waitForFade() { return new Promise((resolve) => window.setTimeout(resolve, Math.ceil((this.transportFadeSeconds + 0.006) * 1000))); }

  setTrackParam(index, param, value) {
    const track = this.tracks[index];
    if (!track) return;
    if (param === "volume") track.setVolume(value);
    else if (param === "pan") track.setPan(value);
    else if (param === "filter") track.setFilter(value);
  }
  setTrackMute(index, muted) { this.tracks[index]?.setUserMuted(muted); }
  setSoloState(soloMask) {
    const anySolo = soloMask.some(Boolean);
    this.tracks.forEach((track, index) => track.setSoloSuppressed(anySolo && !soloMask[index]));
  }
  setXFade(index, choice) { this.tracks[index]?.setXFade(choice); }
  setTrackFrequency(index, value) { this.tracks[index]?.setFrequency(value); }
  setTrackFrequencyMode(index, mode) { this.tracks[index]?.setFrequencyMode(mode); }
  setTrackFrequencyRandom(index, enabled) { this.tracks[index]?.setFrequencyRandom(enabled); }

  setProcessingState(state) {
    if (!this.processing) return;
    this.processing.setState({
      character: state.character,
      tapeType: state.tapeType,
      effects: state.effects,
      tone: state.master?.tone ?? 0,
      frs: state.frs,
      intensity: state.intensity
    });
  }
  setCharacter(name, value) { this.processing?.setCharacter(name, value); }
  setTapeType(type) { this.processing?.setTapeType(type); }
  setEffect(name, patch) { this.processing?.setEffect(name, patch); }
  setMasterTone(value) { this.processing?.setTone(value); }
  setMainVolume(value) {
    if (!this.masterGain || !this.context) return;
    const safe = Math.max(0, Math.min(1, Number(value)));
    const now = this.context.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setTargetAtTime(safe, now, 0.015);
  }

  setOutputMode(mode) {
    if (!this.context || !this.stereoModeGain || !this.monoModeGain) return;
    const next = mode === "mono" ? "mono" : "stereo";
    this.outputMode = next;
    const now = this.context.currentTime;
    const stereo = next === "stereo" ? 1 : 0;
    const mono = next === "mono" ? 1 : 0;
    [this.stereoModeGain.gain, this.monoModeGain.gain].forEach(param => {
      if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now); else param.cancelScheduledValues(now);
    });
    this.stereoModeGain.gain.linearRampToValueAtTime(stereo, now + 0.025);
    this.monoModeGain.gain.linearRampToValueAtTime(mono, now + 0.025);
  }

  setTiming(frs, intensity) {
    this.processing?.setTiming(frs, intensity);
    const rate = frs === "sleep" ? 0.5 : frs === "relax" ? 0.75 : 1;
    this.setPlaybackRate(rate);
  }

  setPlaybackRate(rate) {
    if (!this.context || !this.clock) return;
    this.playbackRate = Math.max(0.25, Math.min(2, Number(rate) || 1));
    const now = this.context.currentTime;
    this.clock.setRate(this.playbackRate, now);
    this.banks.forEach((bank) => bank.tracks.forEach((track) => track.setPlaybackRate(this.playbackRate)));
    this.onEvent({ type: "playback-rate", rate: this.playbackRate });
  }

  getDiagnostics() {
    return {
      contextState: this.context?.state ?? "not-created",
      loaded: this.loaded,
      soundscapeId: this.activeBank?.loadedId ?? null,
      transport: this.transport,
      positions: this.tracks.map((track) => this.context ? track.getPosition(this.context.currentTime) : 0),
      processing: this.processing ? { tapeType: this.processing.tapeType, tone: this.processing.tone } : null
    };
  }
}
