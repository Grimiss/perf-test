export class SoundscapeRepository {
  constructor({ manifestUrl = "assets/manifest.json", presetBaseUrl = "data/presets" } = {}) {
    this.manifestUrl = manifestUrl;
    this.presetBaseUrl = presetBaseUrl;
    this.manifest = null;
  }

  async init() {
    const response = await fetch(this.manifestUrl);
    if (!response.ok) throw new Error(`Asset manifest failed to load: HTTP ${response.status}`);
    this.manifest = await response.json();
  }

  async getSoundscape(id) {
    if (!this.manifest) await this.init();
    const response = await fetch(`${this.presetBaseUrl}/${id}.json`);
    if (!response.ok) throw new Error(`${id} preset failed to load: HTTP ${response.status}`);
    const preset = await response.json();
    if (!Array.isArray(preset.tracks) || preset.tracks.length !== 4) {
      throw new Error(`${id} preset must contain exactly four tracks.`);
    }
    return {
      ...preset,
      tracks: preset.tracks.map((track) => {
        const asset = this.manifest.assets[track.assetId];
        if (!asset || asset.type !== "audio") throw new Error(`Missing required audio asset mapping: ${track.assetId}`);
        return { ...track, assetUrl: asset.path };
      })
    };
  }
}
