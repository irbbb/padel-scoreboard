import test from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_STORAGE_KEY } from '../src/core/matchStore.js';
import {
  createAppController,
  createGuardedStorage,
  formatDiagTime,
  formatDuration,
  formatSetLine,
  formatUePercent,
} from '../src/app/appController.js';
import { DEFAULTS_STORAGE_KEY } from '../src/app/defaultsStore.js';

function createMemoryStorage() {
  const data = new Map();
  let failNextSet = null;
  let failGet = null;
  return {
    setFailNextSet(err) {
      failNextSet = err;
    },
    setFailGet(err) {
      failGet = err;
    },
    setRaw(k, v) {
      data.set(k, String(v));
    },
    clearAll() {
      data.clear();
    },
    getItem(k) {
      if (failGet) throw failGet;
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) {
      if (failNextSet && k === MATCH_STORAGE_KEY) {
        const err = failNextSet;
        failNextSet = null;
        throw err;
      }
      data.set(k, String(v));
    },
    removeItem(k) {
      data.delete(k);
    },
  };
}

function createSharedMockLocks() {
  const held = new Set();
  return {
    request(name, opts, cb) {
      if (held.has(name) && opts?.ifAvailable) {
        return Promise.resolve(cb(null));
      }
      held.add(name);
      return Promise.resolve(cb({ name })).finally(() => {
        held.delete(name);
      });
    },
  };
}

function createSimpleAudioHarness({ rejectPlay = false } = {}) {
  const created = [];
  let shouldReject = rejectPlay;
  return {
    created,
    setReject(val) {
      shouldReject = val;
    },
    createAudio() {
      const listeners = new Map();
      const el = {
        paused: true,
        ended: false,
        error: null,
        loop: false,
        volume: 1,
        duration: 10,
        currentTime: 0,
        addEventListener(t, fn) {
          if (!listeners.has(t)) listeners.set(t, new Set());
          listeners.get(t).add(fn);
        },
        removeEventListener(t, fn) {
          listeners.get(t)?.delete(fn);
        },
        play() {
          if (shouldReject) return Promise.reject(new Error('Autoplay blocked'));
          el.paused = false;
          return Promise.resolve();
        },
        pause() {
          el.paused = true;
        },
      };
      created.push(el);
      return el;
    },
  };
}

function createSimpleMediaSession() {
  const handlers = new Map();
  return {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, fn) {
      if (fn === null) handlers.delete(action);
      else handlers.set(action, fn);
    },
    setPositionState() {},
    handlers,
  };
}

test('format helpers cover duration, UE percent, and tie-break set lines', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(125), '02:05');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatUePercent(null), '—');
  assert.equal(formatUePercent(0), '0%');
  assert.equal(formatUePercent(0.002), '<1%');
  assert.equal(formatUePercent(0.5), '50%');
  assert.equal(formatSetLine({ games: [6, 4] }), '6-4');
  assert.equal(formatSetLine({ games: [7, 6], tieBreakPoints: [9, 7] }), '7-6 (9-7)');
});

test('Start Match persists synchronously, saves defaults, and handles failed save vs rejected audio.play()', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const audioH = createSimpleAudioHarness({ rejectPlay: true });
  const ms = createSimpleMediaSession();
  let clock = 10000;
  let idSeq = 0;

  const ctrl = createAppController({
    storage,
    locks,
    createAudio: audioH.createAudio,
    mediaSession: ms,
    createMatchId: () => `m-${++idSeq}`,
    now: () => clock,
  });

  await ctrl.init();
  assert.equal(ctrl.getViewModel().screen, 'SETUP');
  ctrl.setSetupInitialServer(1);

  // Quota failure on Start keeps user in SETUP and never invokes audio.play()
  storage.setFailNextSet(new Error('QuotaExceededError'));
  const failRes = await ctrl.startMatch({ linkWrist: true });
  assert.equal(failRes.ok, false);
  assert.equal(ctrl.getViewModel().screen, 'SETUP');
  assert.equal(audioH.created.length, 0);
  assert.match(ctrl.getViewModel().lastSaveError, /QuotaExceededError/);

  // Successful save + rejected audio.play() enters LIVE with phone scoring available
  const okRes = await ctrl.startMatch({ linkWrist: true });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.linkResult.ok, false);
  assert.equal(ctrl.getViewModel().screen, 'LIVE');
  assert.equal(ctrl.getViewModel().wrist.status, 'DISARMED');
  assert.equal(JSON.parse(storage.getItem(DEFAULTS_STORAGE_KEY)).initialServer, 1);

  // Phone scoring still works immediately
  clock += 5000;
  await ctrl.scorePoint('A');
  assert.equal(ctrl.getViewModel().state.pointsLabel[0], '15');
  assert.equal(ctrl.getViewModel().state.server, 1);

  // Correct first serving team updates server while keeping score & bumping revision
  await ctrl.correctFirstServer(0);
  assert.equal(ctrl.getViewModel().state.server, 0);
  assert.equal(ctrl.getViewModel().record.revision, 3);
  await ctrl.handlePageHideOrFreeze();
});

test('Match Over flows: Finish Now -> Resume (disarmed), WON -> Undo (disarmed), and replacement New Match draft safety', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const audioH = createSimpleAudioHarness();
  const ms = createSimpleMediaSession();
  let clock = 1000;
  let idSeq = 0;

  const ctrl = createAppController({
    storage,
    locks,
    createAudio: audioH.createAudio,
    mediaSession: ms,
    createMatchId: () => `m-${++idSeq}`,
    now: () => clock,
  });

  await ctrl.init();
  await ctrl.startMatch({ linkWrist: true });
  assert.equal(ctrl.getViewModel().wrist.status, 'ARMED');
  await ctrl.selectInitialServer(0);

  clock += 30000;
  await ctrl.scorePoint('E');
  clock += 30000;
  await ctrl.finishNow();

  let vm = ctrl.getViewModel();
  assert.equal(vm.screen, 'MATCH_OVER');
  assert.equal(vm.state.status, 'FINISHED_MANUAL');
  assert.equal(vm.durationText, '01:00');
  assert.equal(vm.canResume, true);
  assert.equal(vm.canUndo, false);
  assert.equal(vm.wrist.status, 'DISARMED');

  // Duration stays frozen at finishTimeMs even as clock advances
  clock += 120000;
  assert.equal(ctrl.getViewModel().durationText, '01:00');

  // Open replacement New Match draft -> Cancel preserves finished match
  assert.equal(ctrl.openReplacementSetup(), true);
  assert.equal(ctrl.getViewModel().screen, 'SETUP');
  assert.equal(ctrl.getViewModel().isReplacementSetup, true);
  ctrl.cancelReplacementSetup();
  assert.equal(ctrl.getViewModel().screen, 'MATCH_OVER');

  // Open replacement draft -> failed Start preserves BOTH finished match AND draft
  ctrl.openReplacementSetup();
  ctrl.setSetupInitialServer(1);
  storage.setFailNextSet(new Error('Disk full'));
  await ctrl.startMatch({ linkWrist: false });
  assert.equal(ctrl.getViewModel().screen, 'SETUP');
  assert.equal(ctrl.getViewModel().isReplacementSetup, true);
  assert.equal(ctrl.getViewModel().record.matchId, 'm-1');
  assert.equal(ctrl.getViewModel().setupInitialServer, 1);

  // Cancel back to MATCH_OVER and Resume -> reopens LIVE disarmed
  ctrl.cancelReplacementSetup();
  await ctrl.resume();
  vm = ctrl.getViewModel();
  assert.equal(vm.screen, 'LIVE');
  assert.equal(vm.wrist.status, 'DISARMED');

  // Tick updates displayed durationSec with zero commits/revisions/publishes
  const revBeforeTick = vm.record.revision;
  clock += 15000;
  ctrl.tickDisplay();
  assert.equal(ctrl.getViewModel().record.revision, revBeforeTick);
  assert.notEqual(ctrl.getViewModel().durationText, '01:00');

  // Play to WON (48 points for US -> 6-0, 6-0) -> Match Over offers Undo last point (not Resume)
  for (let i = 0; i < 48; i += 1) {
    clock += 1000;
    await ctrl.scorePoint('A');
  }
  vm = ctrl.getViewModel();
  assert.equal(vm.screen, 'MATCH_OVER');
  assert.equal(vm.state.status, 'WON');
  assert.equal(vm.canUndo, true);
  assert.equal(vm.canResume, false);

  // Undo last point from WON reopens LIVE disarmed
  await ctrl.undo();
  vm = ctrl.getViewModel();
  assert.equal(vm.screen, 'LIVE');
  assert.equal(vm.state.status, 'ACTIVE');
  assert.equal(vm.wrist.status, 'DISARMED');

  await ctrl.handlePageHideOrFreeze();
});

test('Read-only second tab views MATCH_OVER & CORRUPT, refreshes on storage clear (key===null), and takes over after writer exits', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const ms1 = createSimpleMediaSession();
  const ms2 = createSimpleMediaSession();

  const writer = createAppController({
    storage,
    locks,
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: ms1,
    createMatchId: () => 'm-tab1',
    now: () => 5000,
  });
  const reader = createAppController({
    storage,
    locks,
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: ms2,
    createMatchId: () => 'm-tab2',
    now: () => 5000,
  });

  await writer.init();
  writer.setSetupInitialServer(0);
  await writer.startMatch({ linkWrist: false });
  await writer.scorePoint('A');
  await writer.finishNow();

  await reader.init();
  assert.equal(reader.getViewModel().isWriter, false);
  assert.equal(reader.getViewModel().screen, 'MATCH_OVER');
  assert.equal(reader.getViewModel().lockStatus, 'BUSY');

  // Take over while writer still holds lock returns false with honest notice
  const busyTakeover = await reader.takeOverWriter();
  assert.equal(busyTakeover, false);
  assert.match(reader.getViewModel().takeoverNotice, /another open tab/i);

  // Storage clear event (key === null) refreshes read-only tab cleanly
  storage.clearAll();
  reader.handleStorageEvent(null);
  assert.equal(reader.getViewModel().screen, 'SETUP');

  // Corrupt JSON visible in read-only mode (can inspect, cannot clear)
  storage.setRaw(MATCH_STORAGE_KEY, '{corrupt');
  reader.handleStorageEvent(MATCH_STORAGE_KEY);
  assert.equal(reader.getViewModel().screen, 'CORRUPT');
  assert.equal(reader.getViewModel().corruptRaw, '{corrupt');
  const clearDenied = reader.clearCorruptRecord();
  assert.equal(clearDenied.ok, false);

  // Writer steps down -> reader acquires lock, rereads corrupt storage, and clears it
  await writer.stepDownToReadOnly();
  const acquired = await reader.takeOverWriter();
  assert.equal(acquired, true);
  assert.equal(reader.getViewModel().isWriter, true);
  assert.equal(reader.getViewModel().screen, 'CORRUPT');
  const cleared = reader.clearCorruptRecord();
  assert.equal(cleared.ok, true);
  assert.equal(reader.getViewModel().screen, 'SETUP');

  await reader.handlePageHideOrFreeze();
});

test('READ_ERROR offers Retry Read and BFCache restore rechecks lock starting disarmed', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const audioH = createSimpleAudioHarness();
  const ms = createSimpleMediaSession();

  storage.setFailGet(new Error('SecurityError'));
  const ctrl = createAppController({
    storage,
    locks,
    createAudio: audioH.createAudio,
    mediaSession: ms,
    createMatchId: () => 'm-bfcache',
    now: () => 1000,
  });

  await ctrl.init();
  assert.equal(ctrl.getViewModel().screen, 'READ_ERROR');
  assert.equal(ctrl.getViewModel().isWriter, true);

  storage.setFailGet(null);
  const retryRes = ctrl.retryRead();
  assert.equal(retryRes.ok, true);
  assert.equal(ctrl.getViewModel().screen, 'SETUP');

  await ctrl.startMatch({ linkWrist: true });
  assert.equal(ctrl.getViewModel().wrist.status, 'ARMED');

  // Simulate pagehide (BFCache) -> releases writer and disarms
  await ctrl.handlePageHideOrFreeze('pagehide');
  assert.equal(ctrl.getViewModel().isWriter, false);
  assert.equal(ctrl.getViewModel().wrist.status, 'DISARMED');

  // Simulate BFCache restore (pageshow persisted) -> reacquires lock, rereads match, starts DISARMED
  const restored = await ctrl.handlePageShowOrResume();
  assert.equal(restored, true);
  assert.equal(ctrl.getViewModel().screen, 'LIVE');
  assert.equal(ctrl.getViewModel().wrist.status, 'DISARMED');
  await ctrl.handlePageHideOrFreeze();
});

test('Regression P1: duration ticks and visibility return update via onDurationTick without firing full onUpdate', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  let clock = 1000;
  let fullUpdates = 0;
  const tickValues = [];

  const ctrl = createAppController({
    storage,
    locks,
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: createSimpleMediaSession(),
    createMatchId: () => 'm-tick',
    now: () => clock,
    onUpdate: () => {
      fullUpdates += 1;
    },
    onDurationTick: (text) => {
      tickValues.push(text);
    },
  });

  await ctrl.init();
  await ctrl.startMatch({ linkWrist: false });
  const updatesBeforeTick = fullUpdates;

  clock += 5000;
  ctrl.tickDisplay();
  clock += 7000;
  ctrl.handleVisibilityChange('visible');

  assert.equal(fullUpdates, updatesBeforeTick);
  assert.deepEqual(tickValues, ['00:05', '00:12']);
  assert.equal(ctrl.getViewModel().record.revision, 1);
  await ctrl.handlePageHideOrFreeze();
});

test('Regression P2: rejecting Web Lock on init/takeover/restore never leaves LOADING or unhandled rejection', async () => {
  const storage = createMemoryStorage();
  let rejectLock = true;
  const flakyLocks = {
    request(name, opts, cb) {
      if (rejectLock) {
        return Promise.reject(new Error('SecurityError: Web Locks blocked'));
      }
      return Promise.resolve(cb({ name }));
    },
  };

  const ctrl = createAppController({
    storage,
    locks: flakyLocks,
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: createSimpleMediaSession(),
    createMatchId: () => 'm-lockerr',
    now: () => 1000,
  });

  const initAcquired = await ctrl.init();
  assert.equal(initAcquired, false);
  let vm = ctrl.getViewModel();
  assert.notEqual(vm.screen, 'LOADING');
  assert.equal(vm.screen, 'SETUP');
  assert.equal(vm.lockStatus, 'ERROR');
  assert.match(vm.takeoverNotice, /SecurityError/);

  // Retry while still failing -> stays recoverable without rejecting
  assert.equal(await ctrl.takeOverWriter(), false);
  assert.equal(ctrl.getViewModel().lockStatus, 'ERROR');

  // Lock recovers -> Take Over Writer succeeds
  rejectLock = false;
  assert.equal(await ctrl.takeOverWriter(), true);
  assert.equal(ctrl.getViewModel().isWriter, true);
  await ctrl.handlePageHideOrFreeze();
});

test('Regression P2: throwing localStorage getter at boot defers into recoverable READ_ERROR screen', async () => {
  const backing = createMemoryStorage();
  let getterBlocked = true;
  const guarded = createGuardedStorage(() => {
    if (getterBlocked) throw new Error('SecurityError: localStorage denied');
    return backing;
  });

  const ctrl = createAppController({
    storage: guarded,
    locks: createSharedMockLocks(),
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: createSimpleMediaSession(),
    createMatchId: () => 'm-getter',
    now: () => 1000,
  });

  await ctrl.init();
  assert.equal(ctrl.getViewModel().screen, 'READ_ERROR');
  assert.match(ctrl.getViewModel().storageReadError, /SecurityError/);

  // Once browser storage becomes readable, Retry Read recovers cleanly
  getterBlocked = false;
  const retry = ctrl.retryRead();
  assert.equal(retry.ok, true);
  assert.equal(ctrl.getViewModel().screen, 'SETUP');
  await ctrl.handlePageHideOrFreeze();
});

test('Regression P2: handlePageShowOrResume awaits pending release (including delayed initial grant) and respects superseded hide', async () => {
  const storage = createMemoryStorage();
  let held = false;
  let delayGrant = null;
  let delayOuterFinish = null;

  const delayedLocks = {
    request(name, opts, cb) {
      const run = () => {
        if (held && opts?.ifAvailable) return Promise.resolve(cb(null));
        held = true;
        return Promise.resolve(cb({ name })).finally(async () => {
          if (delayOuterFinish) {
            const p = delayOuterFinish;
            delayOuterFinish = null;
            await p;
          }
          held = false;
        });
      };
      if (delayGrant) {
        const g = delayGrant;
        delayGrant = null;
        return g.then(run);
      }
      return run();
    },
  };

  const ctrl = createAppController({
    storage,
    locks: delayedLocks,
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: createSimpleMediaSession(),
    createMatchId: () => 'm-lifecycle',
    now: () => 1000,
  });

  // Case A: delayed initial lock grant across hide -> restore
  let resolveInitialGrant;
  delayGrant = new Promise((r) => {
    resolveInitialGrant = r;
  });
  const initPromise = ctrl.init();
  const hidePromise = ctrl.handlePageHideOrFreeze('pagehide');
  const restorePromise = ctrl.handlePageShowOrResume();

  resolveInitialGrant();
  await initPromise;
  await hidePromise;
  const restoredA = await restorePromise;
  assert.equal(restoredA, true);
  assert.equal(ctrl.getViewModel().isWriter, true);
  assert.equal(ctrl.getViewModel().lockStatus, 'HELD');

  // Case B: delayed writer release across hide -> restore
  let resolveOuter;
  delayOuterFinish = new Promise((r) => {
    resolveOuter = r;
  });
  const hideB = ctrl.handlePageHideOrFreeze('freeze');
  const restoreB = ctrl.handlePageShowOrResume();
  resolveOuter();
  await hideB;
  assert.equal(await restoreB, true);
  assert.equal(ctrl.getViewModel().isWriter, true);

  // Case C: another hide during restore wait supersedes restore and stays READ_ONLY
  let resolveOuterC;
  delayOuterFinish = new Promise((r) => {
    resolveOuterC = r;
  });
  const hideC1 = ctrl.handlePageHideOrFreeze('pagehide');
  const restoreC = ctrl.handlePageShowOrResume();
  const hideC2 = ctrl.handlePageHideOrFreeze('freeze');
  resolveOuterC();
  await Promise.all([hideC1, hideC2]);
  assert.equal(await restoreC, false);
  assert.equal(ctrl.getViewModel().isWriter, false);
});

test('Regression P2: malformed diagnostic timestamp formats safely without throwing RangeError', () => {
  assert.equal(formatDiagTime(1e20), '--:--:--');
  assert.equal(formatDiagTime(-1e20), '--:--:--');
  assert.equal(formatDiagTime(Number.NaN), '--:--:--');
  assert.equal(formatDiagTime(Date.UTC(2026, 0, 1, 14, 5, 9)), '14:05:09');
});

test('Amateur rules: defaults migration, watch server pick, ignored Center, stale phone pick, save-fail diag, and AD/GP selection', async () => {
  // 1. Legacy defaults `{ initialServer: 0 }` migrate cleanly to `{ scoringMode: "AD", initialServer: 0 }`
  const legacyStorage = createMemoryStorage();
  legacyStorage.setItem(DEFAULTS_STORAGE_KEY, JSON.stringify({ initialServer: 0 }));
  const legacyCtrl = createAppController({
    storage: legacyStorage,
    locks: createSharedMockLocks(),
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: createSimpleMediaSession(),
    createMatchId: () => 'm-legacy',
    now: () => 1000,
  });
  await legacyCtrl.init();
  assert.equal(legacyCtrl.getViewModel().setupScoringMode, 'AD');
  assert.equal(legacyCtrl.getViewModel().setupInitialServer, 0);
  await legacyCtrl.handlePageHideOrFreeze();

  // 2. Fresh defaults = AD + Pick on watch (null)
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const audioH = createSimpleAudioHarness();
  const ms = createSimpleMediaSession();
  let clock = 2000;
  let idSeq = 0;

  const ctrl = createAppController({
    storage,
    locks,
    createAudio: audioH.createAudio,
    mediaSession: ms,
    createMatchId: () => `m-am-${++idSeq}`,
    now: () => clock,
  });

  await ctrl.init();
  assert.equal(ctrl.getViewModel().setupScoringMode, 'AD');
  assert.equal(ctrl.getViewModel().setupInitialServer, null);

  await ctrl.startMatch({ linkWrist: true });
  let vm = ctrl.getViewModel();
  assert.equal(vm.screen, 'LIVE');
  assert.equal(vm.state.needsInitialServer, true);
  assert.equal(vm.state.server, null);
  assert.equal(vm.wrist.status, 'ARMED');
  assert.equal(ms.metadata.title, 'WHO SERVES? #1');
  assert.equal(ms.metadata.artist, '< US   THEM >');

  // Center tap (MY UE) while awaiting server is safely ignored (no write, audio stays playing, diag logs ignored_awaiting_server)
  ms.handlers.get('pause')();
  await Promise.resolve();
  assert.equal(ctrl.getViewModel().record.revision, 1);
  assert.equal(ctrl.getViewModel().state.needsInitialServer, true);
  assert.equal(audioH.created.at(-1).paused, false);
  assert.ok(ctrl._diagLog.readAll().entries.some((e) => e.action === 'ignored_awaiting_server'));

  // Quota error during watch pick logs wrist_save_failed_* (NOT saved wrist_previoustrack)
  storage.setFailNextSet(new Error('QuotaExceeded'));
  ms.handlers.get('previoustrack')();
  await Promise.resolve();
  assert.equal(ctrl.getViewModel().record.revision, 1);
  assert.equal(ctrl.getViewModel().state.needsInitialServer, true);
  assert.ok(ctrl._diagLog.readAll().entries.some((e) => e.action === 'wrist_save_failed_previoustrack'));

  // Watch Prev (US) picks US as opener -> rev 2, 0 events, band shows US SERVES #2
  ms.handlers.get('previoustrack')();
  await Promise.resolve();
  await Promise.resolve();
  vm = ctrl.getViewModel();
  assert.equal(vm.record.revision, 2);
  assert.equal(vm.record.events.length, 0);
  assert.equal(vm.state.server, 0);
  assert.equal(vm.state.needsInitialServer, false);
  assert.equal(ms.metadata.title, 'US SERVES #2');
  assert.equal(ms.metadata.artist, '0-0 0-0 S0-0');

  // Next-match preference stays "Pick on watch" (null) even after picking US for this match
  assert.equal(JSON.parse(storage.getItem(DEFAULTS_STORAGE_KEY)).initialServer, null);

  // Stale phone pick action is a harmless no-op once opener is set
  const staleRes = await ctrl.selectInitialServer(1);
  assert.equal(staleRes.changed, false);
  assert.equal(ctrl.getViewModel().state.server, 0);
  assert.equal(ctrl.getViewModel().record.revision, 2);

  // Scoring now works in AD mode -> band transitions to *15-0 0-0 #3
  ms.handlers.get('previoustrack')();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctrl.getViewModel().record.revision, 3);
  assert.equal(ms.metadata.title, '*15-0 0-0 #3');

  // Finish and open replacement draft -> verify GP selectable and preserved
  await ctrl.finishNow();
  assert.equal(ctrl.openReplacementSetup(), true);
  ctrl.setSetupScoringMode('GP');
  ctrl.setSetupInitialServer(1);
  await ctrl.startMatch({ linkWrist: false });
  assert.equal(ctrl.getViewModel().record.config.scoringMode, 'GP');
  assert.equal(ctrl.getViewModel().record.config.initialServer, 1);
  assert.equal(JSON.parse(storage.getItem(DEFAULTS_STORAGE_KEY)).scoringMode, 'GP');

  await ctrl.handlePageHideOrFreeze();
});
