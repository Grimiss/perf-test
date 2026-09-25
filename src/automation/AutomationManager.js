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
    const state = this.store.getState();
    for (const def of this.definitions) this.baselines.set(def.id, this.#read(def, state));
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
    for (const def of this.autoDefinitions) this.#schedule(def.id, true);
  }

  pause() {
    if (!this.active && this.scheduleTimers.size === 0 && this.moveTimers.size === 0) {
      this.onStatus({ active: false });
      return;
    }
    this.active = false;
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
    return random(9000, 18000) / frequency;
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
    const baseline = this.baselines.has(def.id) ? this.baselines.get(def.id) : current;
    const state = this.store.getState();
    const mode = def.type === "character" ? state.autoMix?.characterLevel : state.autoMix?.channelLevel;
    const amount = String(mode || "MED").toUpperCase() === "LOW" ? 0.55 : String(mode || "MED").toUpperCase() === "HIGH" ? 1.45 : 1;
    if (def.type === "effect") {
      const min = Math.max(0, baseline - 0.30);
      const max = Math.min(1, baseline + 0.30);
      let target = current + random(-0.08, 0.08);
      if (target < min) target = min + (min - target);
      if (target > max) target = max - (target - max);
      return clamp(target, min, max);
    }

    if (def.type === "volume") {
      const distanceBelow = Math.max(0, baseline - current);
      let target;
      if (distanceBelow > 0.06) {
        const recoveryChance = Math.min(0.90, 0.65 + distanceBelow * 1.5);
        target = Math.random() < recoveryChance ? current + random(0.035, 0.085) : current - random(0.020, 0.050);
      } else {
        target = Math.random() < 0.58 ? current + random(0.025, 0.070) : current - random(0.025, 0.070);
      }
      return clamp(current + (target-current)*amount, 0, Math.max(0, baseline));
    }

    if (def.type === "pan") {
      let normalized = (clampBi(current) + 1) / 2;
      normalized += random(-0.20, 0.20);
      if (Math.random() < 0.08) normalized = random(0.15, 0.85);
      const rawTarget = clampBi(clamp01(normalized) * 2 - 1);
      return clampBi(current + (rawTarget-current)*amount);
    }

    if (def.type === "filter") {
      // The final D8M4 filter is bipolar (LP ← neutral → HP), unlike the old
      // one-sided strength control. Preserve the old gentle movement character
      // while allowing travel on either side of neutral.
      const min = Math.max(-1, clampBi(baseline) - 0.60);
      const max = Math.min(1, clampBi(baseline) + 0.60);
      let target = current + random(-0.20, 0.20);
      if (Math.random() < 0.08) target = random(Math.max(min, -0.65), Math.min(max, 0.65));
      return clamp(target, min, max);
    }

    // Character: deliberately subtler than track/filter motion.
    const min = Math.max(0, baseline - 0.30);
    const max = Math.min(1, baseline + 0.30);
    const step = Math.random() < 0.08 ? random(-0.20, 0.20) : random(-0.065, 0.065);
    return clamp(current + step*amount, min, max);
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
    return 4500 + distance * 7000;
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
    const steps = Math.max(24, Math.round(duration / 50));
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
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = current + (target - current) * eased;
      this.applyValue(def.id, value);
      if (step >= steps) {
        clearInterval(timer);
        this.moveTimers.delete(def.id);
        this.applyValue(def.id, target);
        this.onStatus({ movingRemove: def.id });
      }
    }, 50);
    this.moveTimers.set(def.id, timer);
    return true;
  }

  #cancelMove(id) {
    const timer = this.moveTimers.get(id);
    if (timer) clearInterval(timer);
    if (this.moveTimers.delete(id)) this.onStatus({ movingRemove: id });
  }
}
