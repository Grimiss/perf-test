const STORAGE_KEY = 'D8M4_PERFORMANCE_PROFILE';
const SAFE = 'safe';
const SMOOTH = 'smooth';

const PROFILES = Object.freeze({
  safe: Object.freeze({
    name: SAFE,
    automationVisualMs: 200,
    liveControlMs: 67,
    fxModFlushMs: 125,
    scopeFrameMs: 67,
    volumeCommitMs: 67
  }),
  smooth: Object.freeze({
    name: SMOOTH,
    automationVisualMs: 67,
    liveControlMs: 33,
    fxModFlushMs: 50,
    scopeFrameMs: 33,
    volumeCommitMs: 33
  })
});

function normalize(value) {
  return String(value || '').toLowerCase() === SMOOTH ? SMOOTH : SAFE;
}

export function getPerformanceMode() {
  try { return normalize(localStorage.getItem(STORAGE_KEY)); }
  catch { return SAFE; }
}

export function getPerformanceProfile() {
  return PROFILES[getPerformanceMode()];
}

export function setPerformanceMode(mode) {
  const next = normalize(mode);
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  window.dispatchEvent(new CustomEvent('d8m4-performance-mode', { detail: { mode: next, profile: PROFILES[next] } }));
  return next;
}

export function togglePerformanceMode() {
  return setPerformanceMode(getPerformanceMode() === SAFE ? SMOOTH : SAFE);
}
