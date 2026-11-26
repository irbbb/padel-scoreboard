export const DEFAULTS_STORAGE_KEY = 'padelScore.defaults.v1';

export const DEFAULT_MATCH_SETTINGS = Object.freeze({
  scoringMode: 'AD',
  initialServer: null,
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
 * Never throws: missing, unreadable, or corrupt defaults fall back to AD + Pick on watch (null).
 * Legacy defaults like `{ initialServer: 0 }` migrate cleanly to `{ scoringMode: 'AD', initialServer: 0 }`.
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
