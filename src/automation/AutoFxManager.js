const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const random = (a, b) => a + Math.random() * (b - a);
const FX = ['tremolo', 'delay', 'reverb', 'width'];

export class AutoFxManager {
  constructor({ store, applyLevel, beginOverride = () => {}, endOverride = () => {}, onStatus = () => {} }) {
    this.store = store;
    this.applyLevel = applyLevel;
    this.beginOverride = beginOverride;
    this.endOverride = endOverride;
    this.onStatus = onStatus;
    this.waitTimer = null;
    this.motionTimer = null;
    this.activeNames = [];
    this.lastNames = [];
    this.generation = 0;
    this.homeLevels = null;
    this.nextHomeVisitAt = 0;
  }

  #captureHome(force = false) {
    if (this.homeLevels && !force) return;
    const s = this.store.getState();
    this.homeLevels = Object.fromEntries(FX.map((n) => [n, clamp01(s.effects[n]?.level)]));
    this.nextHomeVisitAt = performance.now() + random(15 * 60 * 1000, 20 * 60 * 1000);
  }

  onSoundscapeChanged() {
    this.stop(false);
    this.homeLevels = null;
    this.nextHomeVisitAt = 0;
    this.lastNames = [];
    if (this.store.getState().autoFx?.enabled && this.store.getState().transport.status === 'playing') {
      this.#captureHome(true);
      this.schedule(true);
    }
  }

  setEnabled(enabled) {
    if (!enabled) {
      this.stop(true);
      return;
    }
    this.#captureHome();
    if (this.store.getState().transport.status === 'playing') this.schedule(true);
  }

  onTransport(status) {
    if (status === 'playing' && this.store.getState().autoFx?.enabled) {
      this.#captureHome();
      this.schedule(true);
    } else {
      this.stop(true);
    }
  }

  settingsChanged() {
    if (this.store.getState().autoFx?.enabled && this.store.getState().transport.status === 'playing' && !this.activeNames.length) this.schedule(true);
  }

  stop(restore = false) {
    this.generation += 1;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    if (this.motionTimer) clearInterval(this.motionTimer);
    this.waitTimer = null;
    this.motionTimer = null;
    if (restore && this.activeNames.length) {
      const state = this.store.getState();
      for (const n of this.activeNames) {
        const base = state.autoFx?.baselines?.[n];
        if (Number.isFinite(base)) this.applyLevel(n, base);
        this.endOverride(`effect:${n}`);
      }
    } else {
      for (const n of this.activeNames) this.endOverride(`effect:${n}`);
    }
    this.activeNames = [];
    this.onStatus({ active: false, activeEffects: [] });
  }

  schedule(immediate = false) {
    if (this.waitTimer || this.motionTimer || this.activeNames.length) return;
    const s = this.store.getState();
    if (!s.autoFx?.enabled || s.transport.status !== 'playing') return;
    const freq = String(s.autoFx.frequency || 'MED').toUpperCase();
    const ranges = { LOW: [55000, 110000], MED: [30000, 65000], HIGH: [16000, 36000] };
    const [a, b] = ranges[freq] || ranges.MED;
    const delay = immediate ? 1800 : random(a, b);
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null;
      this.runEvent();
    }, delay);
  }

  chooseCount() {
    const mode = String(this.store.getState().autoFx?.countMode || '1').toUpperCase();
    if (mode === 'ALL') return 4;
    if (mode === 'RND') {
      const r = Math.random();
      return r < 0.38 ? 1 : r < 0.70 ? 2 : r < 0.90 ? 3 : 4;
    }
    return Math.max(1, Math.min(3, Number(mode) || 1));
  }

  chooseNames(count) {
    const s = this.store.getState();
    const enabled = FX.filter((n) => s.effects[n]?.enabled !== false);
    const pool = enabled.length ? enabled : [...FX];
    count = Math.min(count, pool.length);
    const chosen = [];
    while (chosen.length < count) {
      const candidates = pool.filter((n) => !chosen.includes(n));
      const weights = candidates.map((n) => this.lastNames.includes(n) ? 0.22 : 1);
      let pick = Math.random() * weights.reduce((x, y) => x + y, 0);
      let selected = candidates[candidates.length - 1];
      for (let i = 0; i < candidates.length; i += 1) {
        pick -= weights[i];
        if (pick <= 0) {
          selected = candidates[i];
          break;
        }
      }
      chosen.push(selected);
    }
    return chosen;
  }

  #downTarget(current, deep = false) {
    if (deep && Math.random() < 0.62) return random(0.015, 0.10);
    return clamp01(current - random(0.18, 0.55));
  }

  #upTarget(current, strong = false) {
    const floor = strong ? 0.70 : 0.52;
    return clamp01(random(Math.max(floor, current + 0.10), 0.98));
  }

  #freeTarget() {
    const r = Math.random();
    if (r < 0.12) return random(0.015, 0.10);
    if (r < 0.36) return random(0.10, 0.34);
    if (r < 0.67) return random(0.32, 0.68);
    if (r < 0.93) return random(0.66, 0.93);
    return random(0.90, 0.99);
  }

  #chooseTargets(names, baselines, homeVisit = false) {
    const targets = {};
    if (homeVisit && this.homeLevels) {
      for (const n of names) targets[n] = clamp01(this.homeLevels[n] + random(-0.07, 0.07));
      return targets;
    }

    const roll = Math.random();
    const shuffled = [...names].sort(() => Math.random() - 0.5);

    if (roll < 0.16 && names.includes('tremolo')) {
      // Tremolo-focus passage: let the rhythmic movement breathe while other
      // participating effects recede.
      for (const n of names) targets[n] = n === 'tremolo' ? this.#upTarget(baselines[n], true) : this.#downTarget(baselines[n], true);
    } else if (roll < 0.34 && (names.includes('delay') || names.includes('reverb'))) {
      // Wash passage: delay/reverb can become much more intense than the
      // original preset, while the other selected effects usually make room.
      for (const n of names) {
        if (n === 'delay' || n === 'reverb') targets[n] = this.#upTarget(baselines[n], true);
        else targets[n] = Math.random() < 0.72 ? this.#downTarget(baselines[n], false) : this.#freeTarget();
      }
    } else if (roll < 0.58) {
      // Redistribution: where something retreats there is often, but not
      // always, a lift elsewhere. With ALL this frequently becomes 2-down/2-up.
      if (shuffled.length === 1) {
        const n = shuffled[0];
        targets[n] = Math.random() < 0.52 ? this.#downTarget(baselines[n], Math.random() < 0.35) : this.#upTarget(baselines[n], Math.random() < 0.35);
      } else {
        const downCount = Math.max(1, Math.floor(shuffled.length / 2));
        shuffled.forEach((n, i) => {
          if (i < downCount) targets[n] = this.#downTarget(baselines[n], Math.random() < 0.35);
          else targets[n] = Math.random() < 0.76 ? this.#upTarget(baselines[n], Math.random() < 0.30) : this.#freeTarget();
        });
      }
    } else if (roll < 0.73) {
      // Ebb: no compensation this time; selected processing simply thins out.
      for (const n of names) targets[n] = this.#downTarget(baselines[n], Math.random() < 0.42);
    } else if (roll < 0.86) {
      // Surge: a temporary denser, more processed section.
      for (const n of names) targets[n] = this.#upTarget(baselines[n], Math.random() < 0.48);
    } else {
      // Free evolution: broad weighted values, including rare near-zero and
      // near-full-scale destinations.
      for (const n of names) targets[n] = this.#freeTarget();
    }
    return targets;
  }

  runEvent() {
    const s = this.store.getState();
    if (!s.autoFx?.enabled || s.transport.status !== 'playing') return;
    this.#captureHome();
    const names = this.chooseNames(this.chooseCount());
    if (!names.length) {
      this.schedule();
      return;
    }

    const baselines = {};
    for (const n of names) {
      baselines[n] = clamp01(s.effects[n]?.level);
      this.beginOverride(`effect:${n}`);
    }

    const homeVisit = this.nextHomeVisitAt > 0 && performance.now() >= this.nextHomeVisitAt;
    const targets = this.#chooseTargets(names, baselines, homeVisit);
    if (homeVisit) this.nextHomeVisitAt = performance.now() + random(15 * 60 * 1000, 20 * 60 * 1000);

    this.activeNames = [...names];
    this.lastNames = [...names];
    this.onStatus({ active: true, activeEffects: [...names], baselines });

    const generation = ++this.generation;
    const started = performance.now();
    const specs = Object.fromEntries(names.map((n, index) => [n, {
      start: baselines[n],
      target: targets[n],
      delayMs: index === 0 ? random(0, 1800) : random(800, 6500),
      durationMs: random(18000, 43000),
      holdMs: random(5000, 15000),
      released: false
    }]));

    this.motionTimer = setInterval(() => {
      if (generation !== this.generation) return;
      const live = this.store.getState();
      if (!live.autoFx?.enabled || live.transport.status !== 'playing') {
        this.stop(true);
        return;
      }

      const now = performance.now();
      const remaining = [];
      for (const n of names) {
        const spec = specs[n];
        if (spec.released) continue;
        const elapsed = now - started - spec.delayMs;
        if (elapsed < 0) {
          remaining.push(n);
          continue;
        }
        const p = Math.min(1, elapsed / spec.durationMs);
        const eased = p * p * (3 - 2 * p);
        this.applyLevel(n, spec.start + (spec.target - spec.start) * eased);
        if (p >= 1 && elapsed >= spec.durationMs + spec.holdMs) {
          this.applyLevel(n, spec.target);
          this.endOverride(`effect:${n}`);
          spec.released = true;
        } else {
          remaining.push(n);
        }
      }

      this.activeNames = remaining;
      this.onStatus({ active: remaining.length > 0, activeEffects: [...remaining] });
      if (!remaining.length) {
        clearInterval(this.motionTimer);
        this.motionTimer = null;
        this.onStatus({ active: false, activeEffects: [], lastEffects: [...names] });
        this.schedule();
      }
    }, 100);
  }
}
