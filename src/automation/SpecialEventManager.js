const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export class SpecialEventManager {
  constructor({ readLevel, applyLevel, suspendAutomation, resumeAutomation, onStatus = () => {} }) {
    this.readLevel = readLevel;
    this.applyLevel = applyLevel;
    this.suspendAutomation = suspendAutomation;
    this.resumeAutomation = resumeAutomation;
    this.onStatus = onStatus;
    this.active = false;
    this.timer = null;
    this.generation = 0;
    this.baseline = null;
  }

  trigger(source = "dev") {
    if (this.active) return false;
    const delay = clamp01(this.readLevel("delay"));
    const reverb = clamp01(this.readLevel("reverb"));
    this.baseline = { delay, reverb };
    this.active = true;
    this.generation += 1;
    const generation = this.generation;

    this.suspendAutomation("effect:delay");
    this.suspendAutomation("effect:reverb");
    this.onStatus({ active: true, stage: "SPIKE", source, increment: 1 });

    const attackMs = 220;
    const holdMs = 180;
    const recoveryMs = 5200;
    const start = performance.now();

    const step = () => {
      if (!this.active || generation !== this.generation) return;
      const elapsed = performance.now() - start;
      let delayValue;
      let reverbValue;
      let stage;

      if (elapsed < attackMs) {
        const p = elapsed / attackMs;
        const eased = 1 - Math.pow(1 - p, 3);
        delayValue = delay + (1 - delay) * eased;
        reverbValue = reverb + (1 - reverb) * eased;
        stage = "SPIKE";
      } else if (elapsed < attackMs + holdMs) {
        delayValue = 1;
        reverbValue = 1;
        stage = "HOLD";
      } else {
        const recoveryElapsed = elapsed - attackMs - holdMs;
        const p = Math.min(1, recoveryElapsed / recoveryMs);
        // Slow, smooth return with most of the movement happening gradually.
        const eased = p * p * (3 - 2 * p);
        delayValue = 1 + (delay - 1) * eased;
        reverbValue = 1 + (reverb - 1) * eased;
        stage = "RECOVER";
        if (p >= 1) {
          this.applyLevel("delay", delay);
          this.applyLevel("reverb", reverb);
          this.#finish();
          return;
        }
      }

      this.applyLevel("delay", clamp01(delayValue));
      this.applyLevel("reverb", clamp01(reverbValue));
      this.onStatus({ active: true, stage, source });
      this.timer = window.setTimeout(step, 40);
    };

    step();
    return true;
  }

  cancel({ restore = true } = {}) {
    if (!this.active) return;
    this.generation += 1;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    if (restore && this.baseline) {
      this.applyLevel("delay", this.baseline.delay);
      this.applyLevel("reverb", this.baseline.reverb);
    }
    this.#finish();
  }

  #finish() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.active = false;
    this.resumeAutomation("effect:delay");
    this.resumeAutomation("effect:reverb");
    this.onStatus({ active: false, stage: "IDLE" });
    this.baseline = null;
  }
}
