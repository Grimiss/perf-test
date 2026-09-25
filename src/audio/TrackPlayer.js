import { LoopCrossfade } from "./LoopCrossfade.js?v=rc215";

const FREQUENCY_FADE_MULTIPLIER = 10;

const FILTER = {
  neutralQ: 0.7,
  normalQ: 1.0,
  x2Q: 2.5,
  normalStrength: 0.55,
  hp: { neutral: 20, normal: 320, x2: 1100 },
  lp: { neutral: 20000, normal: 4500, x2: 1200 }
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function logLerp(a, b, t) {
  return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);
}

export class TrackPlayer {
  constructor({ context, clock, destination, index, playbackModulations = [], onEvent = () => {} }) {
    this.context = context;
    this.clock = clock;
    this.destination = destination;
    this.index = index;
    this.onEvent = onEvent;
    this.playbackModulations = playbackModulations;
    this.playbackRate = 1;

    this.buffer = null;
    this.loopLength = 0;
    this.volume = 1;
    this.pan = 0;
    this.filterValue = 0;
    this.userMuted = false;
    this.soloSuppressed = false;
    this.xfadeChoice = 1;
    this.frequency = 1;
    this.frequencyMode = "loop";
    this.frequencyRandom = false;
    this.frequencyCycle = 1;
    this.frequencyAudible = true;
    this.frequencyNextRandomCycle = null;
    this.frequencyPendingAudible = true;
    this.dropoutPhase = "play";
    this.dropoutPhaseCount = 0;
    this.dropoutPlayTarget = 1;
    this.dropoutSilentTarget = 1;
    this.frequencyGatePhase = "audible";
    this.frequencySilentTargetProgress = null;
    this.frequencyTimer = null;
    this.frequencyTimerToken = 0;
    this.xfadeResume = null;
    this.pauseOffset = 0;
    this.sourceVoice = null;
    this.crossfade = null;
    this.playing = false;

    // Verified legacy channel order remains Filter -> Gain/Volume -> Pan -> destination.
    // CP02 uses two permanently typed filters in series so moving through the
    // bipolar centre never changes a live BiquadFilterNode.type (which can click/drop out).
    this.highpassNode = context.createBiquadFilter();
    this.lowpassNode = context.createBiquadFilter();
    this.trackGain = context.createGain();
    this.frequencyGain = context.createGain();
    this.panNode = context.createStereoPanner();

    this.highpassNode.type = "highpass";
    this.highpassNode.frequency.value = FILTER.hp.neutral;
    this.highpassNode.Q.value = FILTER.neutralQ;
    this.lowpassNode.type = "lowpass";
    this.lowpassNode.frequency.value = FILTER.lp.neutral;
    this.lowpassNode.Q.value = FILTER.neutralQ;

    this.trackGain.gain.value = 1;
    this.frequencyGain.gain.value = 1;
    this.panNode.pan.value = 0;
    this.highpassNode.connect(this.lowpassNode);
    this.lowpassNode.connect(this.trackGain);
    this.trackGain.connect(this.frequencyGain);
    this.frequencyGain.connect(this.panNode);
    this.panNode.connect(destination);
  }

  loadBuffer(buffer) {
    this.stop();
    this.buffer = buffer;
    this.loopLength = Math.max(0.01, buffer.duration - 0.02);
    this.pauseOffset = 0;
    this.xfadeResume = null;
    this.#resetFrequencySequence();
  }


  rampPlaybackRateFromStop(targetRate, durationSeconds = 2, when = this.context.currentTime) {
    const target = clamp(targetRate, 0.25, 2);
    const duration = Math.max(0.05, Number(durationSeconds) || 2);
    const voices = this.crossfade?.voices?.length ? this.crossfade.voices : (this.sourceVoice ? [this.sourceVoice] : []);
    for (const voice of new Set(voices)) {
      try {
        const param = voice.source.playbackRate;
        param.cancelScheduledValues(when);
        // WebAudio playbackRate=0 is not consistently useful across browsers, so
        // start just above zero and ramp smoothly to the current FRS rate.
        param.setValueAtTime(0.01, when);
        param.linearRampToValueAtTime(target, when + duration);
      } catch {}
    }
  }

  rampPlaybackRateToStop(durationSeconds = 0.85, when = this.context.currentTime) {
    const duration = Math.max(0.05, Number(durationSeconds) || 0.85);
    const voices = this.crossfade?.voices?.length ? this.crossfade.voices : (this.sourceVoice ? [this.sourceVoice] : []);
    for (const voice of new Set(voices)) {
      try {
        const param = voice.source.playbackRate;
        param.cancelScheduledValues(when);
        param.setValueAtTime(Math.max(0.01, param.value || this.playbackRate), when);
        param.linearRampToValueAtTime(0.01, when + duration);
      } catch {}
    }
  }

  setPlaybackRate(rate) {
    this.playbackRate = clamp(rate, 0.25, 2);
    const now = this.context.currentTime;
    const voices = this.crossfade?.voices?.length ? this.crossfade.voices : (this.sourceVoice ? [this.sourceVoice] : []);
    for (const voice of new Set(voices)) {
      try {
        voice.source.playbackRate.cancelScheduledValues(now);
        voice.source.playbackRate.setValueAtTime(this.playbackRate, now);
      } catch {}
    }
    if (this.frequencyGatePhase === "silent") this.#scheduleFrequencyFadeInFromSilence();
  }

  setVolume(value) {
    this.volume = clamp(value, 0, 1);
    this.#applyGain();
  }

  setPan(value) {
    this.pan = clamp(value, -1, 1);
    this.panNode.pan.setTargetAtTime(this.pan, this.context.currentTime, 0.015);
  }

  // Final CP02 control is bipolar: negative = LP, centre = neutral, positive = HP.
  // Both filter nodes remain permanently connected/typed. The inactive side is
  // smoothly returned to its neutral cutoff, eliminating the centre-point type switch.
  setFilter(value) {
    this.filterValue = clamp(value, -1, 1);
    const strength = Math.abs(this.filterValue);
    const now = this.context.currentTime;
    const timeConstant = 0.025;

    let frequency = null;
    let q = FILTER.neutralQ;

    if (strength >= 0.001) {
      const table = this.filterValue < 0 ? FILTER.lp : FILTER.hp;
      if (strength <= FILTER.normalStrength) {
        const t = strength / FILTER.normalStrength;
        frequency = logLerp(table.neutral, table.normal, t);
        q = FILTER.neutralQ + (FILTER.normalQ - FILTER.neutralQ) * t;
      } else {
        const t = (strength - FILTER.normalStrength) / (1 - FILTER.normalStrength);
        frequency = logLerp(table.normal, table.x2, t);
        q = FILTER.normalQ + (FILTER.x2Q - FILTER.normalQ) * t;
      }
    }

    if (this.filterValue < -0.001) {
      // LP active, HP neutral.
      this.lowpassNode.frequency.setTargetAtTime(frequency, now, timeConstant);
      this.lowpassNode.Q.setTargetAtTime(q, now, timeConstant);
      this.highpassNode.frequency.setTargetAtTime(FILTER.hp.neutral, now, timeConstant);
      this.highpassNode.Q.setTargetAtTime(FILTER.neutralQ, now, timeConstant);
    } else if (this.filterValue > 0.001) {
      // HP active, LP neutral.
      this.highpassNode.frequency.setTargetAtTime(frequency, now, timeConstant);
      this.highpassNode.Q.setTargetAtTime(q, now, timeConstant);
      this.lowpassNode.frequency.setTargetAtTime(FILTER.lp.neutral, now, timeConstant);
      this.lowpassNode.Q.setTargetAtTime(FILTER.neutralQ, now, timeConstant);
    } else {
      // Centre: both filters are effectively transparent and no node type changes.
      this.highpassNode.frequency.setTargetAtTime(FILTER.hp.neutral, now, timeConstant);
      this.highpassNode.Q.setTargetAtTime(FILTER.neutralQ, now, timeConstant);
      this.lowpassNode.frequency.setTargetAtTime(FILTER.lp.neutral, now, timeConstant);
      this.lowpassNode.Q.setTargetAtTime(FILTER.neutralQ, now, timeConstant);
    }
  }

  setUserMuted(value) {
    this.userMuted = Boolean(value);
    this.#applyGain();
  }

  setSoloSuppressed(value) {
    this.soloSuppressed = Boolean(value);
    this.#applyGain();
  }

  #applyGain() {
    const target = this.userMuted || this.soloSuppressed ? 0 : this.volume;
    this.trackGain.gain.setTargetAtTime(target, this.context.currentTime, 0.01);
  }


  setFrequency(value) {
    this.frequency = Math.max(1, Math.min(10, Number(value) || 1));
    this.#resetFrequencySequence({ makeAudible: true });
  }

  setFrequencyMode(mode) {
    this.frequencyMode = ["loop", "frequency", "dropout"].includes(mode) ? mode : "loop";
    this.#resetFrequencySequence({ makeAudible: true });
  }

  setFrequencyRandom(enabled) {
    this.frequencyRandom = Boolean(enabled);
    this.#resetFrequencySequence({ makeAudible: true });
  }

  #randomInterval() {
    if (this.frequency <= 1) return 1;

    // RND mode deliberately favours interval 1 so a track will often
    // play on consecutive loop cycles. Repeated draws of 1 naturally
    // create occasional 3-in-a-row (or longer) runs, while the remaining
    // probability is shared evenly across intervals 2..FREQ.
    if (Math.random() < 0.5) return 1;
    return 2 + Math.floor(Math.random() * (this.frequency - 1));
  }

  #randomDropoutLength() {
    // A dropout is deliberately short: 1-3 silent loop cycles only.
    // 1 and 2 are favoured so long gaps are unusual.
    const roll = Math.random();
    if (roll < 0.45) return 1;
    if (roll < 0.85) return 2;
    return 3;
  }

  #clearFrequencyTimer() {
    if (this.frequencyTimer !== null && this.frequencyTimer !== undefined) {
      clearTimeout(this.frequencyTimer);
    }
    this.frequencyTimer = null;
    this.frequencyTimerToken = (this.frequencyTimerToken || 0) + 1;
  }

  #frequencyFadeDuration() {
    return (LoopCrossfade.durations[this.xfadeChoice] || 0.250) * FREQUENCY_FADE_MULTIPLIER;
  }

  #holdFrequencyGain(now = this.context.currentTime) {
    const gain = this.frequencyGain?.gain;
    if (!gain) return 1;
    if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
    else gain.cancelScheduledValues(now);
    return Math.max(0, Math.min(1, Number(gain.value)));
  }

  #scheduleFrequencyCallback(audioTime, callback) {
    this.#clearFrequencyTimer();
    const token = this.frequencyTimerToken;
    const delayMs = Math.max(0, (audioTime - this.context.currentTime) * 1000);
    this.frequencyTimer = setTimeout(() => {
      if (token !== this.frequencyTimerToken) return;
      this.frequencyTimer = null;
      callback();
    }, delayMs);
  }

  #resetFrequencySequence({ makeAudible = false } = {}) {
    this.#clearFrequencyTimer();
    this.frequencyCycle = 1;
    this.frequencyAudible = true;
    this.frequencyPendingAudible = true;
    this.frequencyNextRandomCycle = null;
    this.frequencyGatePhase = "audible";
    this.frequencySilentTargetProgress = null;
    this.dropoutPhase = "play";
    this.dropoutPhaseCount = 0;
    this.dropoutPlayTarget = this.frequencyRandom ? this.#randomInterval() : this.frequency;
    this.dropoutSilentTarget = this.#randomDropoutLength();
    if (this.frequencyGain && makeAudible) {
      const now = this.context.currentTime;
      const gain = this.frequencyGain.gain;
      if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now); else gain.cancelScheduledValues(now);
      gain.setValueAtTime(1, now);
    }
  }

  #startFrequencyFadeOut(silentLoops) {
    if (!this.frequencyGain || !this.playing || this.frequencyMode === "loop") return;
    const now = this.context.currentTime;
    const duration = this.#frequencyFadeDuration();
    const gain = this.frequencyGain.gain;
    const held = this.#holdFrequencyGain(now);

    this.frequencyGatePhase = "fading-out";
    this.frequencyAudible = true;
    this.frequencyPendingAudible = false;
    gain.setValueAtTime(held, now);
    gain.linearRampToValueAtTime(0, now + duration);

    const fadeEnd = now + duration;
    this.#scheduleFrequencyCallback(fadeEnd, () => this.#enterFrequencySilence(silentLoops, fadeEnd));
  }

  #enterFrequencySilence(silentLoops, fadeEndTime = this.context.currentTime) {
    if (!this.frequencyGain || !this.playing || this.frequencyMode === "loop") return;
    const now = this.context.currentTime;
    const gain = this.frequencyGain.gain;
    this.#holdFrequencyGain(now);
    gain.setValueAtTime(0, now);

    this.frequencyGatePhase = "silent";
    this.frequencyAudible = false;
    this.frequencyPendingAudible = false;

    // The silent-loop count starts only after the fade has genuinely reached
    // 0 dB. It is measured in transport/loop progress, so the fade itself can
    // cross any number of loop boundaries without consuming the silent count.
    const countFrom = Math.max(fadeEndTime, now);
    this.frequencySilentTargetProgress = this.clock.value(countFrom) + Math.max(0, silentLoops) * this.loopLength;
    this.#scheduleFrequencyFadeInFromSilence();
  }

  #scheduleFrequencyFadeInFromSilence() {
    if (this.frequencyGatePhase !== "silent" || this.frequencySilentTargetProgress === null) return;
    const now = this.context.currentTime;
    const currentProgress = this.clock.value(now);
    if (currentProgress >= this.frequencySilentTargetProgress - 1e-6) {
      this.#startFrequencyFadeIn();
      return;
    }

    const wakeTime = this.crossfade
      ? this.crossfade.timeAt(this.frequencySilentTargetProgress, now)
      : now + Math.max(0, (this.frequencySilentTargetProgress - currentProgress) / Math.max(0.001, this.playbackRate));
    this.#scheduleFrequencyCallback(wakeTime, () => this.#startFrequencyFadeIn());
  }

  #startFrequencyFadeIn() {
    if (!this.frequencyGain || !this.playing || this.frequencyMode === "loop") return;
    const now = this.context.currentTime;
    const duration = this.#frequencyFadeDuration();
    const gain = this.frequencyGain.gain;
    this.#holdFrequencyGain(now);
    gain.setValueAtTime(0, now);

    this.frequencyGatePhase = "fading-in";
    this.frequencyAudible = false;
    this.frequencyPendingAudible = true;
    this.frequencySilentTargetProgress = null;
    gain.linearRampToValueAtTime(1, now + duration);

    const fadeEnd = now + duration;
    this.#scheduleFrequencyCallback(fadeEnd, () => {
      if (!this.playing || this.frequencyMode === "loop") return;
      const at = this.context.currentTime;
      this.#holdFrequencyGain(at);
      this.frequencyGain.gain.setValueAtTime(1, at);
      this.frequencyGatePhase = "audible";
      this.frequencyAudible = true;
      this.frequencyPendingAudible = true;
      this.frequencyCycle = 1;
      this.dropoutPhase = "play";
      this.dropoutPhaseCount = 0;
      this.dropoutPlayTarget = this.frequencyRandom ? this.#randomInterval() : this.frequency;
      this.dropoutSilentTarget = this.#randomDropoutLength();
    });
  }

  #handleFrequencyBoundary() {
    this.frequencyCycle += 1;
    if (!this.playing || this.frequencyMode === "loop") return;
    if (this.frequencyGatePhase !== "audible") return;

    if (this.frequencyMode === "dropout") {
      this.dropoutPhaseCount += 1;
      if (this.dropoutPhaseCount >= this.dropoutPlayTarget) {
        this.dropoutSilentTarget = this.#randomDropoutLength();
        this.#startFrequencyFadeOut(this.dropoutSilentTarget);
      }
      return;
    }

    // FREQUENCY mode: each fully audible loop completion chooses the next
    // interval. Interval 1 means keep playing into the next loop. Any larger
    // interval fades out completely first, then counts only the silent loops.
    const interval = this.frequencyRandom ? this.#randomInterval() : this.frequency;
    if (interval <= 1) return;
    this.#startFrequencyFadeOut(interval - 1);
  }

  setXFade(choice) {
    this.xfadeChoice = Math.max(1, Math.min(3, Number(choice) || 1));
    if (this.crossfade) {
      this.crossfade.select(this.xfadeChoice);
      return;
    }
    if (this.playing && this.sourceVoice && this.xfadeChoice) {
      this.crossfade = this.#makeCrossfade();
      this.crossfade.start(0, this.context.currentTime, null, this.sourceVoice);
    }
  }

  play(when) {
    if (!this.buffer || this.playing) return;
    if (this.frequencyGatePhase && this.frequencyGatePhase !== "audible") {
      this.#resetFrequencySequence({ makeAudible: true });
    }
    const offset = this.pauseOffset || 0;
    if (this.xfadeChoice || this.xfadeResume?.overlap) {
      this.crossfade = this.#makeCrossfade();
      this.crossfade.start(offset, when, this.xfadeResume, null, true);
      this.xfadeResume = null;
    } else {
      this.sourceVoice = this.#createVoice(offset, when, false);
    }
    this.playing = true;
  }

  activateCrossfade() {
    this.crossfade?.activate();
  }

  pause(now) {
    if (!this.playing || !this.sourceVoice || !this.buffer) return;
    this.#clearFrequencyTimer();
    if (this.frequencyGain?.gain) {
      const gain = this.frequencyGain.gain;
      if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now); else gain.cancelScheduledValues(now);
    }
    this.xfadeResume = this.crossfade?.snapshot(now) || null;
    this.pauseOffset = this.xfadeResume ? this.xfadeResume.position : this.#positionOf(this.sourceVoice, now);
    this.#disposePlayback();
    this.playing = false;
  }

  stop() {
    this.#disposePlayback();
    this.xfadeResume = null;
    this.pauseOffset = 0;
    this.playing = false;
    this.#resetFrequencySequence({ makeAudible: true });
  }

  getPosition(now = this.context.currentTime) {
    if (!this.playing || !this.sourceVoice) return this.pauseOffset || 0;
    return this.crossfade ? this.crossfade.position(now) : this.#positionOf(this.sourceVoice, now);
  }

  #positionOf(voice, now) {
    const advance = now <= voice.startTime ? 0 : this.clock.value(now) - voice.positionClock;
    return ((voice.positionOffset + advance) % this.loopLength + this.loopLength) % this.loopLength;
  }

  #adoptVoice(voice) {
    this.sourceVoice = voice;
  }

  #makeCrossfade() {
    return new LoopCrossfade({
      context: this.context,
      clock: this.clock,
      length: this.loopLength,
      choice: this.xfadeChoice,
      createVoice: (offset, when) => this.#createVoice(offset, when, true),
      adopt: (voice) => this.#adoptVoice(voice),
      report: (detail) => this.onEvent({ type: "xfade-timing", trackIndex: this.index, detail }),
      onBoundaryPlan: () => {},
      onBoundarySettled: () => this.#handleFrequencyBoundary()
    });
  }

  #createVoice(offset = 0, when = this.context.currentTime, voiceOnly = false) {
    if (!this.buffer) throw new Error(`Track ${this.index + 1} has no decoded buffer.`);
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.playbackRate;
    this.playbackModulations.forEach((modulation) => { try { modulation.connect(source.playbackRate); } catch {} });
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = this.loopLength;

    let disposed = false;
    const voice = {
      source,
      gain: null,
      startTime: when,
      positionOffset: Math.max(0, offset) % this.loopLength,
      positionClock: this.clock.value(when),
      attachGain: () => {
        if (voice.gain) return;
        voice.gain = this.context.createGain();
        voice.gain.gain.value = 1;
        try { source.disconnect(); } catch {}
        source.connect(voice.gain);
        voice.gain.connect(this.highpassNode);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        try { source.stop(); } catch {}
        this.playbackModulations.forEach((modulation) => { try { modulation.disconnect(source.playbackRate); } catch {} });
        try { source.disconnect(); } catch {}
        try { voice.gain?.disconnect(); } catch {}
        source.onended = null;
      }
    };

    if (voiceOnly) {
      voice.attachGain();
      voice.gain.gain.value = 0;
    } else {
      source.connect(this.highpassNode);
    }
    source.start(when, voice.positionOffset);
    if (!voiceOnly) this.#adoptVoice(voice);
    return voice;
  }

  #disposePlayback() {
    if (this.crossfade) this.crossfade.stop();
    else this.sourceVoice?.dispose();
    this.crossfade = null;
    this.sourceVoice = null;
  }
}
