export const DEFAULTS_STORAGE_KEY = 'padelScore.defaults.v1';

export const DEFAULT_MATCH_SETTINGS = Object.freeze({
  initialServer: 0,
});

/**
 * Loads saved New Match defaults fault-tolerantly.
 * Never throws: missing, unreadable, or corrupt defaults fall back to team 0 (US).
 */
export function loadMatchDefaults(storage, storageKey = DEFAULTS_STORAGE_KEY) {
  if (!storage || typeof storage.getItem !== 'function') {
    return { ...DEFAULT_MATCH_SETTINGS };
  }
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null) return { ...DEFAULT_MATCH_SETTINGS };
    const parsed = JSON.parse(raw);
    const initialServer = parsed?.initialServer === 1 ? 1 : 0;
    return { initialServer };
  } catch {
    return { ...DEFAULT_MATCH_SETTINGS };
  }
}

/**
 * Persists New Match defaults without throwing so a quota failure on defaults
 * never blocks starting a match.
 */
export function saveMatchDefaults(storage, settings, storageKey = DEFAULTS_STORAGE_KEY) {
  const initialServer = settings?.initialServer === 1 ? 1 : 0;
  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, error: new Error('Storage unavailable') };
  }
  try {
    storage.setItem(storageKey, JSON.stringify({ initialServer }));
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err };
  }
}
