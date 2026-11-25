import test from 'node:test';
import assert from 'node:assert/strict';
import { addPoint, undoLastPoint } from '../src/core/scoreEngine.js';
import { createMatchStore, MATCH_STORAGE_KEY } from '../src/core/matchStore.js';

const T0 = 1_700_000_000_000;

function createMockLocks() {
  const held = new Set();
  return {
    held,
    rejectNext: null,
    delayNextGrant: null,
    delayNextRelease: null,
    async request(name, opts, cb) {
      if (typeof opts === 'function') {
        cb = opts;
        opts = {};
      }
      if (this.rejectNext) {
        const err = this.rejectNext;
        this.rejectNext = null;
        throw err;
      }
      if (this.delayNextGrant) {
        const waiter = this.delayNextGrant;
        this.delayNextGrant = null;
        await waiter;
      }
      if (held.has(name)) {
        if (opts.ifAvailable) return cb(null);
        throw new Error('Unexpected blocking request in test');
      }
      held.add(name);
      try {
        return await cb({ name, mode: 'exclusive' });
      } finally {
        if (this.delayNextRelease) {
          const relWait = this.delayNextRelease;
          this.delayNextRelease = null;
          await relWait;
        }
        held.delete(name);
      }
    },
  };
}

function createMockStorage() {
  const map = new Map();
  return {
    map,
    setCalls: 0,
    failGet: null,
    failSet: null,
    failRemove: null,
    getItem(k) {
      if (this.failGet) throw this.failGet;
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      this.setCalls += 1;
      if (this.failSet) throw this.failSet;
      map.set(k, String(v));
    },
    removeItem(k) {
      if (this.failRemove) throw this.failRemove;
      map.delete(k);
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('exclusive Web Lock enforces single writer, read-only second client, and reread on handoff', async () => {
  const locks = createMockLocks();
  const storage = createMockStorage();
  const published = [];

  const tabA = createMatchStore({
    storage,
    locks,
    publishWrist: (state) => published.push(state.revision),
    now: () => T0,
  });
  const tabB = createMatchStore({ storage, locks, now: () => T0 });

  const [g1, g2] = await Promise.all([tabA.tryAcquireWriter(), tabA.tryAcquireWriter()]);
  assert.equal(g1, true);
  assert.equal(g2, true);
  assert.equal(tabA.getSnapshot().role, 'WRITER');
  assert.equal(tabA.getSnapshot().storageStatus, 'EMPTY');

  assert.equal(await tabB.tryAcquireWriter(), false);
  assert.equal(tabB.getSnapshot().role, 'READ_ONLY');
  assert.equal(tabB.getSnapshot().lockStatus, 'BUSY');
  assert.throws(() => tabB.startNewMatch({ matchId: 'm1', config: { initialServer: 0 }, nowMs: T0 }), /Read-only/);

  const startRes = await tabA.startNewMatch({ matchId: 'm1', config: { initialServer: 0 }, nowMs: T0 });
  assert.equal(startRes.ok, true);
  assert.equal(startRes.wristPublished, true);
  await tabA.commit((rec) => addPoint(rec, 'A', T0 + 1000), T0 + 1000);
  assert.deepEqual(published, [1, 2]);

  tabB.refreshReadOnly();
  assert.equal(tabB.getSnapshot().record.revision, 2);

  await tabA.releaseWriter();
  assert.equal(await tabB.tryAcquireWriter(), true);
  assert.equal(tabB.getSnapshot().record.revision, 2);
  assert.equal(Object.isFrozen(tabB.getSnapshot().record), true);
  assert.equal(Object.isFrozen(tabB.getSnapshot().record.events[0]), true);

  // Without publishWrist configured, wristPublished is false
  const pt2 = await tabB.commit((rec) => addPoint(rec, 'E', T0 + 2000), T0 + 2000);
  assert.equal(pt2.ok, true);
  assert.equal(pt2.wristPublished, false);
  assert.equal(pt2.record.revision, 3);
  await tabB.releaseWriter();
});

test('no-op command skips write, notification, and publish; republishWrist clears error visibly with zero writes', async () => {
  const locks = createMockLocks();
  const storage = createMockStorage();
  let failPublish = true;
  let publishes = 0;
  const snapshots = [];

  const store = createMatchStore({
    storage,
    locks,
    publishWrist: () => {
      publishes += 1;
      if (failPublish) throw new Error('wrist offline');
    },
    onStateChange: (snap) => snapshots.push(snap),
    now: () => T0,
  });

  await store.tryAcquireWriter();
  await store.startNewMatch({ matchId: 'm-noop', config: { initialServer: 0 }, nowMs: T0 });
  assert.equal(snapshots[snapshots.length - 1].lastPublishError, 'wrist offline');

  const setsBefore = storage.setCalls;
  const publishesBefore = publishes;
  const snapsBefore = snapshots.length;

  const noopRes = await store.commit((rec) => undoLastPoint(rec), T0 + 1000);
  assert.equal(noopRes.ok, true);
  assert.equal(noopRes.changed, false);
  assert.equal(storage.setCalls, setsBefore);
  assert.equal(publishes, publishesBefore);
  assert.equal(snapshots.length, snapsBefore);
  assert.equal(store.getSnapshot().lastPublishError, 'wrist offline');

  // Re-link Wrist succeeds: notifies observers that error cleared, performs 0 writes, preserves revision!
  failPublish = false;
  const rep = await store.republishWrist(T0 + 2000);
  assert.equal(rep.ok, true);
  assert.equal(rep.wristPublished, true);
  assert.equal(rep.record.revision, 1);
  assert.equal(storage.setCalls, setsBefore);
  assert.equal(snapshots[snapshots.length - 1].lastPublishError, null);
  await store.releaseWriter();
});

test('reentrant transform calling commit or releaseWriter is rejected before touching storage; throwing/invalid transforms fail synchronously', async () => {
  const locks = createMockLocks();
  const storage = createMockStorage();
  const published = [];

  const store = createMatchStore({
    storage,
    locks,
    publishWrist: (s) => published.push(s.revision),
    now: () => T0,
  });

  await store.tryAcquireWriter();
  await store.startNewMatch({ matchId: 'm-re', config: { initialServer: 0 }, nowMs: T0 });

  // 1. Transform calling nested commit() -> inner succeeds (rev 2), outer MUST throw without overwriting inner!
  let innerPromise;
  assert.throws(
    () =>
      store.commit((rec) => {
        innerPromise = store.commit((r) => addPoint(r, 'E', T0 + 1000), T0 + 1000);
        return addPoint(rec, 'A', T0 + 1500);
      }, T0 + 1500),
    /Concurrent or reentrant state change/
  );
  await innerPromise;
  assert.equal(store.getSnapshot().record.revision, 2);
  assert.equal(store.getSnapshot().record.events[0].code, 'E');
  assert.equal(JSON.parse(storage.getItem(MATCH_STORAGE_KEY)).events[0].code, 'E');
  assert.deepEqual(published, [1, 2]);

  // 2. Throwing transform & invalid returned record throw synchronously with zero writes/publishes
  const setsBeforeErr = storage.setCalls;
  assert.throws(
    () =>
      store.commit(() => {
        throw new Error('bad transform');
      }, T0 + 2000),
    /bad transform/
  );
  assert.throws(
    () => store.commit((rec) => ({ ...rec, revision: rec.revision + 5 }), T0 + 2000),
    /increment revision by exactly 1/
  );
  assert.throws(
    () => store.commit((rec) => ({ ...rec, matchId: 'other', revision: rec.revision + 1 }), T0 + 2000),
    /cannot change matchId/
  );
  assert.equal(storage.setCalls, setsBeforeErr);
  assert.deepEqual(published, [1, 2]);

  // 3. Transform calling releaseWriter() -> outer commit MUST throw before writing!
  let relPromise;
  const setsBeforeRel = storage.setCalls;
  assert.throws(
    () =>
      store.commit((rec) => {
        relPromise = store.releaseWriter();
        return addPoint(rec, 'A', T0 + 3000);
      }, T0 + 3000),
    /Read-only/
  );
  await relPromise;
  assert.equal(storage.setCalls, setsBeforeRel);
  assert.equal(store.getSnapshot().record.revision, 2);
});

test('concurrent releaseWriter + reacquire from IDLE keeps newer lock handle intact; release from HELD returns false', async () => {
  const locks = createMockLocks();
  const storage = createMockStorage();

  // Case A: Releasing inside HELD observer makes tryAcquireWriter() return false and store stay READ_ONLY
  let relFromHeld;
  const heldStore = createMatchStore({
    storage,
    locks,
    onStateChange: (snap) => {
      if (snap.lockStatus === 'HELD' && !relFromHeld) {
        relFromHeld = heldStore.releaseWriter();
      }
    },
    now: () => T0,
  });
  assert.equal(await heldStore.tryAcquireWriter(), false);
  await relFromHeld;
  assert.equal(heldStore.getSnapshot().role, 'READ_ONLY');
  assert.equal(locks.held.size, 0);

  // Case B: Double releaseWriter() + reacquire from IDLE -> second release must NOT clear newer grant's handle
  let reacquiredPromise = null;
  const store = createMatchStore({
    storage,
    locks,
    onStateChange: (snap) => {
      if (snap.lockStatus === 'IDLE' && !reacquiredPromise) {
        reacquiredPromise = store.tryAcquireWriter();
      }
    },
    now: () => T0,
  });

  assert.equal(await store.tryAcquireWriter(), true);
  const rel1 = store.releaseWriter();
  const rel2 = store.releaseWriter();
  assert.strictEqual(rel1, rel2); // Shared release operation!
  await Promise.all([rel1, rel2]);
  assert.equal(await reacquiredPromise, true);
  assert.equal(store.getSnapshot().lockStatus, 'HELD');

  // Now delay outer lock release of the NEW grant -> releasing it MUST wait for outer release!
  const outerDelay = deferred();
  locks.delayNextRelease = outerDelay.promise;
  let finalReleased = false;
  const finalRel = store.releaseWriter().then(() => {
    finalReleased = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finalReleased, false);
  assert.equal(locks.held.size, 1);

  outerDelay.resolve();
  await finalRel;
  assert.equal(finalReleased, true);
  assert.equal(locks.held.size, 0);
});

test('reentrant commit from onStateChange publishes 1, 2, 3 in order and release from commit notification waits for publish drain', async () => {
  const locks = createMockLocks();
  const storage = createMockStorage();
  const published = [];
  const gate3 = deferred();
  let triggeredReentrant = false;
  let relOnRev3 = null;

  const store = createMatchStore({
    storage,
    locks,
    publishWrist: async (state) => {
      if (state.revision === 3) {
        await gate3.promise;
      }
      published.push(state.revision);
    },
    onStateChange: (snap) => {
      if (snap.record?.revision === 2 && !triggeredReentrant) {
        triggeredReentrant = true;
        store.commit((r) => addPoint(r, 'E', T0 + 2000), T0 + 2000);
      } else if (snap.record?.revision === 3 && !relOnRev3) {
        relOnRev3 = store.releaseWriter();
      }
    },
    now: () => T0,
  });

  const tabB = createMatchStore({ storage, locks, now: () => T0 });
  await store.tryAcquireWriter();
  await store.startNewMatch({ matchId: 'm-ord', config: { initialServer: 0 }, nowMs: T0 });
  await store.commit((r) => addPoint(r, 'A', T0 + 1000), T0 + 1000);

  // While rev 3 publish is still blocked on gate3, tabB cannot acquire the lock yet!
  assert.equal(await tabB.tryAcquireWriter(), false);
  gate3.resolve();
  await relOnRev3;

  assert.deepEqual(published, [1, 2, 3]);
  assert.equal(await tabB.tryAcquireWriter(), true);
  await tabB.releaseWriter();
});

test('getItem failure keeps lock, blocks mutations, allows retryRead, and preserves releaseWriter', async () => {
  const locks = createMockLocks();
  const storage = createMockStorage();
  storage.failGet = new Error('SecurityError');

  const store = createMatchStore({ storage, locks, now: () => T0 });
  assert.equal(await store.tryAcquireWriter(), true);
  assert.equal(store.getSnapshot().role, 'WRITER');
  assert.equal(store.getSnapshot().storageStatus, 'READ_ERROR');

  assert.throws(() => store.startNewMatch({ matchId: 'm1', config: { initialServer: 0 }, nowMs: T0 }), /Storage read error/);
  assert.throws(() => store.commit((r) => r, T0), /Storage read error/);
  assert.throws(() => store.clearCorruptRecord(), /Storage read error/);
  assert.throws(() => store.republishWrist(T0), /Storage read error/);

  storage.failGet = null;
  store.retryRead();
  assert.equal(store.getSnapshot().storageStatus, 'EMPTY');
  const started = await store.startNewMatch({ matchId: 'm1', config: { initialServer: 0 }, nowMs: T0 });
  assert.equal(started.ok, true);
  await store.releaseWriter();
});

test('quota failure preserves previous match on both point commit and New Match replacement', async () => {
  const locks = createMockLocks();
  const storage = createMockStorage();
  const published = [];

  const store = createMatchStore({
    storage,
    locks,
    publishWrist: (s) => published.push(`${s.matchId}#${s.revision}`),
    now: () => T0,
  });

  await store.tryAcquireWriter();
  await store.startNewMatch({ matchId: 'm1', config: { initialServer: 0 }, nowMs: T0 });
  await store.commit((r) => addPoint(r, 'A', T0 + 1000), T0 + 1000);
  const rawBefore = storage.getItem(MATCH_STORAGE_KEY);

  storage.failSet = new Error('QuotaExceededError');
  const failPt = await store.commit((r) => addPoint(r, 'A', T0 + 2000), T0 + 2000);
  assert.equal(failPt.ok, false);
  assert.equal(failPt.stage, 'save');
  assert.equal(store.getSnapshot().record.revision, 2);
  assert.equal(storage.getItem(MATCH_STORAGE_KEY), rawBefore);
  assert.deepEqual(published, ['m1#1', 'm1#2']);

  const failReplace = await store.startNewMatch({ matchId: 'm2', config: { initialServer: 1 }, nowMs: T0 + 3000 });
  assert.equal(failReplace.ok, false);
  assert.equal(store.getSnapshot().record.matchId, 'm1');
  assert.equal(storage.getItem(MATCH_STORAGE_KEY), rawBefore);

  storage.failSet = null;
  const okReplace = await store.startNewMatch({ matchId: 'm2', config: { initialServer: 1 }, nowMs: T0 + 4000 });
  assert.equal(okReplace.ok, true);
  assert.equal(okReplace.record.matchId, 'm2');
  assert.equal(okReplace.record.revision, 1);
  await store.releaseWriter();
});

test('corrupt storage blocks writes, verifies raw before clear, retains corruptRaw on removeItem error, and isolates observer throws', async () => {
  const locks = createMockLocks();
  const storage = createMockStorage();

  storage.map.set(MATCH_STORAGE_KEY, '');
  const store = createMatchStore({
    storage,
    locks,
    onStateChange: () => {
      throw new Error('observer error');
    },
    now: () => T0,
  });
  await store.tryAcquireWriter();
  assert.equal(store.getSnapshot().storageStatus, 'CORRUPT');
  assert.equal(store.getSnapshot().corruptRaw, '');
  assert.throws(() => store.startNewMatch({ matchId: 'm1', config: { initialServer: 0 }, nowMs: T0 }), /Corrupt match/);

  storage.failRemove = new Error('DiskIOError');
  const failClear = store.clearCorruptRecord();
  assert.equal(failClear.ok, false);
  assert.equal(store.getSnapshot().corruptRaw, '');

  storage.failRemove = null;
  storage.map.set(MATCH_STORAGE_KEY, '{different-corrupt');
  const changedClear = store.clearCorruptRecord();
  assert.equal(changedClear.ok, false);
  assert.equal(changedClear.changed, true);
  assert.equal(store.getSnapshot().corruptRaw, '{different-corrupt');

  assert.equal(store.clearCorruptRecord().ok, true);
  assert.equal(store.getSnapshot().storageStatus, 'EMPTY');
  await store.releaseWriter();
});

test('delayed async publish rejection lets second queued publish run and drains before lock release', async () => {
  const locks = createMockLocks();
  const storage = createMockStorage();
  const gate1 = deferred();
  const gate2 = deferred();
  const seenOrder = [];
  let callIndex = 0;

  const store = createMatchStore({
    storage,
    locks,
    publishWrist: async (state) => {
      seenOrder.push(`start:${state.revision}`);
      const idx = ++callIndex;
      if (idx === 1) return;
      if (idx === 2) {
        await gate1.promise;
        return;
      }
      await gate2.promise;
      seenOrder.push(`done:${state.revision}`);
    },
    now: () => T0,
  });

  await store.tryAcquireWriter();
  await store.startNewMatch({ matchId: 'm-async', config: { initialServer: 0 }, nowMs: T0 });
  const p1 = store.commit((r) => addPoint(r, 'A', T0 + 1000), T0 + 1000);
  const p2 = store.commit((r) => addPoint(r, 'E', T0 + 2000), T0 + 2000);

  const rel = store.releaseWriter();
  assert.throws(() => store.commit((r) => addPoint(r, 'A', T0 + 3000), T0 + 3000), /Read-only/);

  gate1.reject(new Error('AudioFocusLost'));
  const r1 = await p1;
  assert.equal(r1.ok, true);
  assert.equal(r1.wristPublished, false);

  gate2.resolve();
  const r2 = await p2;
  assert.equal(r2.ok, true);
  assert.equal(r2.wristPublished, true);

  await rel;
  assert.deepEqual(seenOrder, ['start:1', 'start:2', 'start:3', 'done:3']);
});

test('missing locks enters UNAVAILABLE, rejected lock sets ERROR, and release racing acquire drops grant', async () => {
  const storage = createMockStorage();
  const noLocksStore = createMatchStore({ storage, locks: null, now: () => T0 });
  assert.equal(await noLocksStore.tryAcquireWriter(), false);
  assert.equal(noLocksStore.getSnapshot().lockStatus, 'UNAVAILABLE');

  const locks = createMockLocks();
  locks.rejectNext = new Error('LockManagerAbort');
  const errStore = createMatchStore({ storage, locks, now: () => T0 });
  await assert.rejects(() => errStore.tryAcquireWriter(), /LockManagerAbort/);
  assert.equal(errStore.getSnapshot().lockStatus, 'ERROR');

  const grantGate = deferred();
  locks.delayNextGrant = grantGate.promise;
  const raceStore = createMatchStore({ storage, locks, now: () => T0 });
  const acqPromise = raceStore.tryAcquireWriter();
  const relPromise = raceStore.releaseWriter();
  grantGate.resolve();
  assert.equal(await acqPromise, false);
  await relPromise;
  assert.equal(locks.held.size, 0);
});

test('skipped publish ({ skipped: true }) returns wristPublished:false without masking lastPublishError', async () => {
  const storage = createMockStorage();
  const locks = createMockLocks();
  let mode = 'throw';

  const store = createMatchStore({
    storage,
    locks,
    now: () => T0,
    publishWrist: async () => {
      if (mode === 'throw') throw new Error('metadata failed');
      if (mode === 'skip') return { skipped: true };
      return { skipped: false };
    },
  });

  await store.tryAcquireWriter();
  const startRes = await store.startNewMatch({ matchId: 'm-skip', config: { initialServer: 0 }, nowMs: T0 });
  assert.equal(startRes.ok, true);
  assert.equal(startRes.wristPublished, false);
  assert.equal(store.getSnapshot().lastPublishError, 'metadata failed');

  // Skipped publish while unlinked must NOT clear lastPublishError
  mode = 'skip';
  const skippedRes = await store.commit((r) => addPoint(r, 'A', T0 + 1000), T0 + 1000);
  assert.equal(skippedRes.ok, true);
  assert.equal(skippedRes.changed, true);
  assert.equal(skippedRes.wristPublished, false);
  assert.equal(store.getSnapshot().lastPublishError, 'metadata failed');

  // Genuine successful republish clears lastPublishError without changing revision
  mode = 'ok';
  const pubRes = await store.republishWrist(T0 + 2000);
  assert.equal(pubRes.wristPublished, true);
  assert.equal(store.getSnapshot().lastPublishError, null);
  assert.equal(store.getSnapshot().record.revision, 2);
  await store.releaseWriter();
});
