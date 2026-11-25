import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticLog, DIAG_STORAGE_KEY } from '../src/core/diagnosticLog.js';
import { MATCH_STORAGE_KEY } from '../src/core/matchStore.js';

function createMockStorage() {
  const map = new Map();
  return {
    map,
    failGet: null,
    failSet: null,
    getItem(k) {
      if (this.failGet) throw this.failGet;
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (this.failSet) throw this.failSet;
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
}

test('validates maxEntries and maxBytes limits at construction', () => {
  const storage = createMockStorage();
  assert.throws(() => createDiagnosticLog({ storage, maxEntries: 0 }), /maxEntries/);
  assert.throws(() => createDiagnosticLog({ storage, maxEntries: -5 }), /maxEntries/);
  assert.throws(() => createDiagnosticLog({ storage, maxEntries: 1.5 }), /maxEntries/);
  assert.throws(() => createDiagnosticLog({ storage, maxBytes: 0 }), /maxBytes/);
  assert.throws(() => createDiagnosticLog({ storage, maxBytes: -10 }), /maxBytes/);
});

test('persists entries across reload, enforces FIFO & byte caps, and rejects non-finite nowMs', () => {
  const storage = createMockStorage();
  const log1 = createDiagnosticLog({ storage, maxEntries: 3, maxBytes: 4096 });

  for (let i = 1; i <= 5; i += 1) {
    assert.equal(log1.append({ action: `tap-${i}`, audioState: 'playing', revision: i }, 1000 * i).ok, true);
  }

  // Non-finite timestamps are rejected before writing
  assert.equal(log1.append({ action: 'bad-nan', audioState: 'playing', revision: 6 }, Number.NaN).ok, false);
  assert.equal(log1.append({ action: 'bad-inf', audioState: 'playing', revision: 6 }, Number.POSITIVE_INFINITY).ok, false);

  const log2 = createDiagnosticLog({ storage, maxEntries: 3, maxBytes: 4096 });
  assert.deepEqual(
    log2.readAll().entries.map((e) => e.action),
    ['tap-3', 'tap-4', 'tap-5']
  );

  const tightLog = createDiagnosticLog({ storage, maxEntries: 200, maxBytes: 180 });
  assert.equal(tightLog.append({ action: 'nexttrack', audioState: 'playing', revision: 6, detail: 'x'.repeat(60) }, 6000).ok, true);
  assert.ok(Buffer.byteLength(storage.getItem(DIAG_STORAGE_KEY), 'utf8') <= 180);
});

test('preserves valid diagnostic neighbors around a corrupt/null row without wiping history', () => {
  const storage = createMockStorage();
  storage.map.set(
    DIAG_STORAGE_KEY,
    JSON.stringify([
      { t: 1000, action: 'prev', audioState: 'playing', revision: 1, detail: '' },
      null,
      { t: null, action: 'broken-ts', audioState: 'playing', revision: 2, detail: '' },
      'raw-string',
      { t: 3000, action: 'next', audioState: 'playing', revision: 3, detail: 'ok' },
    ])
  );

  const log = createDiagnosticLog({ storage });
  const read = log.readAll();
  assert.equal(read.ok, true);
  assert.deepEqual(
    read.entries.map((e) => e.action),
    ['prev', 'next']
  );

  // Next append preserves those valid neighbors in FIFO order!
  assert.equal(log.append({ action: 'pause', audioState: 'playing', revision: 4 }, 4000).ok, true);
  assert.deepEqual(
    log.readAll().entries.map((e) => e.action),
    ['prev', 'next', 'pause']
  );
});

test('quota failure drops append cleanly without throwing or touching match key; malformed JSON vs getItem throw', () => {
  const storage = createMockStorage();
  storage.map.set(MATCH_STORAGE_KEY, '{"match":"untouched"}');
  const log = createDiagnosticLog({ storage });

  assert.equal(log.append({ action: 'prev', audioState: 'playing', revision: 1 }, 1000).ok, true);

  storage.failSet = new Error('QuotaExceededError');
  const failed = log.append({ action: 'next', audioState: 'playing', revision: 2 }, 2000);
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /QuotaExceededError/);
  assert.equal(storage.getItem(MATCH_STORAGE_KEY), '{"match":"untouched"}');
  storage.failSet = null;
  assert.equal(log.readAll().entries.length, 1);

  storage.map.set(DIAG_STORAGE_KEY, '{not-json');
  assert.deepEqual(log.readAll(), { ok: true, entries: [], error: null });

  storage.map.set(DIAG_STORAGE_KEY, '{"not":"an-array"}');
  assert.deepEqual(log.readAll(), { ok: true, entries: [], error: null });

  storage.failGet = new Error('StorageDisabled');
  assert.equal(log.readAll().ok, false);
});
