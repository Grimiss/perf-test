const TAU = 2 * Math.PI;
const valueAt = (initial, target, constant, elapsed) =>
  constant ? target + (initial - target) * Math.exp(-elapsed / constant) : target;
const phaseAt = (osc, elapsed) => osc.phase + TAU * (
  osc.frequency * elapsed +
  (osc.frequencyInitial - osc.frequency) * osc.frequencyConstant *
  (1 - Math.exp(-elapsed / (osc.frequencyConstant || 1)))
);

function integral(osc, time) {
  const elapsed = Math.max(0, time - osc.time);
  const settling = Math.max(
    osc.frequencyInitial === osc.frequency ? 0 : 24 * osc.frequencyConstant,
    osc.depthInitial === osc.depth ? 0 : 24 * osc.depthConstant
  );
  const end = Math.min(elapsed, settling);
  const cached = elapsed >= settling ? osc.settled : null;
  let area = cached ? cached.area : 0;
  if (!cached && end > 0) {
    const steps = Math.ceil(end * 2048);
    const step = end / steps;
    for (let i = 0; i < steps; i += 1) {
      const t = (i + 0.5) * step;
      area += valueAt(osc.depthInitial, osc.depth, osc.depthConstant, t) * Math.sin(phaseAt(osc, t)) * step;
    }
  }
  if (!cached && elapsed >= settling) osc.settled = { area, phase: phaseAt(osc, end) };
  if (elapsed > end) {
    const phase = cached ? cached.phase : phaseAt(osc, end);
    const omega = TAU * osc.frequency;
    area += omega
      ? osc.depth * (Math.cos(phase) - Math.cos(phase + omega * (elapsed - end))) / omega
      : osc.depth * Math.sin(phase) * (elapsed - end);
  }
  return area;
}

export class TransportClock {
  constructor(rate = 1, sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.rate = rate;
    this.rateBefore = rate;
    this.rateTime = 0;
    this.rateArea = 0;
    this.oscillators = [];
    this.cacheTime = null;
    this.cacheValue = 0;
  }

  startModulation(time, frequencies = []) {
    this.cacheTime = null;
    this.oscillators = frequencies.map((frequency) => ({
      time, phase: 0, area: 0,
      frequency, frequencyInitial: frequency, frequencyConstant: 0,
      depth: 0, depthInitial: 0, depthConstant: 0
    }));
  }

  value(time) {
    if (this.cacheTime === time) return this.cacheValue;
    this.cacheTime = time;
    this.cacheValue = this.rateArea +
      (time - this.rateTime) * (time < this.rateTime ? this.rateBefore : this.rate) +
      this.oscillators.reduce((sum, osc) => sum + osc.area + integral(osc, time), 0);
    return this.cacheValue;
  }

  setRate(rate, time) {
    this.cacheTime = null;
    const quantum = 128 / this.sampleRate;
    time = Math.ceil(time / quantum - 1e-8) * quantum;
    this.rateArea += (time - this.rateTime) * this.rate;
    if (time > this.rateTime) this.rateBefore = this.rate;
    this.rateTime = time;
    this.rate = rate;
  }

  target(index, property, target, time, constant) {
    this.cacheTime = null;
    const osc = this.oscillators[index];
    if (!osc) return;
    const elapsed = Math.max(0, time - osc.time);
    osc.area += integral(osc, time);
    osc.phase = phaseAt(osc, elapsed) % TAU;
    osc.frequencyInitial = valueAt(osc.frequencyInitial, osc.frequency, osc.frequencyConstant, elapsed);
    osc.depthInitial = valueAt(osc.depthInitial, osc.depth, osc.depthConstant, elapsed);
    osc.time = time;
    osc[property] = target;
    osc[`${property}Constant`] = constant;
    osc.settled = null;
  }
}
