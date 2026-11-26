import { validateMatchRecord } from './scoreEngine.js';

export const HISTORY_STORAGE_KEY = 'padelScore.history.v1';
export const HISTORY_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_HISTORY_MATCHES = 50;

function toErrorMessage(err) {
  if (err && typeof err.message === 'string' && err.message.length > 0) {
    return err.message;
  }
  return String(err);
}

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: expected positive safe integer`);
  }
}

export function isTerminalMatchRecord(record) {
  return Boolean(record && (record.status === 'WON' || record.status === 'FINISHED_MANUAL'));
}

/**
 * Exact terminal snapshot equality check used by New Match archival verification.
 * Compares the complete validated record (metadata, config, counters, timestamps, and ordered events)
 * so a row with different rally codes, rules, or timestamps never passes as an exact archive.
 */
export function isSameTerminalSnapshot(a, b) {
  if (!isTerminalMatchRecord(a) || !isTerminalMatchRecord(b)) return false;
  if (
    a.schemaVersion !== b.schemaVersion ||
    a.matchId !== b.matchId ||
    a.revision !== b.revision ||
    a.status !== b.status ||
    a.startTimeMs !== b.startTimeMs ||
    a.finishTimeMs !== b.finishTimeMs ||
    a.nextEventId !== b.nextEventId
  ) {
    return false;
  }
  if (
    !a.config ||
    !b.config ||
    a.config.scoringMode !== b.config.scoringMode ||
    a.config.format !== b.config.format ||
    a.config.decidingSet !== b.config.decidingSet ||
    a.config.initialServer !== b.config.initialServer
  ) {
    return false;
  }
  if (!Array.isArray(a.events) || !Array.isArray(b.events) || a.events.length !== b.events.length) {
    return false;
  }
  for (let i = 0; i < a.events.length; i += 1) {
    const ea = a.events[i];
    const eb = b.events[i];
    if (!ea || !eb || ea.id !== eb.id || ea.t !== eb.t || ea.code !== eb.code) {
      return false;
    }
  }
  return true;
}

function compareMatchesNewestFirst(a, b) {
  const aFinish = typeof a.finishTimeMs === 'number' && Number.isFinite(a.finishTimeMs) ? a.finishTimeMs : -Infinity;
  const bFinish = typeof b.finishTimeMs === 'number' && Number.isFinite(b.finishTimeMs) ? b.finishTimeMs : -Infinity;
  if (bFinish !== aFinish) return bFinish - aFinish;
  if (b.startTimeMs !== a.startTimeMs) return b.startTimeMs - a.startTimeMs;
  if (b.revision !== a.revision) return b.revision - a.revision;
  return a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0;
}

/**
 * Bounded, fault-isolated local match history store (`padelScore.history.v1`).
 *
 * Guarantees:
 * - Distinguishes EMPTY (only null), READY, PARTIAL_CORRUPT, CORRUPT, and READ_ERROR.
 * - Preserves corrupt and partially corrupt storage byte-for-byte (refuses mutations whenever
 *   any row is unreadable so lossless recovery bytes are never altered by JSON reserialization).
 * - Still lets readAll() expose all valid rows + corruptCount for browsing/export under PARTIAL_CORRUPT.
 * - Applies dedupe, deterministic newest-first sort, and maxMatches trim in memory, writing once.
 * - Reports trimmedOut=true if a newly archived match sorted outside maxMatches (e.g. clock rollback).
 */
export function createMatchHistoryStore({
  storage,
  storageKey = HISTORY_STORAGE_KEY,
  maxMatches = DEFAULT_MAX_HISTORY_MATCHES,
} = {}) {
  if (
    !storage ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function'
  ) {
    throw new Error('createMatchHistoryStore requires a storage object with getItem, setItem, and removeItem');
  }
  assertPositiveSafeInteger(maxMatches, 'maxMatches');

  function readInternal() {
    let raw;
    try {
      raw = storage.getItem(storageKey);
    } catch (err) {
      return {
        ok: false,
        status: 'READ_ERROR',
        matches: Object.freeze([]),
        corruptCount: 0,
        preservedCorrupt: [],
        error: err,
      };
    }

    if (raw === null) {
      return {
        ok: true,
        status: 'EMPTY',
        matches: Object.freeze([]),
        corruptCount: 0,
        preservedCorrupt: [],
        error: null,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        status: 'CORRUPT',
        matches: Object.freeze([]),
        corruptCount: 1,
        preservedCorrupt: [],
        error: err,
      };
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== HISTORY_SCHEMA_VERSION ||
      !Array.isArray(parsed.matches)
    ) {
      return {
        ok: false,
        status: 'CORRUPT',
        matches: Object.freeze([]),
        corruptCount: 1,
        preservedCorrupt: [],
        error: new Error('Invalid history envelope: expected { schemaVersion: 1, matches: [] }'),
      };
    }

    const byId = new Map();
    const preservedCorrupt = [];

    for (const item of parsed.matches) {
      try {
        const validated = validateMatchRecord(item);
        if (!isTerminalMatchRecord(validated)) {
          preservedCorrupt.push(item);
          continue;
        }
        const existing = byId.get(validated.matchId);
        if (!existing || compareMatchesNewestFirst(validated, existing) < 0) {
          byId.set(validated.matchId, validated);
        }
      } catch {
        preservedCorrupt.push(item);
      }
    }

    const sorted = [...byId.values()].sort(compareMatchesNewestFirst);
    const status = preservedCorrupt.length > 0 ? 'PARTIAL_CORRUPT' : 'READY';

    return {
      ok: true,
      status,
      matches: Object.freeze(sorted),
      corruptCount: preservedCorrupt.length,
      preservedCorrupt,
      error: null,
    };
  }

  function readAll() {
    const res = readInternal();
    return Object.freeze({
      ok: res.ok,
      status: res.status,
      matches: res.matches,
      corruptCount: res.corruptCount,
      error: res.error,
    });
  }

  function hasExactSnapshot(targetRecord) {
    if (!isTerminalMatchRecord(targetRecord)) return false;
    const res = readInternal();
    if (!res.ok) return false;
    return res.matches.some((m) => isSameTerminalSnapshot(m, targetRecord));
  }

  function upsertMatch(record) {
    let validated;
    try {
      validated = validateMatchRecord(record);
      if (!isTerminalMatchRecord(validated)) {
        throw new Error(`Cannot archive match with status "${validated.status}" (expected WON or FINISHED_MANUAL)`);
      }
    } catch (err) {
      return { ok: false, archivedExact: false, trimmedOut: false, matches: null, error: err };
    }

    const current = readInternal();
    if (!current.ok || current.status === 'PARTIAL_CORRUPT') {
      // Refuse mutation on CORRUPT, PARTIAL_CORRUPT, or READ_ERROR to preserve stored raw JSON byte-for-byte
      const detail = current.ok
        ? `${current.corruptCount} unreadable row(s) present`
        : toErrorMessage(current.error);
      return {
        ok: false,
        archivedExact: false,
        trimmedOut: false,
        matches: current.matches,
        error: new Error(`History write blocked (${current.status}): ${detail}`),
      };
    }

    const nextList = current.matches.filter((m) => m.matchId !== validated.matchId);
    nextList.push(validated);
    nextList.sort(compareMatchesNewestFirst);

    const trimmed = nextList.slice(0, maxMatches);
    const retained = trimmed.some((m) => isSameTerminalSnapshot(m, validated));
    if (!retained) {
      // Clock rollback or older match fell outside newest maxMatches: do not claim archived!
      return {
        ok: false,
        archivedExact: false,
        trimmedOut: true,
        matches: current.matches,
        error: new Error(`Match sorted outside the newest ${maxMatches} history entries and was not archived`),
      };
    }

    const envelope = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      matches: trimmed,
    };

    try {
      storage.setItem(storageKey, JSON.stringify(envelope));
    } catch (err) {
      return {
        ok: false,
        archivedExact: false,
        trimmedOut: false,
        matches: current.matches,
        error: err,
      };
    }

    return {
      ok: true,
      archivedExact: true,
      trimmedOut: false,
      matches: Object.freeze(trimmed),
      corruptCount: 0,
      error: null,
    };
  }

  function removeMatch(matchId) {
    if (typeof matchId !== 'string' || matchId.length === 0) {
      return { ok: false, removed: false, matches: null, error: new Error('Invalid matchId') };
    }

    const current = readInternal();
    if (!current.ok || current.status === 'PARTIAL_CORRUPT') {
      // Leave CORRUPT / PARTIAL_CORRUPT / READ_ERROR storage untouched byte-for-byte
      const detail = current.ok
        ? `${current.corruptCount} unreadable row(s) present`
        : toErrorMessage(current.error);
      return {
        ok: false,
        removed: false,
        matches: current.matches,
        error: new Error(`History write blocked (${current.status}): ${detail}`),
      };
    }

    const nextList = current.matches.filter((m) => m.matchId !== matchId);
    const existed = nextList.length !== current.matches.length;
    if (!existed) {
      return {
        ok: true,
        removed: false,
        matches: current.matches,
        corruptCount: 0,
        error: null,
      };
    }

    const envelope = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      matches: nextList,
    };

    try {
      storage.setItem(storageKey, JSON.stringify(envelope));
    } catch (err) {
      return {
        ok: false,
        removed: false,
        matches: current.matches,
        error: err,
      };
    }

    return {
      ok: true,
      removed: true,
      matches: Object.freeze(nextList),
      corruptCount: 0,
      error: null,
    };
  }

  return {
    readAll,
    hasExactSnapshot,
    upsertMatch,
    removeMatch,
  };
}
