const running = new Set();
let timer = null;
const durations = [0, 0.250, 0.750, 1.500];
const forecasts = new WeakMap();

function watch(controller) {
  if (controller.choice || controller.plan) running.add(controller);
  else running.delete(controller);
  if (running.size && timer === null) {
    timer = setInterval(() => {
      for (const item of [...running]) item.tick();
    }, 25);
  }
  if (!running.size && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function forecast(clock, time) {
  const revision = [
    clock.rateTime, clock.rate,
    ...clock.oscillators.flatMap((o) => [o.time, o.frequency, o.depth, o.frequencyConstant, o.depthConstant])
  ].join(",");
  let cache = forecasts.get(clock);
  if (!cache || cache.revision !== revision) {
    cache = { revision, values: new Map() };
    forecasts.set(clock, cache);
  }
  const step = 1 / 16;
  const lower = Math.floor(time / step) * step;
  const latest = Math.max(clock.rateTime, ...clock.oscillators.map((o) => o.time));
  const sample = (t) => {
    if (!cache.values.has(t)) {
      if (cache.values.size >= 1024) cache.values.clear();
      cache.values.set(t, clock.value(t));
    }
    return cache.values.get(t);
  };
  if (lower - step < latest) return sample(time);
  const u = (time - lower) / step;
  return -u * (u - 1) * (u - 2) / 6 * sample(lower - step) +
    (u + 1) * (u - 1) * (u - 2) / 2 * sample(lower) -
    (u + 1) * u * (u - 2) / 2 * sample(lower + step) +
    (u + 1) * u * (u - 1) / 6 * sample(lower + 2 * step);
}

export class LoopCrossfade {
  static durations = durations;
  static schedulerCount = () => running.size;

  constructor({ context, clock, length, createVoice, adopt, report = () => {}, onBoundaryPlan = () => {}, onBoundarySettled = () => {}, choice = 0 }) {
    Object.assign(this, { context, clock, length, createVoice, adopt, report, onBoundaryPlan, onBoundarySettled, choice });
    this.primary = null;
    this.plan = null;
    this.completed = 0;
  }

  get voices() {
    return this.plan ? [this.primary, this.plan.incoming] : this.primary ? [this.primary] : [];
  }

  progress(time) { return this.clock.value(time); }

  positionOf(voice, time) {
    const advance = time <= voice.startTime ? 0 : this.progress(time) - voice.positionClock;
    return ((voice.positionOffset + advance) % this.length + this.length) % this.length;
  }

  timeAt(goal, from = this.context.currentTime) {
    if (goal <= forecast(this.clock, from)) return from;
    let lo = from;
    let hi = from + Math.max(0.1, (goal - forecast(this.clock, from)) * 3);
    while (forecast(this.clock, hi) < goal) hi = from + (hi - from) * 2;
    for (let i = 0; i < 36; i += 1) {
      const mid = (lo + hi) / 2;
      if (forecast(this.clock, mid) < goal) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  start(offset, when, saved = null, existing = null, defer = false) {
    this.primary = existing || this.createVoice(offset, when);
    this.primary.attachGain();
    this.primary.gain.gain.setValueAtTime(1, when);
    this.adopt(this.primary);
    if (saved?.overlap) {
      const incoming = this.createVoice(saved.incomingPosition, when);
      const start = this.progress(when) - saved.fraction * saved.span;
      this.plan = {
        incoming, start, end: start + saved.span, span: saved.span,
        startTime: when, resumedFraction: saved.fraction
      };
      this.primary.gain.gain.setValueAtTime(Math.cos(saved.fraction * Math.PI / 2), when);
      incoming.gain.gain.setValueAtTime(Math.sin(saved.fraction * Math.PI / 2), when);
      const endTime = this.timeAt(this.plan.end, when);
      this.plan.endTime = endTime;
      this.onBoundaryPlan({ startTime: when, endTime, effective: Math.max(0, endTime - when), resumed: true });
    }
    if (!defer) this.activate();
    watch(this);
  }

  activate() {
    if (this.plan) this.envelope(this.context.currentTime);
    else this.schedule(this.context.currentTime);
  }

  schedule(now) {
    if (!this.choice || this.plan || !this.primary) return;
    const voice = this.primary;
    const base = Math.max(now, voice.startTime);
    const raw = voice.positionOffset + this.progress(base) - voice.positionClock;
    let end = voice.positionClock + (Math.floor(raw / this.length) + 1) * this.length - voice.positionOffset;
    const lead = Math.min(0.035, this.length / 10);
    while (end <= this.progress(base + lead)) end += this.length;
    const endTime = this.timeAt(end, base);
    const halfLoopStart = this.timeAt(end - this.length / 2, base);
    const earliest = Math.max(base + lead, halfLoopStart);
    const startTime = Math.max(endTime - durations[this.choice], earliest);
    const start = this.progress(startTime);
    const span = end - start;
    const effective = endTime - startTime;
    this.report({
      requested: durations[this.choice], effective,
      clamped: effective + 0.0001 < durations[this.choice],
      reason: halfLoopStart >= base + lead ? "half the loop" : "time remaining before the boundary"
    });
    this.onBoundaryPlan({ startTime, endTime, effective, resumed: false });
    const incoming = this.createVoice(0, startTime);
    this.plan = { incoming, start, end, span, startTime, endTime };
    this.envelope(now);
  }

  envelope(now) {
    const p = this.plan;
    if (!p) return;
    const endTime = this.timeAt(p.end, now);
    p.endTime = endTime;
    const begin = Math.max(now, p.startTime);
    const fraction = (time) => Math.max(0, Math.min(1, (forecast(this.clock, time) - p.start) / p.span));
    const outgoing = this.primary.gain.gain;
    const incoming = p.incoming.gain.gain;
    for (const param of [outgoing, incoming]) {
      if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
      else param.cancelScheduledValues(now);
    }
    const u = fraction(now);
    outgoing.setValueAtTime(Math.cos(u * Math.PI / 2), now);
    incoming.setValueAtTime(Math.sin(u * Math.PI / 2), now);
    if (begin > now) {
      outgoing.setValueAtTime(Math.cos(fraction(begin) * Math.PI / 2), begin);
      incoming.setValueAtTime(Math.sin(fraction(begin) * Math.PI / 2), begin);
    }
    const count = Math.max(32, Math.ceil((endTime - begin) / 0.016));
    for (let i = 1; i <= count; i += 1) {
      const time = begin + (endTime - begin) * i / count;
      const phase = fraction(time) * Math.PI / 2;
      outgoing.linearRampToValueAtTime(i === count ? 0 : Math.cos(phase), time);
      incoming.linearRampToValueAtTime(i === count ? 1 : Math.sin(phase), time);
    }
  }

  settle(now) {
    if (this.plan && this.progress(now) >= this.plan.end) {
      this.primary.dispose();
      this.primary = this.plan.incoming;
      this.plan = null;
      this.completed += 1;
      this.adopt(this.primary);
      this.onBoundarySettled(this.completed);
    }
  }

  tick() {
    const now = this.context.currentTime;
    this.settle(now);
    this.schedule(now);
    watch(this);
  }

  cancelPending(now) {
    if (this.plan && this.plan.resumedFraction === undefined && now < this.plan.startTime) {
      this.plan.incoming.dispose();
      this.plan = null;
      this.primary.gain.gain.cancelScheduledValues(now);
      this.primary.gain.gain.setValueAtTime(1, now);
    }
  }

  select(choice) {
    const now = this.context.currentTime;
    this.settle(now);
    this.cancelPending(now);
    this.choice = choice;
    this.schedule(now);
    watch(this);
  }

  snapshot(now) {
    this.settle(now);
    const saved = { position: this.positionOf(this.primary, now) };
    if (this.plan && (now >= this.plan.startTime || this.plan.resumedFraction !== undefined)) {
      Object.assign(saved, {
        overlap: true,
        incomingPosition: this.positionOf(this.plan.incoming, now),
        fraction: now < this.plan.startTime
          ? this.plan.resumedFraction
          : Math.max(0, Math.min(1, (this.progress(now) - this.plan.start) / this.plan.span)),
        span: this.plan.span
      });
    }
    return saved;
  }

  stop() {
    for (const voice of this.voices) voice.dispose();
    this.primary = null;
    this.plan = null;
    running.delete(this);
    if (!running.size && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }
}
