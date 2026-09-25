const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const clamp01 = (value) => clamp(value, 0, 1);
const clampBi = (value) => clamp(value, -1, 1);
const random = (min, max) => min + Math.random() * (max - min);

export class AutomationManager {
  constructor({ store, applyValue, onStatus = () => {} }) {
    this.store = store;
    this.applyValue = applyValue;
    this.onStatus = onStatus;
    this.scheduleTimers = new Map();
    this.moveTimers = new Map();
    this.baselines = new Map();
    this.suspended = new Set();
    // Game colour hits are coalesced per colour so rapid repeated hits do not
    // keep restarting the same Auto Mix gesture before it can be heard.
    this.gameColorTimers = new Map();
    this.gameColorPending = new Set();
    // Colour-clear celebrations temporarily reserve their mapped parameters,
    // spike them, then drift them back to their original Auto Mix baselines.
    this.gameColorCompletionTimers = new Map();
    this.gameColorCompletionIds = new Map();
    this.active = false;
    // RC219: long-form evolution targets. Auto Mix now moves toward slowly
    // changing musical states instead of constantly correcting back to the
    // original preset. The preset is only revisited softly every ~15–20 min.
    this.evolutionTargets = new Map();
    this.evolutionPhaseTimer = null;
    this.nextHomeVisitAt = 0;
    this.resetBaselines();
  }

  get definitions() {
    const defs = [];
    for (let i = 0; i < 4; i += 1) {
      defs.push({ id: `track:${i}:volume`, type: "volume", trackIndex: i });
      defs.push({ id: `track:${i}:pan`, type: "pan", trackIndex: i });
      defs.push({ id: `track:${i}:filter`, type: "filter", trackIndex: i });
    }
    for (const name of ["tremolo", "delay", "reverb", "width"]) defs.push({ id: `effect:${name}`, type: "effect", name });
    for (const name of ["age", "hiss", "wowFlutter"]) defs.push({ id: `character:${name}`, type: "character", name });
    return defs;
  }

  get autoDefinitions() { return this.definitions.filter((def) => def.type === "volume" || def.type === "pan" || def.type === "character"); }

  resetBaselines() {
    this.baselines.clear();
    this.evolutionTargets.clear();
    const state = this.store.getState();
    for (const def of this.definitions) this.baselines.set(def.id, this.#read(def, state));
    this.nextHomeVisitAt = performance.now() + random(15 * 60 * 1000, 20 * 60 * 1000);
  }

  onTransport(status) {
    const state = this.store.getState();
    const shouldRun = status === "playing" && state.autoMix.enabled;
    if (shouldRun) this.start();
    else this.pause();
  }

  onSoundscapeChanging() {
    this.pause();
  }

  onSoundscapeChanged() {
    this.resetBaselines();
    const state = this.store.getState();
    if (state.transport.status === "playing" && state.autoMix.enabled) this.start();
  }

  setEnabled(enabled) {
    if (!enabled) this.pause();
    else if (this.store.getState().transport.status === "playing") this.start();
  }

  manualIntervention(id, value) {
    this.baselines.set(id, Number(value));
    // Respect a manual move for the rest of the current evolutionary phase.
    // A later phase is free to drift away again.
    this.evolutionTargets.set(id, Number(value));
    this.#cancelMove(id);
    // A manual grab becomes the new base. If that parameter was moving,
    // give it a full normal wait before Auto Mix is allowed to touch it again.
    if (this.active) this.#schedule(id, true);
  }

  eligibilityChanged(id) {
    this.#cancelMove(id);
  }

  suspend(id) {
    this.suspended.add(id);
    const schedule = this.scheduleTimers.get(id);
    if (schedule) clearTimeout(schedule);
    this.scheduleTimers.delete(id);
    this.#cancelMove(id);
  }

  resume(id) {
    if (!this.suspended.delete(id)) return;
    if (this.active) this.#schedule(id, true);
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.onStatus({ active: true });
    this.#beginEvolutionPhase(true);
    for (const def of this.autoDefinitions) this.#schedule(def.id, true);
  }

  pause() {
    if (!this.active && this.scheduleTimers.size === 0 && this.moveTimers.size === 0) {
      this.onStatus({ active: false });
      return;
    }
    this.active = false;
    if (this.evolutionPhaseTimer) clearTimeout(this.evolutionPhaseTimer);
    this.evolutionPhaseTimer = null;
    for (const timer of this.scheduleTimers.values()) clearTimeout(timer);
    for (const timer of this.moveTimers.values()) clearInterval(timer);
    this.scheduleTimers.clear();
    this.moveTimers.clear();
    for (const timer of this.gameColorTimers.values()) clearTimeout(timer);
    this.gameColorTimers.clear();
    this.gameColorPending.clear();
    for (const timers of this.gameColorCompletionTimers.values()) {
      for (const timer of timers) clearInterval(timer);
    }
    this.gameColorCompletionTimers.clear();
    for (const ids of this.gameColorCompletionIds.values()) {
      for (const id of ids) this.suspended.delete(id);
    }
    this.gameColorCompletionIds.clear();
    this.onStatus({ active: false, moving: [] });
  }

  forceRandomEvent() {
    const eligible = this.autoDefinitions.filter((def) => this.#eligible(def, this.store.getState()));
    if (!eligible.length) return false;
    // Shuffle so the development button reliably starts one visible move even
    // when the first random target happens to fall below the no-op threshold.
    for (let i = eligible.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }
    for (const def of eligible) {
      if (this.#perform(def, { forced: true })) return true;
    }
    return false;
  }

  triggerGameColor(color) {
    const safeColor = String(color || "").toLowerCase();
    if (!this.active) return false;
    const state = this.store.getState();
    if (!state.autoMix.enabled || state.transport.status !== "playing") return false;

    // If this colour already has a game gesture in progress, remember one
    // pending hit rather than cancelling/restarting the current gesture. This
    // deliberately coalesces very rapid brick/alien hits so the motion remains
    // audible without building an ever-growing queue.
    if (this.gameColorTimers.has(safeColor)) {
      this.gameColorPending.add(safeColor);
      return true;
    }
    return this.#startGameColor(safeColor);
  }

  #gameColorMap() {
    return {
      red: ["track:0:volume", "track:0:pan", "track:0:filter", "effect:tremolo"],
      green: ["track:1:volume", "track:1:pan", "track:1:filter", "effect:delay"],
      blue: ["track:2:volume", "track:2:pan", "track:2:filter", "effect:reverb"],
      yellow: ["track:3:volume", "track:3:pan", "track:3:filter", "effect:width"]
    };
  }

  #startGameColor(color) {
    const state = this.store.getState();
    const ids = this.#gameColorMap()[color];
    if (!ids || !this.active || !state.autoMix.enabled || state.transport.status !== "playing") return false;

    let moved = false;
    for (const id of ids) {
      const def = this.definitions.find((item) => item.id === id);
      if (!def || !this.#eligible(def, state)) continue;
      const scheduled = this.scheduleTimers.get(id);
      if (scheduled) clearTimeout(scheduled);
      this.scheduleTimers.delete(id);

      // The first game hit may take control from an ordinary Auto Mix move.
      // Further hits of this SAME colour are held above until this complete
      // gesture has had time to finish, so they can no longer cancel it out.
      this.#cancelMove(id);
      moved = this.#perform(def, { forced: true, game: true }) || moved;
      this.#schedule(id, true);
    }

    if (!moved) return false;

    const gestureMs = 2650; // forced moves are capped at 2600 ms
    const timer = setTimeout(() => {
      this.gameColorTimers.delete(color);
      const pending = this.gameColorPending.delete(color);
      const live = this.store.getState();
      if (pending && this.active && live.autoMix.enabled && live.transport.status === "playing") {
        this.#startGameColor(color);
      }
    }, gestureMs);
    this.gameColorTimers.set(color, timer);
    return true;
  }

  #beginEvolutionPhase(immediate = false) {
    if (!this.active) return;
    if (this.evolutionPhaseTimer) clearTimeout(this.evolutionPhaseTimer);

    const now = performance.now();
    const homeVisit = this.nextHomeVisitAt > 0 && now >= this.nextHomeVisitAt;
    this.#buildEvolutionTargets(homeVisit);
    if (homeVisit) this.nextHomeVisitAt = now + random(15 * 60 * 1000, 20 * 60 * 1000);

    const state = this.store.getState();
    const phaseRange = state.frs === "sleep" ? [105000, 190000] : state.frs === "relax" ? [80000, 155000] : [60000, 125000];
    const delay = immediate ? random(65000, 105000) : random(...phaseRange);
    this.evolutionPhaseTimer = setTimeout(() => {
      this.evolutionPhaseTimer = null;
      if (this.active) this.#beginEvolutionPhase(false);
    }, delay);
  }

  #buildEvolutionTargets(homeVisit = false) {
    const state = this.store.getState();
    const channelMode = String(state.autoMix?.channelLevel || "MED").toUpperCase();
    const characterMode = String(state.autoMix?.characterLevel || "MED").toUpperCase();
    const channelScale = channelMode === "LOW" ? 0.58 : channelMode === "HIGH" ? 1.22 : 0.90;
    const characterScale = characterMode === "LOW" ? 0.55 : characterMode === "HIGH" ? 1.25 : 0.88;
    const scaleToward = (current, target, scale, min = 0, max = 1) => clamp(current + (target - current) * scale, min, max);
    const shuffled = (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };

    if (homeVisit) {
      // A soft fly-by of the original preset, never an exact reset.
      for (const def of this.autoDefinitions) {
        const current = this.#read(def, state);
        const base = this.baselines.has(def.id) ? this.baselines.get(def.id) : current;
        const spread = def.type === "pan" ? 0.14 : def.type === "character" ? 0.08 : 0.07;
        const min = def.type === "pan" ? -1 : 0;
        const max = 1;
        this.evolutionTargets.set(def.id, clamp(base + random(-spread, spread), min, max));
      }
      return;
    }

    const currentVolumes = state.tracks.map((t) => clamp01(t.volume));
    const targets = [...currentVolumes];
    const indices = shuffled([0, 1, 2, 3]);
    const roll = Math.random();

    const pushDown = (i, deep = false) => {
      const cur = currentVolumes[i];
      const raw = deep && Math.random() < 0.55 ? random(0.025, 0.14) : Math.max(0.025, cur - random(0.18, 0.48));
      targets[i] = scaleToward(cur, raw, channelScale, 0.02, 0.98);
    };
    const pushUp = (i, strong = false) => {
      const cur = currentVolumes[i];
      const floor = strong ? 0.72 : 0.56;
      const raw = random(Math.max(floor, cur + 0.10), 0.98);
      targets[i] = scaleToward(cur, raw, channelScale, 0.02, 0.98);
    };
    const drift = (i, amount = 0.25) => {
      const cur = currentVolumes[i];
      targets[i] = clamp(cur + random(-amount, amount) * channelScale, 0.02, 0.98);
    };

    if (roll < 0.18) {
      // Sparse: one or two tracks recede; compensation is optional.
      const downCount = Math.random() < 0.58 ? 1 : 2;
      indices.slice(0, downCount).forEach((i) => pushDown(i, true));
      if (Math.random() < 0.52) pushUp(indices[downCount], Math.random() < 0.35);
    } else if (roll < 0.34) {
      // Intense: several tracks rise above their starting levels, with an
      // occasional retreating track to stop the mix becoming a flat wall.
      const upCount = 2 + Math.floor(Math.random() * 3);
      indices.slice(0, upCount).forEach((i) => pushUp(i, true));
      if (upCount < 4 && Math.random() < 0.55) pushDown(indices[upCount], false);
    } else if (roll < 0.56) {
      // Redistribution: energy moves from one side of the mix to another.
      const downCount = Math.random() < 0.55 ? 1 : 2;
      const upCount = Math.random() < 0.58 ? 1 : 2;
      indices.slice(0, downCount).forEach((i) => pushDown(i, Math.random() < 0.35));
      indices.slice(downCount, Math.min(4, downCount + upCount)).forEach((i) => pushUp(i, Math.random() < 0.35));
    } else if (roll < 0.72) {
      // Featured voice: one track becomes prominent while one/two become very
      // quiet, exposing tape character and details in the source material.
      pushUp(indices[0], true);
      pushDown(indices[1], true);
      if (Math.random() < 0.65) pushDown(indices[2], true);
      if (Math.random() < 0.35) drift(indices[3], 0.18);
    } else if (roll < 0.86) {
      // Ebb: the whole drone breathes down, but by different amounts.
      indices.forEach((i) => pushDown(i, Math.random() < 0.28));
    } else {
      // Free drift: no compensation rule at all.
      indices.forEach((i) => drift(i, 0.34));
    }

    targets.forEach((value, i) => this.evolutionTargets.set(`track:${i}:volume`, value));

    // Pan evolves independently from level, and deliberately does not snap to
    // a common centre. Each long-form phase gets its own spatial balance.
    for (let i = 0; i < 4; i += 1) {
      const current = clampBi(state.tracks[i].pan);
      let target = clampBi(current + random(-0.65, 0.65) * channelScale);
      if (Math.random() < 0.14) target = random(-0.85, 0.85);
      this.evolutionTargets.set(`track:${i}:pan`, target);
    }

    // Character has its own intensity setting. Sparse channel phases have a
    // gentle tendency to reveal more AGE/HISS, but never as a fixed rule.
    const meanVolume = targets.reduce((a, b) => a + b, 0) / targets.length;
    for (const name of ["age", "hiss", "wowFlutter"]) {
      const id = `character:${name}`;
      const current = clamp01(state.character[name]);
      let target;
      if ((name === "age" || name === "hiss") && meanVolume < 0.42 && Math.random() < 0.58) {
        target = random(Math.max(current, 0.30), 0.82);
      } else if (Math.random() < 0.12) {
        target = Math.random() < 0.5 ? random(0.03, 0.20) : random(0.62, 0.90);
      } else {
        target = current + random(-0.26, 0.26);
      }
      this.evolutionTargets.set(id, scaleToward(current, clamp01(target), characterScale, 0, 0.92));
    }
  }

  #schedule(id, replace = false) {
    if (!this.active) return;
    if (replace && this.scheduleTimers.has(id)) clearTimeout(this.scheduleTimers.get(id));
    if (!replace && this.scheduleTimers.has(id)) return;
    const def = this.definitions.find((item) => item.id === id);
    if (!def || !this.autoDefinitions.some((item) => item.id === id)) return;
    const delay = this.#eventIntervalMs();
    const timer = setTimeout(() => {
      this.scheduleTimers.delete(id);
      if (!this.active) return;
      this.#perform(def);
      this.#schedule(id, true);
    }, delay);
    this.scheduleTimers.set(id, timer);
  }

  #eventIntervalMs() {
    const state = this.store.getState();
    const baseSpeed = state.frs === "sleep" ? 0.5 : state.frs === "relax" ? 0.75 : 1;
    const intensitySpeed = 1 + (clampBi(state.intensity) * 0.5);
    const frequency = Math.max(0.15, baseSpeed * intensitySpeed);
    return random(16000, 32000) / frequency;
  }

  #eligible(def, state) {
    if (this.suspended.has(def.id)) return false;
    if (!state.autoMix.enabled || state.transport.status !== "playing") return false;
    if (def.trackIndex !== undefined && state.tracks[def.trackIndex]?.mute) return false;
    if (def.type === "effect" && !state.effects[def.name]?.enabled) return false;
    return true;
  }

  #read(def, state = this.store.getState()) {
    if (def.type === "volume") return state.tracks[def.trackIndex].volume;
    if (def.type === "pan") return state.tracks[def.trackIndex].pan;
    if (def.type === "filter") return state.tracks[def.trackIndex].filter;
    if (def.type === "effect") return state.effects[def.name].level;
    return state.character[def.name];
  }

  #target(def, current) {
    const state = this.store.getState();
    const mode = def.type === "character" ? state.autoMix?.characterLevel : state.autoMix?.channelLevel;
    const amount = String(mode || "MED").toUpperCase() === "LOW" ? 0.65 : String(mode || "MED").toUpperCase() === "HIGH" ? 1.08 : 0.88;

    if (this.evolutionTargets.has(def.id)) {
      const phaseTarget = this.evolutionTargets.get(def.id);
      const min = def.type === "pan" ? -1 : 0;
      const max = def.type === "character" ? 0.92 : 1;
      return clamp(current + (phaseTarget - current) * amount, min, max);
    }

    // Fallback for parameters created outside a phase: still drift gently and
    // without treating the original preset as a ceiling.
    if (def.type === "volume") return clamp(current + random(-0.22, 0.22) * amount, 0.02, 0.98);
    if (def.type === "pan") return clampBi(current + random(-0.45, 0.45) * amount);
    if (def.type === "character") return clamp(current + random(-0.20, 0.20) * amount, 0, 0.92);
    return current;
  }

  #gameRange(def, baseline) {
    if (def.type === "volume") return [Math.max(0, baseline - 0.18), Math.min(1, baseline + 0.18)];
    if (def.type === "pan") return [Math.max(-1, baseline - 0.40), Math.min(1, baseline + 0.40)];
    if (def.type === "filter") return [Math.max(-1, baseline - 0.45), Math.min(1, baseline + 0.45)];
    if (def.type === "effect") return [Math.max(0, baseline - 0.30), Math.min(1, baseline + 0.30)];
    return [0, 1];
  }

  #gameTarget(def, current) {
    const baseline = this.baselines.has(def.id) ? this.baselines.get(def.id) : current;
    const [min, max] = this.#gameRange(def, baseline);
    const span = Math.max(0.0001, max - min);
    const offset = current - baseline;
    const rangeFromBase = offset >= 0 ? Math.max(0.0001, max - baseline) : Math.max(0.0001, baseline - min);
    const distanceRatio = Math.min(1, Math.abs(offset) / rangeFromBase);

    // Around the baseline, game hits are genuinely bidirectional. As a value
    // wanders toward the edge of its protected game range, gently favour a
    // move back toward the original position rather than imposing a hard wall.
    let upward;
    if (offset > 0 && distanceRatio > 0.55) upward = Math.random() >= 0.72;
    else if (offset < 0 && distanceRatio > 0.55) upward = Math.random() < 0.72;
    else upward = Math.random() < 0.5;

    const minStep = def.type === "filter" ? 0.18 : def.type === "pan" ? 0.14 : def.type === "volume" ? 0.05 : 0.06;
    const maxStep = def.type === "filter" ? 0.28 : def.type === "pan" ? 0.24 : def.type === "volume" ? 0.10 : 0.12;
    const step = random(minStep, maxStep);
    let target = clamp(current + (upward ? step : -step), min, max);

    // If a chosen direction was already hard against an edge, move the other
    // way so every game hit still produces an audible gesture.
    const threshold = (def.type === "pan" || def.type === "filter") ? 0.03 : 0.015;
    if (Math.abs(target - current) < threshold) target = clamp(current + (upward ? -step : step), min, max);
    return target;
  }

  triggerGameColorCleared(color) {
    const safeColor = String(color || "").toLowerCase();
    const ids = this.#gameColorMap()[safeColor];
    const state = this.store.getState();
    if (!ids || !this.active || !state.autoMix.enabled || state.transport.status !== "playing") return false;

    // A completed colour supersedes any ordinary hit gesture still running for
    // that colour. Reserve these controls until the celebration return ends.
    const hitTimer = this.gameColorTimers.get(safeColor);
    if (hitTimer) clearTimeout(hitTimer);
    this.gameColorTimers.delete(safeColor);
    this.gameColorPending.delete(safeColor);

    const oldTimers = this.gameColorCompletionTimers.get(safeColor);
    if (oldTimers) for (const timer of oldTimers) clearInterval(timer);
    const oldIds = this.gameColorCompletionIds.get(safeColor);
    if (oldIds) for (const id of oldIds) this.suspended.delete(id);

    const activeIds = [];
    const timers = [];
    const spikeMs = 650;
    const returnMs = 12000;

    for (const id of ids) {
      const def = this.definitions.find((item) => item.id === id);
      if (!def || !this.#eligible(def, state)) continue;

      const scheduled = this.scheduleTimers.get(id);
      if (scheduled) clearTimeout(scheduled);
      this.scheduleTimers.delete(id);
      this.#cancelMove(id);
      this.suspended.add(id);
      activeIds.push(id);

      const current = this.#read(def, this.store.getState());
      const baseline = this.baselines.has(id) ? this.baselines.get(id) : current;
      const [, safeMax] = this.#gameRange(def, baseline);
      // +20% of the remaining safe headroom gives a clear celebratory lift
      // without ever escaping the protected musical range.
      const spike = current + Math.max(0, safeMax - current) * 0.20;
      const started = performance.now();
      let phase = 'spike';
      let returnStart = 0;
      let returnFrom = spike;

      this.onStatus({ eventIncrement: 1, lastMove: `${id}:clear`, movingAdd: id });
      const timer = setInterval(() => {
        if (!this.active || this.store.getState().transport.status !== "playing") return;
        const now = performance.now();
        if (phase === 'spike') {
          const p = Math.min(1, (now - started) / spikeMs);
          const eased = 1 - Math.pow(1 - p, 3);
          this.applyValue(id, current + (spike - current) * eased);
          if (p >= 1) {
            phase = 'return';
            returnStart = now;
            returnFrom = spike;
          }
          return;
        }

        const p = Math.min(1, (now - returnStart) / returnMs);
        // Slow, smooth return to the original Auto Mix baseline.
        const eased = p * p * (3 - 2 * p);
        this.applyValue(id, returnFrom + (baseline - returnFrom) * eased);
        if (p >= 1) {
          clearInterval(timer);
          this.applyValue(id, baseline);
          this.suspended.delete(id);
          this.onStatus({ movingRemove: id });
          if (this.active) this.#schedule(id, true);
        }
      }, 50);
      timers.push(timer);
    }

    if (!activeIds.length) return false;
    this.gameColorCompletionTimers.set(safeColor, timers);
    this.gameColorCompletionIds.set(safeColor, activeIds);

    // Retire the colour reservation after every mapped parameter has completed.
    setTimeout(() => {
      if (this.gameColorCompletionTimers.get(safeColor) !== timers) return;
      this.gameColorCompletionTimers.delete(safeColor);
      this.gameColorCompletionIds.delete(safeColor);
    }, spikeMs + returnMs + 250);
    return true;
  }

  #durationMs(def, current, target) {
    const span = (def.type === "pan" || def.type === "filter") ? 2 : 1;
    const distance = Math.abs(target - current) / span;
    const base = def.type === "character" ? 18000 : def.type === "pan" ? 14500 : 16000;
    return base + distance * 26000 + random(0, 6500);
  }

  #perform(def, { forced = false, game = false } = {}) {
    const state = this.store.getState();
    if (!this.#eligible(def, state) && !forced) return false;
    if (this.moveTimers.has(def.id)) return false;
    const current = this.#read(def, state);
    const target = game ? this.#gameTarget(def, current) : this.#target(def, current);
    const threshold = (def.type === "pan" || def.type === "filter") ? 0.03 : 0.015;
    if (Math.abs(target - current) < threshold) return false;
    const duration = forced ? Math.min(2600, this.#durationMs(def, current, target)) : this.#durationMs(def, current, target);
    const tickMs = forced ? 50 : 100;
    const steps = Math.max(24, Math.round(duration / tickMs));
    let step = 0;
    this.onStatus({ eventIncrement: 1, lastMove: def.id, movingAdd: def.id });

    const timer = setInterval(() => {
      const liveState = this.store.getState();
      if (!this.active || !this.#eligible(def, liveState)) {
        this.#cancelMove(def.id);
        return;
      }
      step += 1;
      const progress = Math.min(1, step / steps);
      const eased = progress * progress * (3 - 2 * progress);
      const value = current + (target - current) * eased;
      this.applyValue(def.id, value);
      if (step >= steps) {
        clearInterval(timer);
        this.moveTimers.delete(def.id);
        this.applyValue(def.id, target);
        this.onStatus({ movingRemove: def.id });
      }
    }, tickMs);
    this.moveTimers.set(def.id, timer);
    return true;
  }

  #cancelMove(id) {
    const timer = this.moveTimers.get(id);
    if (timer) clearInterval(timer);
    if (this.moveTimers.delete(id)) this.onStatus({ movingRemove: id });
  }
}
