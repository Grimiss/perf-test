export class DevCoreView {
  constructor({ store, controller }) {
    this.store = store;
    this.controller = controller;
    this.trackElements = [];
    this.#buildTracks(store.getState());
    this.#bindTransport();
    this.#bindSoundscapes();
    this.#bindProcessing();
    this.#bindAutomation();
    this.#bindKeyboard();
    this.unsubscribe = store.subscribe((state, meta) => this.render(state, meta));
  }

  #buildTracks(state) {
    const host = document.querySelector("#tracks");
    host.innerHTML = "";
    state.tracks.forEach((track, index) => {
      const section = document.createElement("section");
      section.className = "track";
      section.dataset.index = String(index);
      section.innerHTML = `
        <div class="track-head"><h2>CH${index + 1}</h2><div class="track-name"></div></div>
        <div class="load-state">NOT LOADED</div>
        <div class="control-row">
          <label for="volume-${index}">VOLUME</label>
          <input id="volume-${index}" class="volume" type="range" min="0" max="100" step="1">
          <div class="value volume-value">0%</div>
        </div>
        <div class="control-row bipolar-row">
          <label for="pan-${index}">PAN</label>
          <span class="edge-label">L</span>
          <input id="pan-${index}" class="pan" type="range" min="-100" max="100" step="1">
          <span class="edge-label">R</span>
          <div class="value pan-value">C</div>
        </div>
        <div class="control-row bipolar-row filter-row">
          <label for="filter-${index}">FILTER</label>
          <span class="edge-label">LP</span>
          <input id="filter-${index}" class="filter" type="range" min="-100" max="100" step="1">
          <span class="edge-label">HP</span>
          <div class="value filter-value">0</div>
        </div>
        <div class="action-row">
          <button type="button" class="mute" aria-pressed="false">MUTE</button>
          <button type="button" class="solo" aria-pressed="false">SOLO</button>
          <div class="xfade" role="group" aria-label="CH${index + 1} loop crossfade">
            <span>XFADE</span>
            <button type="button" data-choice="1" aria-pressed="false" title="250 ms">1</button>
            <button type="button" data-choice="2" aria-pressed="false" title="750 ms">2</button>
            <button type="button" data-choice="3" aria-pressed="false" title="1500 ms">3</button>
          </div>
        </div>`;
      host.append(section);
      const refs = {
        root: section,
        name: section.querySelector(".track-name"),
        load: section.querySelector(".load-state"),
        volume: section.querySelector(".volume"),
        volumeValue: section.querySelector(".volume-value"),
        pan: section.querySelector(".pan"),
        panValue: section.querySelector(".pan-value"),
        filter: section.querySelector(".filter"),
        filterValue: section.querySelector(".filter-value"),
        mute: section.querySelector(".mute"),
        solo: section.querySelector(".solo"),
        xfade: [...section.querySelectorAll(".xfade button")]
      };
      refs.volume.addEventListener("input", (event) => this.controller.setTrackVolume(index, Number(event.target.value) / 100));
      refs.pan.addEventListener("input", (event) => this.controller.setTrackPan(index, Number(event.target.value) / 100));
      refs.filter.addEventListener("input", (event) => this.controller.setTrackFilter(index, Number(event.target.value) / 100));
      refs.mute.addEventListener("click", () => this.controller.toggleMute(index));
      refs.solo.addEventListener("click", () => this.controller.toggleSolo(index));
      refs.xfade.forEach((button) => button.addEventListener("click", () => this.controller.toggleXFade(index, Number(button.dataset.choice))));
      this.trackElements.push(refs);
    });
  }

  #bindTransport() {
    document.querySelector("#play-button").addEventListener("click", () => this.controller.play());
    document.querySelector("#pause-button").addEventListener("click", () => this.controller.pause());
    document.querySelector("#stop-button").addEventListener("click", () => this.controller.stop());
  }

  #bindSoundscapes() {
    document.querySelectorAll("[data-soundscape]").forEach((button) => {
      button.addEventListener("click", () => this.controller.selectSoundscape(button.dataset.soundscape));
    });
  }


  #bindProcessing() {
    this.effectElements = {};
    document.querySelectorAll("[data-effect]").forEach((root) => {
      const name = root.dataset.effect;
      const toggle = root.querySelector(".effect-toggle");
      const slider = root.querySelector(".effect-level");
      const value = root.querySelector(".effect-value");
      toggle.addEventListener("click", () => this.controller.toggleEffect(name));
      slider.addEventListener("input", (event) => this.controller.setEffectLevel(name, Number(event.target.value) / 100));
      this.effectElements[name] = { root, toggle, slider, value };
    });

    this.characterElements = {};
    document.querySelectorAll("[data-character]").forEach((root) => {
      const name = root.dataset.character;
      const slider = root.querySelector("input[type=range]");
      const value = root.querySelector(".character-value");
      slider.addEventListener("input", (event) => this.controller.setCharacter(name, Number(event.target.value) / 100));
      this.characterElements[name] = { slider, value };
    });

    document.querySelectorAll("[data-tape-type]").forEach((button) => {
      button.addEventListener("click", () => this.controller.setTapeType(button.dataset.tapeType));
    });

    this.toneSlider = document.querySelector("#master-tone");
    this.toneValue = document.querySelector("#master-tone-value");
    this.toneSlider.addEventListener("input", (event) => this.controller.setMasterTone(Number(event.target.value) / 100));
  }


  #bindAutomation() {
    this.autoMixButton = document.querySelector("#automix-toggle");
    this.autoMixButton.addEventListener("click", () => this.controller.toggleAutoMix());

    this.forceAutoMixButton = document.querySelector("#automix-force");
    this.forceAutoMixButton.addEventListener("click", () => this.controller.forceAutoMixEvent());

    this.specialEventButton = document.querySelector("#special-event-force");
    this.specialEventButton.addEventListener("click", () => this.controller.triggerSpecialEvent());

    document.querySelectorAll("[data-frs]").forEach((button) => {
      button.addEventListener("click", () => this.controller.setFRS(button.dataset.frs));
    });

    this.intensitySlider = document.querySelector("#intensity");
    this.intensityValue = document.querySelector("#intensity-value");
    this.intensitySlider.addEventListener("input", (event) => this.controller.setIntensity(Number(event.target.value) / 50));
  }

  #bindKeyboard() {
    window.addEventListener("keydown", (event) => {
      const isSpace = event.code === "Space" || event.key === " " || event.key === "Spacebar";
      if (!isSpace || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const isTextEditor = target instanceof HTMLElement && (
        target.isContentEditable || target.tagName === "TEXTAREA" ||
        (target.tagName === "INPUT" && !["range", "button", "checkbox", "radio"].includes((target.getAttribute("type") || "text").toLowerCase()))
      );
      if (isTextEditor) return;
      event.preventDefault();
      event.stopPropagation();
      const status = this.store.getState().transport.status;
      if (status === "playing") this.controller.pause();
      else this.controller.play();
    }, true);
  }

  render(state, meta) {
    const playing = state.transport.status === "playing";
    const paused = state.transport.status === "paused";
    document.querySelector("#engine-status").textContent = state.dev.engineStatus.toUpperCase();
    document.querySelector("#transport-status").textContent = state.transport.status.toUpperCase();
    document.querySelector("#soundscape-status").textContent = `${state.soundscape.id} · ${state.soundscape.name}`;
    document.querySelector("#context-state").textContent = String(state.dev.contextState).toUpperCase();
    document.querySelector("#state-revision").textContent = String(meta.revision);
    document.querySelector("#loaded-count").textContent = `${state.tracks.filter((track) => track.loaded).length} / 4`;
    document.querySelector("#solo-status").textContent = state.tracks.some((track) => track.solo) ? "YES" : "NO";

    document.querySelectorAll("[data-soundscape]").forEach((button) => {
      const selected = button.dataset.soundscape === state.soundscape.id;
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = state.soundscape.loading || !state.availableSoundscapes.includes(button.dataset.soundscape);
    });

    const notice = document.querySelector("#notice");
    notice.textContent = state.dev.message;
    notice.classList.toggle("error", Boolean(state.soundscape.error));
    notice.classList.toggle("success", state.soundscape.loaded && !state.soundscape.error);

    const playButton = document.querySelector("#play-button");
    const pauseButton = document.querySelector("#pause-button");
    const stopButton = document.querySelector("#stop-button");
    playButton.classList.toggle("is-active", playing);
    pauseButton.classList.toggle("is-active", paused);
    stopButton.classList.toggle("is-active", state.transport.status === "stopped");
    pauseButton.disabled = !playing;

    if (this.autoMixButton) {
      this.autoMixButton.setAttribute("aria-pressed", String(state.autoMix.enabled));
      this.autoMixButton.textContent = state.autoMix.enabled ? "AUTO MIX · ON" : "AUTO MIX · OFF";
    }
    if (this.forceAutoMixButton) this.forceAutoMixButton.disabled = !(playing && state.autoMix.enabled);
    if (this.specialEventButton) this.specialEventButton.disabled = !playing || state.specialEvent.active;
    document.querySelectorAll("[data-frs]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.frs === state.frs)));
    const intensityPercent = Math.round(state.intensity * 50);
    if (this.intensitySlider && document.activeElement !== this.intensitySlider) this.intensitySlider.value = String(intensityPercent);
    if (this.intensityValue) this.intensityValue.textContent = intensityPercent === 0 ? "0%" : `${intensityPercent > 0 ? "+" : ""}${intensityPercent}%`;
    const autoStatus = document.querySelector("#automix-status");
    const autoEvents = document.querySelector("#automix-events");
    const autoLast = document.querySelector("#automix-last");
    const autoMoving = document.querySelector("#automix-moving");
    if (autoStatus) autoStatus.textContent = state.autoMix.enabled ? (state.autoMix.active ? "ACTIVE" : "ARMED") : "OFF";
    if (autoEvents) autoEvents.textContent = String(state.autoMix.eventCount);
    if (autoLast) autoLast.textContent = state.autoMix.lastMove;
    if (autoMoving) autoMoving.textContent = state.autoMix.moving.length ? state.autoMix.moving.join(", ") : "—";
    const specialStatus = document.querySelector("#special-event-status");
    if (specialStatus) specialStatus.textContent = state.specialEvent.active ? state.specialEvent.stage : `IDLE · ${state.specialEvent.count}`;

    Object.entries(state.effects).forEach(([name, effect]) => {
      const refs = this.effectElements?.[name];
      if (!refs) return;
      refs.toggle.setAttribute("aria-pressed", String(effect.enabled));
      refs.toggle.textContent = effect.enabled ? "ON" : "OFF";
      const percent = Math.round(effect.level * 100);
      if (document.activeElement !== refs.slider) refs.slider.value = String(percent);
      refs.value.textContent = `${percent}%`;
      refs.root.classList.toggle("disabled-effect", !effect.enabled);
    });

    Object.entries(state.character).forEach(([name, amount]) => {
      const refs = this.characterElements?.[name];
      if (!refs) return;
      const percent = Math.round(amount * 100);
      if (document.activeElement !== refs.slider) refs.slider.value = String(percent);
      refs.value.textContent = `${percent}%`;
    });

    document.querySelectorAll("[data-tape-type]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.tapeType === state.tapeType));
    });

    const tonePercent = Math.round(state.master.tone * 100);
    if (this.toneSlider && document.activeElement !== this.toneSlider) this.toneSlider.value = String(tonePercent);
    if (this.toneValue) this.toneValue.textContent = tonePercent === 0 ? "0" : `${tonePercent > 0 ? "+" : ""}${tonePercent}`;
    const processingStatus = document.querySelector("#processing-status");
    if (processingStatus) processingStatus.textContent = `${state.tapeType.toUpperCase()} · ${state.frs.toUpperCase()}`;

    state.tracks.forEach((track, index) => {
      const refs = this.trackElements[index];
      refs.name.textContent = track.name;
      refs.load.textContent = track.loaded ? `LOADED · ${track.duration.toFixed(1)} s` : "NOT LOADED";
      const volumePercent = Math.round(track.volume * 100);
      const panPercent = Math.round(track.pan * 100);
      const filterPercent = Math.round(track.filter * 100);
      if (document.activeElement !== refs.volume) refs.volume.value = String(volumePercent);
      if (document.activeElement !== refs.pan) refs.pan.value = String(panPercent);
      if (document.activeElement !== refs.filter) refs.filter.value = String(filterPercent);
      refs.volumeValue.textContent = `${volumePercent}%`;
      refs.panValue.textContent = panPercent === 0 ? "C" : `${Math.abs(panPercent)}${panPercent < 0 ? "L" : "R"}`;
      refs.filterValue.textContent = filterPercent === 0 ? "0" : `${Math.abs(filterPercent)} ${filterPercent < 0 ? "LP" : "HP"}`;
      refs.mute.setAttribute("aria-pressed", String(track.mute));
      refs.solo.setAttribute("aria-pressed", String(track.solo));
      refs.xfade.forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.choice) === track.xfade)));
    });
  }
}
