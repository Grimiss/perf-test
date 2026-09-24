const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const clampBipolar = (value) => Math.max(-1, Math.min(1, Number(value) || 0));

export class ProcessingChain {
  constructor({ context, clock, onEvent = () => {} }) {
    this.context = context;
    this.clock = clock;
    this.onEvent = onEvent;

    this.input = context.createGain();
    this.output = context.createGain();

    this.character = { age: 0, hiss: 0, wowFlutter: 0 };
    this.tapeType = "normal";
    this.effects = {
      tremolo: { enabled: false, level: 0 },
      delay: { enabled: false, level: 0 },
      reverb: { enabled: false, level: 0 },
      width: { enabled: false, level: 0 }
    };
    this.tone = 0;
    this.frs = "focus";
    this.intensity = 0;
    this.transportActive = false;

    this.playbackModulations = [];
    this.#build();
  }

  #build() {
    const c = this.context;

    // ----- Character: AGE tonal stage -----
    this.ageLow = c.createBiquadFilter();
    this.ageLow.type = "lowshelf";
    this.ageLow.frequency.value = 180;
    this.ageMid = c.createBiquadFilter();
    this.ageMid.type = "peaking";
    this.ageMid.frequency.value = 900;
    this.ageMid.Q.value = 0.7;
    this.ageHigh = c.createBiquadFilter();
    this.ageHigh.type = "highshelf";
    this.ageHigh.frequency.value = 4200;
    this.characterOutput = c.createGain();
    this.ageNoiseGain = c.createGain();
    this.hissGain = c.createGain();
    this.ageNoiseGain.gain.value = 0;
    this.hissGain.gain.value = 0;

    this.input.connect(this.ageLow);
    this.ageLow.connect(this.ageMid);
    this.ageMid.connect(this.ageHigh);
    this.ageHigh.connect(this.characterOutput);
    // AGE noise enters before AGE EQ; HISS joins after AGE EQ.
    this.ageNoiseGain.connect(this.ageLow);
    this.hissGain.connect(this.characterOutput);

    // ----- Tape Type -----
    this.tapeLow = c.createBiquadFilter();
    this.tapeLow.type = "lowshelf";
    this.tapeLow.frequency.value = 180;
    this.tapeHigh = c.createBiquadFilter();
    this.tapeHigh.type = "lowpass";
    this.tapeHigh.frequency.value = 20000;
    this.tapeHigh.Q.value = 0.5;
    this.characterOutput.connect(this.tapeLow);
    this.tapeLow.connect(this.tapeHigh);

    // ----- Tremolo -----
    this.tremoloInput = c.createGain();
    this.tremoloSplitter = c.createChannelSplitter(2);
    this.tremoloMerger = c.createChannelMerger(2);
    this.tremoloGainLeft = c.createGain();
    this.tremoloGainRight = c.createGain();
    this.tremoloWet = c.createGain();
    this.tremoloOscLeft = c.createOscillator();
    this.tremoloOscRight = c.createOscillator();
    this.tremoloDepthLeft = c.createGain();
    this.tremoloDepthRight = c.createGain();
    this.tremoloDriftOsc = c.createOscillator();
    this.tremoloDriftLeft = c.createGain();
    this.tremoloDriftRight = c.createGain();

    this.tremoloGainLeft.gain.value = 1;
    this.tremoloGainRight.gain.value = 1;
    this.tremoloWet.gain.value = 1;
    this.tremoloOscLeft.type = "sine";
    this.tremoloOscRight.type = "sine";
    this.tremoloDriftOsc.type = "sine";
    this.tremoloDriftOsc.frequency.value = 0.018;

    this.tapeHigh.connect(this.tremoloInput);
    this.tremoloInput.connect(this.tremoloSplitter);
    this.tremoloSplitter.connect(this.tremoloGainLeft, 0);
    this.tremoloSplitter.connect(this.tremoloGainRight, 1);
    this.tremoloGainLeft.connect(this.tremoloMerger, 0, 0);
    this.tremoloGainRight.connect(this.tremoloMerger, 0, 1);
    this.tremoloMerger.connect(this.tremoloWet);
    this.tremoloOscLeft.connect(this.tremoloDepthLeft);
    this.tremoloDepthLeft.connect(this.tremoloGainLeft.gain);
    this.tremoloOscRight.connect(this.tremoloDepthRight);
    this.tremoloDepthRight.connect(this.tremoloGainRight.gain);
    this.tremoloDriftOsc.connect(this.tremoloDriftLeft);
    this.tremoloDriftOsc.connect(this.tremoloDriftRight);
    this.tremoloDriftLeft.connect(this.tremoloDepthLeft.gain);
    this.tremoloDriftRight.connect(this.tremoloDepthRight.gain);

    // ----- Delay -----
    this.delayInput = c.createGain();
    this.delayDry = c.createGain();
    this.delayWet = c.createGain();
    this.delaySplitter = c.createChannelSplitter(2);
    this.delayMerger = c.createChannelMerger(2);
    this.delayLeft = c.createDelay(2.0);
    this.delayRight = c.createDelay(2.0);
    this.delayFeedbackLeft = c.createGain();
    this.delayFeedbackRight = c.createGain();
    this.delayFilterLeft = c.createBiquadFilter();
    this.delayFilterRight = c.createBiquadFilter();
    this.delayDriftOsc = c.createOscillator();
    this.delayDriftLeft = c.createGain();
    this.delayDriftRight = c.createGain();
    this.delayFilterLeft.type = "lowpass";
    this.delayFilterRight.type = "lowpass";
    this.delayFilterLeft.Q.value = 0.4;
    this.delayFilterRight.Q.value = 0.4;
    this.delayDry.gain.value = 1;
    this.delayWet.gain.value = 0;
    this.delayDriftOsc.type = "sine";
    this.delayDriftOsc.frequency.value = 0.012;

    this.tremoloWet.connect(this.delayInput);
    this.delayInput.connect(this.delayDry);
    this.delayInput.connect(this.delaySplitter);
    this.delaySplitter.connect(this.delayLeft, 0);
    this.delaySplitter.connect(this.delayRight, 1);
    this.delayLeft.connect(this.delayFilterLeft);
    this.delayRight.connect(this.delayFilterRight);
    this.delayFilterLeft.connect(this.delayMerger, 0, 0);
    this.delayFilterRight.connect(this.delayMerger, 0, 1);
    this.delayMerger.connect(this.delayWet);
    this.delayFilterLeft.connect(this.delayFeedbackLeft);
    this.delayFilterRight.connect(this.delayFeedbackRight);
    this.delayFeedbackLeft.connect(this.delayLeft);
    this.delayFeedbackRight.connect(this.delayRight);
    this.delayDriftOsc.connect(this.delayDriftLeft);
    this.delayDriftOsc.connect(this.delayDriftRight);
    this.delayDriftLeft.connect(this.delayLeft.delayTime);
    this.delayDriftRight.connect(this.delayRight.delayTime);

    // ----- Reverb -----
    this.reverbInput = c.createGain();
    this.reverbDry = c.createGain();
    this.reverbWet = c.createGain();
    this.reverbNode = c.createConvolver();
    this.reverbNode.normalize = true;
    this.reverbLow = c.createBiquadFilter();
    this.reverbLow.type = "lowshelf";
    this.reverbLow.frequency.value = 180;
    this.reverbMid = c.createBiquadFilter();
    this.reverbMid.type = "peaking";
    this.reverbMid.frequency.value = 900;
    this.reverbMid.Q.value = 0.75;
    this.reverbHigh = c.createBiquadFilter();
    this.reverbHigh.type = "highshelf";
    this.reverbHigh.frequency.value = 4200;
    this.reverbDry.gain.value = 1;
    this.reverbWet.gain.value = 0;

    this.delayDry.connect(this.reverbInput);
    this.delayWet.connect(this.reverbInput);
    this.reverbInput.connect(this.reverbDry);
    this.reverbInput.connect(this.reverbNode);
    this.reverbNode.connect(this.reverbLow);
    this.reverbLow.connect(this.reverbMid);
    this.reverbMid.connect(this.reverbHigh);
    this.reverbHigh.connect(this.reverbWet);

    // ----- Width / legacy Dimension -----
    this.widthInput = c.createGain();
    this.widthDry = c.createGain();
    this.widthWet = c.createGain();
    this.widthDelayLeft = c.createDelay(0.1);
    this.widthDelayRight = c.createDelay(0.1);
    this.widthLFOL = c.createOscillator();
    this.widthLFOR = c.createOscillator();
    this.widthLFOGainL = c.createGain();
    this.widthLFOGainR = c.createGain();
    this.widthPanL = c.createStereoPanner();
    this.widthPanR = c.createStereoPanner();
    this.widthLow = c.createBiquadFilter();
    this.widthLow.type = "lowshelf";
    this.widthLow.frequency.value = 180;
    this.widthMid = c.createBiquadFilter();
    this.widthMid.type = "peaking";
    this.widthMid.frequency.value = 900;
    this.widthMid.Q.value = 0.75;
    this.widthHigh = c.createBiquadFilter();
    this.widthHigh.type = "highshelf";
    this.widthHigh.frequency.value = 4200;
    this.widthLFOL.type = "sine";
    this.widthLFOR.type = "sine";
    this.widthDry.gain.value = 1;
    this.widthWet.gain.value = 0;

    this.reverbDry.connect(this.widthInput);
    this.reverbWet.connect(this.widthInput);
    this.widthInput.connect(this.widthDry);
    this.widthInput.connect(this.widthDelayLeft);
    this.widthInput.connect(this.widthDelayRight);
    this.widthLFOL.connect(this.widthLFOGainL);
    this.widthLFOR.connect(this.widthLFOGainR);
    this.widthLFOGainL.connect(this.widthDelayLeft.delayTime);
    this.widthLFOGainR.connect(this.widthDelayRight.delayTime);
    this.widthDelayLeft.connect(this.widthPanL);
    this.widthDelayRight.connect(this.widthPanR);
    this.widthPanL.connect(this.widthWet);
    this.widthPanR.connect(this.widthWet);
    this.widthWet.connect(this.widthLow);
    this.widthLow.connect(this.widthMid);
    this.widthMid.connect(this.widthHigh);

    // ----- Master Tone -----
    this.toneLow = c.createBiquadFilter();
    this.toneLow.type = "lowshelf";
    this.toneLow.frequency.value = 250;
    this.toneHigh = c.createBiquadFilter();
    this.toneHigh.type = "highshelf";
    this.toneHigh.frequency.value = 2500;
    this.widthDry.connect(this.toneLow);
    this.widthHigh.connect(this.toneLow);
    this.toneLow.connect(this.toneHigh);
    this.toneHigh.connect(this.output);

    // ----- Generated Wow & Flutter modulation -----
    const freqs = [0.37, 0.61, 5.2, 6.7];
    this.clock.startModulation(c.currentTime, freqs);
    this.wfOscillators = freqs.map((frequency) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.value = 0;
      osc.connect(gain);
      osc.start(c.currentTime);
      this.playbackModulations.push(gain);
      return { osc, gain, baseFrequency: frequency };
    });

    // Start effect oscillators once; depth/rates are state-driven.
    this.tremoloOscLeft.start();
    this.tremoloOscRight.start();
    this.tremoloDriftOsc.start();
    this.delayDriftOsc.start();
    this.widthLFOL.start();
    this.widthLFOR.start();

    this.#applyAll();
  }

  async initAssets() {
    const decode = async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
      const bytes = await response.arrayBuffer();
      return this.context.decodeAudioData(bytes.slice(0));
    };

    const results = await Promise.allSettled([
      decode("assets/audio/character/Age Noise Loop.wav"),
      decode("assets/audio/character/Tape Hiss Loop.wav"),
      decode("assets/audio/irs/04_ST_Hall_05.wav")
    ]);

    if (results[0].status === "fulfilled") this.#startLoopingNoise(results[0].value, "age");
    else this.onEvent({ type: "processing-asset-warning", asset: "Age Noise Loop", error: results[0].reason?.message });

    if (results[1].status === "fulfilled") this.#startLoopingNoise(results[1].value, "hiss");
    else this.onEvent({ type: "processing-asset-warning", asset: "Tape Hiss Loop", error: results[1].reason?.message });

    if (results[2].status === "fulfilled") {
      this.reverbNode.buffer = results[2].value;
      this.onEvent({ type: "processing-asset-loaded", asset: "04_ST_Hall_05" });
    } else {
      this.onEvent({ type: "processing-asset-warning", asset: "04_ST_Hall_05", error: results[2].reason?.message });
    }

    this.#applyAge();
    this.#applyHiss();
    this.#applyReverb();
  }

  #startLoopingNoise(buffer, kind) {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = buffer.duration;
    source.connect(kind === "age" ? this.ageNoiseGain : this.hissGain);
    source.start();
    if (kind === "age") this.ageNoiseSource = source;
    else this.hissSource = source;
    this.onEvent({ type: "processing-asset-loaded", asset: kind === "age" ? "Age Noise Loop" : "Tape Hiss Loop" });
  }

  setState({ character, tapeType, effects, tone, frs, intensity }) {
    if (character) this.character = { ...this.character, ...character };
    if (tapeType) this.tapeType = tapeType;
    if (effects) {
      for (const key of Object.keys(this.effects)) {
        if (effects[key]) this.effects[key] = { ...this.effects[key], ...effects[key] };
      }
    }
    if (tone !== undefined) this.tone = clampBipolar(tone);
    if (frs) this.frs = frs;
    if (intensity !== undefined) this.intensity = clampBipolar(intensity);
    this.#applyAll();
  }

  setCharacter(name, value) {
    if (!(name in this.character)) return;
    this.character[name] = clamp01(value);
    if (name === "age") {
      this.#applyAge();
      this.#applyHiss();
      this.#applyWowFlutter();
    } else if (name === "hiss") this.#applyHiss();
    else this.#applyWowFlutter();
  }

  setTapeType(type) {
    if (!["normal", "chrome", "metal"].includes(type)) return;
    this.tapeType = type;
    this.#applyTape();
    this.#applyHiss();
  }

  setEffect(name, patch) {
    if (!(name in this.effects)) return;
    this.effects[name] = { ...this.effects[name], ...patch };
    this.effects[name].level = clamp01(this.effects[name].level);
    this.effects[name].enabled = Boolean(this.effects[name].enabled);
    this.#applyEffect(name);
  }

  setTone(value) {
    this.tone = clampBipolar(value);
    const now = this.context.currentTime;
    this.toneLow.gain.setTargetAtTime(-this.tone * 12, now, 0.02);
    this.toneHigh.gain.setTargetAtTime(this.tone * 12, now, 0.02);
  }

  setTiming(frs, intensity = this.intensity) {
    this.frs = frs || this.frs;
    this.intensity = clampBipolar(intensity);
    this.#applyWowFlutterRate();
    this.#applyTremoloRate();
    this.#applyDelayRate();
    this.#applyWidthRate();
  }

  setTransportActive(active, fadeSeconds = 0.04) {
    this.transportActive = Boolean(active);
    this.#applyAge(fadeSeconds);
    this.#applyHiss(fadeSeconds);
  }

  #ageMultiplier() { return 1 + clamp01(this.character.age); }
  #tapeHissMultiplier() { return this.tapeType === "metal" ? 1 : this.tapeType === "chrome" ? 1.5 : 2; }
  #effectDepth(name) {
    const fx = this.effects[name];
    return fx.enabled ? clamp01(fx.level) : 0;
  }
  #timingMultiplier() {
    const base = this.frs === "sleep" ? 0.5 : this.frs === "relax" ? 0.75 : 1;
    return base * (1 + (this.intensity * 0.5));
  }

  #applyAll() {
    this.#applyAge();
    this.#applyHiss();
    this.#applyWowFlutter();
    this.#applyWowFlutterRate();
    this.#applyTape();
    this.#applyTremolo();
    this.#applyTremoloRate();
    this.#applyDelay();
    this.#applyDelayRate();
    this.#applyReverb();
    this.#applyWidth();
    this.#applyWidthRate();
    this.setTone(this.tone);
  }

  #applyAge(timeConstant = 0.035) {
    const amount = clamp01(this.character.age);
    const now = this.context.currentTime;
    this.ageLow.gain.setTargetAtTime(-5.5 * amount, now, timeConstant);
    this.ageMid.gain.setTargetAtTime(4.5 * amount, now, timeConstant);
    this.ageHigh.gain.setTargetAtTime(-8 * amount, now, timeConstant);
    const targetNoise = this.transportActive ? amount * 0.55 : 0;
    this.ageNoiseGain.gain.setTargetAtTime(targetNoise, now, Math.max(0.01, timeConstant));
  }

  #applyHiss(timeConstant = 0.035) {
    const effective = Math.min(1, clamp01(this.character.hiss) * this.#tapeHissMultiplier() * this.#ageMultiplier());
    const target = this.transportActive ? effective * 0.60 : 0;
    this.hissGain.gain.setTargetAtTime(target, this.context.currentTime, Math.max(0.01, timeConstant));
  }

  #applyWowFlutter() {
    const amount = Math.min(1, clamp01(this.character.wowFlutter) * this.#ageMultiplier());
    const depths = [0.0085, 0.0030, 0.0028, 0.0017].map((d) => d * amount);
    const now = this.context.currentTime;
    depths.forEach((depth, index) => {
      this.wfOscillators[index].gain.gain.setTargetAtTime(depth, now, 0.04);
      this.clock.target(index, "depth", depth, now, 0.04);
    });
  }

  #applyWowFlutterRate() {
    const rate = this.frs === "sleep" ? 0.5 : this.frs === "relax" ? 0.75 : 1;
    const now = this.context.currentTime;
    this.wfOscillators.forEach((entry, index) => {
      const target = entry.baseFrequency * rate;
      entry.osc.frequency.setTargetAtTime(target, now, 0.08);
      this.clock.target(index, "frequency", target, now, 0.08);
    });
  }

  #applyTape() {
    let lowGain = 8;
    let highCutoff = 3500;
    if (this.tapeType === "chrome") { lowGain = 4; highCutoff = 6000; }
    else if (this.tapeType === "metal") { lowGain = 0; highCutoff = 20000; }
    const now = this.context.currentTime;
    this.tapeLow.gain.setTargetAtTime(lowGain, now, 0.05);
    this.tapeHigh.frequency.setTargetAtTime(highCutoff, now, 0.05);
  }

  #applyEffect(name) {
    if (name === "tremolo") this.#applyTremolo();
    else if (name === "delay") this.#applyDelay();
    else if (name === "reverb") this.#applyReverb();
    else if (name === "width") this.#applyWidth();
  }

  #applyTremolo() {
    const amount = this.#effectDepth("tremolo");
    const now = this.context.currentTime;
    const depth = amount * 0.82;
    const drift = amount * 0.11;
    this.tremoloDepthLeft.gain.setTargetAtTime(-depth, now, 0.03);
    this.tremoloDepthRight.gain.setTargetAtTime(-depth, now, 0.03);
    this.tremoloDriftLeft.gain.setTargetAtTime(-drift, now, 0.03);
    this.tremoloDriftRight.gain.setTargetAtTime(drift, now, 0.03);
  }

  #applyTremoloRate() {
    const modeRate = this.frs === "sleep" ? 1.5 : this.frs === "relax" ? 3 : 5;
    const rate = modeRate * (1 + this.intensity * 0.5);
    const now = this.context.currentTime;
    this.tremoloOscLeft.frequency.setTargetAtTime(rate, now, 0.05);
    this.tremoloOscRight.frequency.setTargetAtTime(rate * 1.005, now, 0.05);
  }

  #applyDelay() {
    const amount = this.#effectDepth("delay");
    const now = this.context.currentTime;
    this.delayWet.gain.setTargetAtTime(amount * 0.85, now, 0.03);
    this.delayFeedbackLeft.gain.setTargetAtTime(amount * 0.85, now, 0.03);
    this.delayFeedbackRight.gain.setTargetAtTime(amount * 0.85 * 0.96, now, 0.03);
    const filterFrequency = 2200 - amount * 1000;
    this.delayFilterLeft.frequency.setTargetAtTime(filterFrequency, now, 0.03);
    this.delayFilterRight.frequency.setTargetAtTime(filterFrequency * 0.97, now, 0.03);
  }

  #applyDelayRate() {
    let delayTime = this.frs === "sleep" ? 0.52 : this.frs === "relax" ? 0.38 : 0.28;
    const speed = Math.max(0.25, 1 + this.intensity * 0.5);
    delayTime /= speed;
    const stereoOffset = Math.max(0.012, Math.min(0.055, delayTime * 0.10));
    const now = this.context.currentTime;
    this.delayLeft.delayTime.setTargetAtTime(delayTime - stereoOffset, now, 0.05);
    this.delayRight.delayTime.setTargetAtTime(delayTime + stereoOffset, now, 0.05);
    const drift = Math.min(0.035, delayTime * 0.06);
    this.delayDriftLeft.gain.setTargetAtTime(-drift, now, 0.08);
    this.delayDriftRight.gain.setTargetAtTime(drift, now, 0.08);
  }

  #applyReverb() {
    const amount = this.#effectDepth("reverb");
    const now = this.context.currentTime;
    this.reverbDry.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2) * 0.98, now, 0.03);
    const wet = this.reverbNode.buffer ? Math.sin(amount * Math.PI / 2) * 0.46 * 2.40 : 0;
    this.reverbWet.gain.setTargetAtTime(wet, now, 0.03);
    this.reverbLow.gain.setTargetAtTime(-3, now, 0.04);
    this.reverbMid.gain.setTargetAtTime(2, now, 0.04);
    this.reverbHigh.gain.setTargetAtTime(-9 + 14 * amount, now, 0.04);
  }

  #applyWidth() {
    const amount = this.#effectDepth("width");
    const depthMs = 0.1 + 2.3 * amount;
    const width = (80 + 20 * amount) / 100;
    const centreDelay = 0.027;
    const stereoSpread = 0.014;
    const modulationDepth = (depthMs / 1000) * amount;
    const now = this.context.currentTime;
    this.widthDelayLeft.delayTime.setTargetAtTime(centreDelay - stereoSpread / 2, now, 0.03);
    this.widthDelayRight.delayTime.setTargetAtTime(centreDelay + stereoSpread / 2, now, 0.03);
    this.widthPanL.pan.setTargetAtTime(-width, now, 0.03);
    this.widthPanR.pan.setTargetAtTime(width, now, 0.03);
    this.widthDry.gain.setTargetAtTime(1 - amount * 0.25, now, 0.03);
    this.widthWet.gain.setTargetAtTime(amount * 0.45, now, 0.03);
    this.widthLFOGainL.gain.setTargetAtTime(modulationDepth, now, 0.03);
    this.widthLFOGainR.gain.setTargetAtTime(modulationDepth, now, 0.03);
    this.widthLow.gain.setTargetAtTime(0, now, 0.03);
    this.widthMid.gain.setTargetAtTime(0, now, 0.03);
    this.widthHigh.gain.setTargetAtTime(4 * amount, now, 0.03);
  }

  #applyWidthRate() {
    let left = 0.32;
    let right = 0.32 * 1.16;
    if (this.frs === "focus") { left *= 1.5; right *= 1.5; }
    else if (this.frs === "relax") { left *= 0.9375; right *= 0.9444; }
    else { left *= 0.5; right *= 0.5333; }
    const speed = 1 + this.intensity * 0.5;
    const now = this.context.currentTime;
    this.widthLFOL.frequency.setTargetAtTime(left * speed, now, 0.08);
    this.widthLFOR.frequency.setTargetAtTime(right * speed, now, 0.08);
  }
}
