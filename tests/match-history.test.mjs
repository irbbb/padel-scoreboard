import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, addPoint, finishManual } from '../src/core/scoreEngine.js';
import {
  createMatchHistoryStore,
  HISTORY_STORAGE_KEY,
  isSameTerminalSnapshot,
} from '../src/core/matchHistory.js';

const T0 = Date.UTC(2026, 4, 1, 18, 0, 0);

function createMemoryStorage() {
  const data = new Map();
  let failSet = null;
  let failGet = null;
  return {
    data,
    setFailSet(err) {
      failSet = err;
    },
    setFailGet(err) {
      failGet = err;
    },
    getItem(k) {
      if (failGet) throw failGet;
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) {
      if (failSet) throw failSet;
      data.set(k, String(v));
    },
    removeItem(k) {
      data.delete(k);
    },
  };
}

function makeFinished(id, startMs, finishMs, extraPoints = 1) {
  let r = createMatch({ matchId: id, config: { scoringMode: 'AD', initialServer: 0 }, nowMs: startMs });
  for (let i = 0; i < extraPoints; i += 1) {
    r = addPoint(r, 'E', startMs + (i + 1) * 1000);
  }
  return finishManual(r, finishMs);
}

test('history store distinguishes EMPTY, READY, PARTIAL_CORRUPT, CORRUPT, and READ_ERROR without wiping data', () => {
  const storage = createMemoryStorage();
  const hist = createMatchHistoryStore({ storage, maxMatches: 5 });

  assert.equal(hist.readAll().status, 'EMPTY');
  assert.equal(hist.readAll().matches.length, 0);

  // Malformed JSON -> CORRUPT; mutations refused and raw payload preserved intact
  storage.setItem(HISTORY_STORAGE_KEY, '{not-json');
  assert.equal(hist.readAll().status, 'CORRUPT');
  const m1 = makeFinished('m1', T0, T0 + 10_000);
  const upCorrupt = hist.upsertMatch(m1);
  assert.equal(upCorrupt.ok, false);
  assert.equal(storage.getItem(HISTORY_STORAGE_KEY), '{not-json');
  const rmCorrupt = hist.removeMatch('m1');
  assert.equal(rmCorrupt.ok, false);
  assert.equal(storage.getItem(HISTORY_STORAGE_KEY), '{not-json');

  // Unsupported envelope -> CORRUPT
  storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ schemaVersion: 99, matches: [] }));
  assert.equal(hist.readAll().status, 'CORRUPT');

  // Partially corrupt envelope -> reads valid rows, refuses mutations to preserve unreadable raw JSON byte-for-byte!
  const rawPartial = `{"schemaVersion":1,"matches":[${JSON.stringify(m1)},{"futureId":9007199254740993,"marker":1e400}]}`;
  storage.setItem(HISTORY_STORAGE_KEY, rawPartial);
  const partial = hist.readAll();
  assert.equal(partial.ok, true);
  assert.equal(partial.status, 'PARTIAL_CORRUPT');
  assert.equal(partial.matches.length, 1);
  assert.equal(partial.corruptCount, 1);

  const m2 = makeFinished('m2', T0 + 20_000, T0 + 30_000);
  const upPartial = hist.upsertMatch(m2);
  assert.equal(upPartial.ok, false);
  assert.equal(upPartial.archivedExact, false);
  assert.equal(storage.getItem(HISTORY_STORAGE_KEY), rawPartial); // Exact byte-for-byte preservation!

  const rmPartial = hist.removeMatch('m1');
  assert.equal(rmPartial.ok, false);
  assert.equal(storage.getItem(HISTORY_STORAGE_KEY), rawPartial);

  // Clean READY envelope succeeds normally
  storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, matches: [m1] }));
  const upOk = hist.upsertMatch(m2);
  assert.equal(upOk.ok, true);
  assert.equal(upOk.archivedExact, true);
  assert.equal(hist.readAll().matches.length, 2);

  // READ_ERROR refuses mutations
  storage.setFailGet(new Error('StorageDenied'));
  assert.equal(hist.readAll().status, 'READ_ERROR');
  assert.equal(hist.upsertMatch(m2).ok, false);
  assert.equal(hist.removeMatch('m2').ok, false);
});

test('Regression P1: isSameTerminalSnapshot compares complete records including event codes, timestamps, and config', () => {
  let recE = createMatch({ matchId: 'same-id', config: { scoringMode: 'AD', initialServer: 0 }, nowMs: T0 });
  recE = addPoint(recE, 'E', T0 + 1000);
  recE = finishManual(recE, T0 + 5000);

  let recB = createMatch({ matchId: 'same-id', config: { scoringMode: 'AD', initialServer: 0 }, nowMs: T0 });
  recB = addPoint(recB, 'B', T0 + 1000);
  recB = finishManual(recB, T0 + 5000);

  assert.equal(recE.revision, recB.revision);
  assert.equal(recE.events.length, recB.events.length);
  assert.equal(isSameTerminalSnapshot(recE, recB), false);

  let recGp = createMatch({ matchId: 'same-id', config: { scoringMode: 'GP', initialServer: 0 }, nowMs: T0 });
  recGp = addPoint(recGp, 'E', T0 + 1000);
  recGp = finishManual(recGp, T0 + 5000);
  assert.equal(isSameTerminalSnapshot(recE, recGp), false);

  assert.equal(isSameTerminalSnapshot(recE, JSON.parse(JSON.stringify(recE))), true);
});

test('upsert deduplicates by matchId, sorts newest-first, detects clock-rollback trimmedOut, and isolates quota errors', () => {
  const storage = createMemoryStorage();
  const hist = createMatchHistoryStore({ storage, maxMatches: 2 });

  const m1 = makeFinished('m1', T0, T0 + 10_000, 1);
  const m2 = makeFinished('m2', T0 + 20_000, T0 + 30_000, 2);
  assert.equal(hist.upsertMatch(m1).archivedExact, true);
  assert.equal(hist.upsertMatch(m2).archivedExact, true);
  assert.deepEqual(hist.readAll().matches.map((m) => m.matchId), ['m2', 'm1']);

  // Re-finished m1 (higher revision/finishTime) updates in place and fails older snapshot equality check
  const m1Updated = makeFinished('m1', T0, T0 + 50_000, 3);
  assert.equal(isSameTerminalSnapshot(m1, m1Updated), false);
  assert.equal(hist.upsertMatch(m1Updated).archivedExact, true);
  assert.equal(hist.hasExactSnapshot(m1), false);
  assert.equal(hist.hasExactSnapshot(m1Updated), true);
  assert.deepEqual(hist.readAll().matches.map((m) => m.matchId), ['m1', 'm2']);

  // Clock rollback: newly finished match sorts OLDER than newest maxMatches (2) -> trimmedOut=true, storage untouched!
  const rolledBack = makeFinished('m-old-clock', T0 - 100_000, T0 - 90_000, 1);
  const rolledRes = hist.upsertMatch(rolledBack);
  assert.equal(rolledRes.ok, false);
  assert.equal(rolledRes.trimmedOut, true);
  assert.equal(rolledRes.archivedExact, false);
  assert.deepEqual(hist.readAll().matches.map((m) => m.matchId), ['m1', 'm2']);

  // Active match rejected cleanly
  const active = createMatch({ matchId: 'm-act', config: { scoringMode: 'AD', initialServer: 0 }, nowMs: T0 });
  assert.equal(hist.upsertMatch(active).ok, false);

  // Quota error returns ok:false and preserves previous stored list
  storage.setFailSet(new Error('QuotaExceededError'));
  const m3 = makeFinished('m3', T0 + 60_000, T0 + 70_000, 1);
  const qRes = hist.upsertMatch(m3);
  assert.equal(qRes.ok, false);
  assert.deepEqual(qRes.matches.map((m) => m.matchId), ['m1', 'm2']);
});
