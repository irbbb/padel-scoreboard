import { normalizeWristCenterMode, WRIST_CENTER_MODES } from '../core/wristEditMode.js';

export const DEFAULTS_STORAGE_KEY = 'padelScore.defaults.v1';

export const DEFAULT_MATCH_SETTINGS = Object.freeze({
  scoringMode: 'AD',
  initialServer: null,
  wristCenterMode: WRIST_CENTER_MODES.EDIT_MODE,
});

function normalizeInitialServer(value) {
  if (value === 0) return 0;
  if (value === 1) return 1;
  return null;
}

function normalizeScoringMode(value) {
  return value === 'GP' ? 'GP' : 'AD';
}

/**
 * Loads saved New Match defaults fault-tolerantly.
 * Never throws: missing, unreadable, or corrupt defaults fall back to AD + Pick on watch + EDIT_MODE.
 * Honors every valid stored value (including explicit ONE_TAP_UE) while preserving scoringMode & initialServer.
 */
export function loadMatchDefaults(storage, storageKey = DEFAULTS_STORAGE_KEY) {
  if (!storage || typeof storage.getItem !== 'function') {
    return { ...DEFAULT_MATCH_SETTINGS };
  }
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null) return { ...DEFAULT_MATCH_SETTINGS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_MATCH_SETTINGS };
    }
    return {
      scoringMode: normalizeScoringMode(parsed.scoringMode),
      initialServer: normalizeInitialServer(parsed.initialServer),
      wristCenterMode: normalizeWristCenterMode(parsed.wristCenterMode),
    };
  } catch {
    return { ...DEFAULT_MATCH_SETTINGS };
  }
}

/**
 * Persists New Match defaults without throwing so a quota failure on defaults
 * never blocks starting a match. Preserves explicit null (Pick on watch), 0 (US), and 1 (THEM).
 */
export function saveMatchDefaults(storage, settings, storageKey = DEFAULTS_STORAGE_KEY) {
  const payload = {
    scoringMode: normalizeScoringMode(settings?.scoringMode),
    initialServer: normalizeInitialServer(settings?.initialServer),
    wristCenterMode: normalizeWristCenterMode(settings?.wristCenterMode),
  };
  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, error: new Error('Storage unavailable') };
  }
  try {
    storage.setItem(storageKey, JSON.stringify(payload));
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err };
  }
}
