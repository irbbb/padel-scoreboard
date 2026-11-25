export const DIAG_STORAGE_KEY = 'padelScore.diag.v1';
export const DEFAULT_MAX_DIAG_ENTRIES = 200;
export const DEFAULT_MAX_DIAG_BYTES = 32 * 1024;
export const MAX_DETAIL_LENGTH = 256;

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: expected positive safe integer`);
  }
}

function utf8Length(str) {
  let bytes = 0;
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function parseValidEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  if (typeof raw.t !== 'number' || !Number.isFinite(raw.t)) {
    return null;
  }
  if (raw.revision !== null && raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || raw.revision < 1)) {
    return null;
  }
  return Object.freeze({
    t: raw.t,
    action: String(raw.action ?? ''),
    audioState: String(raw.audioState ?? ''),
    revision: raw.revision ?? null,
    detail: String(raw.detail ?? '').slice(0, MAX_DETAIL_LENGTH),
  });
}

/**
 * Bounded persistent diagnostic log stored in its own localStorage key.
 * Capped by both entry count (FIFO) and serialized byte size.
 * Validates persisted rows individually so one corrupt row never erases valid neighbors.
 */
export function createDiagnosticLog({
  storage,
  storageKey = DIAG_STORAGE_KEY,
  maxEntries = DEFAULT_MAX_DIAG_ENTRIES,
  maxBytes = DEFAULT_MAX_DIAG_BYTES,
  now = () => Date.now(),
} = {}) {
  if (
    !storage ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function'
  ) {
    throw new Error('createDiagnosticLog requires a storage object with getItem, setItem, and removeItem');
  }
  assertPositiveSafeInteger(maxEntries, 'maxEntries');
  assertPositiveSafeInteger(maxBytes, 'maxBytes');

  function readAll() {
    let raw;
    try {
      raw = storage.getItem(storageKey);
    } catch (err) {
      return { ok: false, entries: Object.freeze([]), error: err };
    }

    if (raw === null) {
      return { ok: true, entries: Object.freeze([]), error: null };
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return { ok: true, entries: Object.freeze([]), error: null };
      }
      const valid = [];
      for (const item of parsed) {
        const entry = parseValidEntry(item);
        if (entry !== null) {
          valid.push(entry);
        }
      }
      return { ok: true, entries: Object.freeze(valid), error: null };
    } catch {
      return { ok: true, entries: Object.freeze([]), error: null };
    }
  }

  function append({ action, audioState, revision = null, detail = '' }, nowMs = now()) {
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
      return { ok: false, error: new Error('Invalid nowMs: expected finite number') };
    }

    const readRes = readAll();
    if (!readRes.ok) {
      return { ok: false, error: readRes.error };
    }

    const entry = parseValidEntry({ t: nowMs, action, audioState, revision, detail });
    if (!entry) {
      return { ok: false, error: new Error('Invalid diagnostic entry fields') };
    }

    const next = [...readRes.entries, entry];

    // Enforce FIFO entry-count cap
    while (next.length > maxEntries) {
      next.shift();
    }

    // Enforce serialized byte-size cap (drop oldest entries until serialized payload fits)
    let serialized = JSON.stringify(next);
    while (next.length > 1 && utf8Length(serialized) > maxBytes) {
      next.shift();
      serialized = JSON.stringify(next);
    }
    if (utf8Length(serialized) > maxBytes) {
      return {
        ok: false,
        error: new Error(`Single diagnostic entry exceeds maxBytes (${maxBytes})`),
      };
    }

    try {
      storage.setItem(storageKey, serialized);
      return { ok: true, entry, count: next.length };
    } catch (err) {
      // Drop append cleanly on quota/storage failure; never log through append() or touch match key
      return { ok: false, error: err };
    }
  }

  function clear() {
    try {
      storage.removeItem(storageKey);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  return {
    readAll,
    append,
    clear,
  };
}
