import test from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_STORAGE_KEY } from '../src/core/matchStore.js';
import { HISTORY_STORAGE_KEY } from '../src/core/matchHistory.js';
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
  let failHistorySet = null;
  let failDefaultsSet = null;
  let failGet = null;
  return {
    setFailNextSet(err) {
      failNextSet = err;
    },
    setFailHistorySet(err) {
      failHistorySet = err;
    },
    setFailDefaultsSet(err) {
      failDefaultsSet = err;
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
      if (failHistorySet && k === HISTORY_STORAGE_KEY) {
        throw failHistorySet;
      }
      if (failDefaultsSet && k === DEFAULTS_STORAGE_KEY) {
        throw failDefaultsSet;
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

test('Epic 5 E2E Gate: finish from wrist -> force archive quota failure -> reload -> New Match preserves finished copy until archived or explicitly discarded', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const audioH = createSimpleAudioHarness();
  const ms = createSimpleMediaSession();
  let clock = Date.UTC(2026, 4, 2, 18, 0, 0);
  let idSeq = 0;

  const ctrl1 = createAppController({
    storage,
    locks,
    createAudio: audioH.createAudio,
    mediaSession: ms,
    createMatchId: () => `m-e2e-${++idSeq}`,
    now: () => clock,
  });

  await ctrl1.init();
  ctrl1.setSetupInitialServer(0);
  await ctrl1.startMatch({ linkWrist: true });
  assert.equal(ctrl1.getViewModel().wrist.status, 'ARMED');

  // Score 47 points to reach match point (6-0, 5-0, 40-0)
  for (let i = 0; i < 47; i += 1) {
    clock += 2000;
    await ctrl1.scorePoint('A');
  }

  // Force history quota failure right before wrist scores winning point #48!
  storage.setFailHistorySet(new Error('QuotaExceededError: history full'));
  clock += 2000;
  ms.handlers.get('previoustrack')();
  await Promise.resolve();
  await Promise.resolve();

  let vm = ctrl1.getViewModel();
  assert.equal(vm.screen, 'MATCH_OVER');
  assert.equal(vm.state.status, 'WON');
  assert.equal(vm.currentTerminalArchived, false);
  assert.match(vm.history.error, /Match saved on this device\. History update failed/);
  assert.ok(vm.matchOverAnalytics);
  // Export still works while unarchived
  const exp = ctrl1.getExportData({ source: 'current' }, 'json');
  assert.equal(exp.ok, true);
  assert.equal(JSON.parse(exp.content).match.matchId, 'm-e2e-1');

  // Simulate full reload while quota is still failing
  await ctrl1.handlePageHideOrFreeze('pagehide');
  const ctrl2 = createAppController({
    storage,
    locks,
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: createSimpleMediaSession(),
    createMatchId: () => `m-e2e-${++idSeq}`,
    now: () => clock,
  });
  await ctrl2.init();

  vm = ctrl2.getViewModel();
  assert.equal(vm.screen, 'MATCH_OVER');
  assert.equal(vm.record.matchId, 'm-e2e-1');
  assert.equal(vm.currentTerminalArchived, false);

  // Tap New Match -> Start Match MUST NOT destroy the unarchived finished copy!
  assert.equal(ctrl2.openReplacementSetup(), true);
  const blocked = await ctrl2.startMatch({ linkWrist: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stage, 'archive');
  assert.equal(ctrl2.getViewModel().screen, 'SETUP');
  assert.equal(ctrl2.getViewModel().archiveBlockedDraft, true);
  assert.equal(ctrl2.getViewModel().record.matchId, 'm-e2e-1'); // Preserved!

  // Quota clears -> Retry Save to History archives exact snapshot -> Start Match succeeds!
  storage.setFailHistorySet(null);
  const retry = ctrl2.retryArchiveCurrentMatch();
  assert.equal(retry.ok, true);
  assert.equal(ctrl2.getViewModel().currentTerminalArchived, true);
  assert.equal(ctrl2.getViewModel().archiveBlockedDraft, false);

  const started = await ctrl2.startMatch({ linkWrist: false });
  assert.equal(started.ok, true);
  assert.equal(ctrl2.getViewModel().record.matchId, 'm-e2e-2');
  assert.equal(ctrl2.getViewModel().history.count, 1);
  assert.equal(ctrl2.getViewModel().history.items[0].matchId, 'm-e2e-1');
  await ctrl2.handlePageHideOrFreeze();
});

test('Epic 5: Undo/Resume suppresses stale history if removal fails; Delete blocked while open on Match Over; wrist win preserves History Detail & export', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const audioH = createSimpleAudioHarness();
  const ms = createSimpleMediaSession();
  let clock = Date.UTC(2026, 4, 3, 18, 0, 0);
  let idSeq = 0;

  const ctrl = createAppController({
    storage,
    locks,
    createAudio: audioH.createAudio,
    mediaSession: ms,
    createMatchId: () => `m-hist-${++idSeq}`,
    now: () => clock,
  });

  await ctrl.init();
  ctrl.setSetupInitialServer(0);
  await ctrl.startMatch({ linkWrist: false });
  clock += 5000;
  await ctrl.scorePoint('E');
  clock += 5000;
  await ctrl.finishNow();

  // Archived automatically, but Delete is disabled while still open on Match Over
  assert.equal(ctrl.getViewModel().history.count, 1);
  assert.equal(ctrl.getViewModel().history.items[0].canDelete, false);
  const delBlocked = ctrl.deleteHistoryMatch('m-hist-1');
  assert.equal(delBlocked.ok, false);

  // Resume while history removal fails -> stale history row is SUPPRESSED while ACTIVE!
  storage.setFailHistorySet(new Error('Temp write error'));
  await ctrl.resume();
  assert.equal(ctrl.getViewModel().screen, 'LIVE');
  assert.equal(ctrl.getViewModel().history.count, 0); // Suppressed!

  // Finish again after storage recovers -> re-archives cleanly, then start Match 2
  storage.setFailHistorySet(null);
  clock += 5000;
  await ctrl.finishNow();
  assert.equal(ctrl.getViewModel().history.count, 1);

  ctrl.openReplacementSetup();
  ctrl.setSetupInitialServer(0);
  await ctrl.startMatch({ linkWrist: true });
  assert.equal(ctrl.getViewModel().record.matchId, 'm-hist-2');
  assert.equal(ctrl.getViewModel().wrist.status, 'ARMED');

  // Score 47 points in Match 2, then open History and inspect archived Match 1 while wrist stays ARMED!
  for (let i = 0; i < 47; i += 1) {
    clock += 1000;
    await ctrl.scorePoint('A');
  }
  ctrl.openHistory();
  assert.equal(ctrl.getViewModel().screen, 'HISTORY');
  assert.equal(ctrl.getViewModel().wrist.status, 'ARMED');
  assert.equal(ctrl.inspectHistoryMatch('m-hist-1'), true);
  assert.equal(ctrl.getViewModel().screen, 'HISTORY_DETAIL');

  const exportMatch1Before = ctrl.getExportData({ source: 'history', matchId: 'm-hist-1' }, 'csv').content;

  // Wrist scores winning point #48 in Match 2 WHILE user is inspecting Match 1!
  clock += 1000;
  ms.handlers.get('previoustrack')();
  await Promise.resolve();
  await Promise.resolve();

  // Inspection screen stays on Match 1, Match 1 export bytes are identical, and Match 2 is archived!
  assert.equal(ctrl.getViewModel().screen, 'HISTORY_DETAIL');
  assert.equal(ctrl.getViewModel().history.inspectedRecord.matchId, 'm-hist-1');
  assert.equal(
    ctrl.getExportData({ source: 'history', matchId: 'm-hist-1' }, 'csv').content,
    exportMatch1Before
  );
  assert.equal(ctrl.getViewModel().history.count, 2);

  // Deleting Match 1 (no longer active key) succeeds and returns to History list
  const delOk = ctrl.deleteHistoryMatch('m-hist-1');
  assert.equal(delOk.ok, true);
  assert.equal(ctrl.getViewModel().screen, 'HISTORY');
  assert.equal(ctrl.getViewModel().history.count, 1);

  // Closing History reveals the newly WON Match 2 on Match Over!
  ctrl.closeHistory();
  assert.equal(ctrl.getViewModel().screen, 'MATCH_OVER');
  assert.equal(ctrl.getViewModel().record.matchId, 'm-hist-2');
  assert.equal(ctrl.getViewModel().state.status, 'WON');

  // Cross-tab storage event on HISTORY_STORAGE_KEY refreshes inspected view cleanly if deleted externally
  ctrl.openHistory();
  ctrl.inspectHistoryMatch('m-hist-2');
  storage.clearAll();
  ctrl.handleStorageEvent(HISTORY_STORAGE_KEY);
  assert.equal(ctrl.getViewModel().screen, 'HISTORY');
  assert.equal(ctrl.getViewModel().history.count, 0);

  await ctrl.handlePageHideOrFreeze();
});

test('Epic 5 Regressions (P1/P2): rally-mismatch blocks replacement, failed re-archive hides stale finish, and matchId="active" exports history row', async () => {
  const T0 = Date.UTC(2026, 4, 4, 18, 0, 0);

  // 1. P1: Active key has rally E, history has same metadata with rally B, history writes fail -> New Match blocked!
  const storage1 = createMemoryStorage();
  const baseE = {
    schemaVersion: 1,
    matchId: 'm-mismatch',
    revision: 3,
    config: { scoringMode: 'AD', format: 'BO3', decidingSet: 'NORMAL', initialServer: 0 },
    startTimeMs: T0,
    finishTimeMs: T0 + 5000,
    status: 'FINISHED_MANUAL',
    nextEventId: 2,
    events: [{ id: 1, t: T0 + 1000, code: 'E' }],
  };
  const copyB = { ...baseE, events: [{ id: 1, t: T0 + 1000, code: 'B' }] };
  storage1.setRaw(MATCH_STORAGE_KEY, JSON.stringify(baseE));
  storage1.setRaw(HISTORY_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, matches: [copyB] }));
  storage1.setFailHistorySet(new Error('QuotaExceeded'));

  const c1 = createAppController({
    storage: storage1,
    locks: createSharedMockLocks(),
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: createSimpleMediaSession(),
    createMatchId: () => 'm-new-1',
    now: () => T0 + 10_000,
  });
  await c1.init();
  assert.equal(c1.getViewModel().currentTerminalArchived, false);
  // Stale copyB with mismatched rally is also hidden from visible history while baseE is open!
  assert.equal(c1.getViewModel().history.count, 0);
  c1.openReplacementSetup();
  const blocked = await c1.startMatch({ linkWrist: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stage, 'archive');
  assert.equal(c1.getViewModel().record.events[0].code, 'E');
  await c1.handlePageHideOrFreeze();

  // 2. P2: Failed re-archive after Resume + 2nd rally + Finish keeps stale rev 3 hidden from History
  const storage2 = createMemoryStorage();
  let clock2 = T0;
  const c2 = createAppController({
    storage: storage2,
    locks: createSharedMockLocks(),
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: createSimpleMediaSession(),
    createMatchId: () => 'm-rearchive',
    now: () => clock2,
  });
  await c2.init();
  c2.setSetupInitialServer(0);
  await c2.startMatch({ linkWrist: false });
  clock2 += 1000;
  await c2.scorePoint('E');
  clock2 += 1000;
  await c2.finishNow(); // rev 3 archived
  assert.equal(c2.getViewModel().history.count, 1);

  storage2.setFailHistorySet(new Error('QuotaExceeded'));
  await c2.resume(); // rev 4 (removal fails, hidden while active)
  clock2 += 1000;
  await c2.scorePoint('A'); // rev 5
  clock2 += 1000;
  await c2.finishNow(); // rev 6 (re-archive fails!)

  assert.equal(c2.getViewModel().screen, 'MATCH_OVER');
  assert.equal(c2.getViewModel().record.revision, 6);
  // Stale rev 3 MUST stay hidden so History cannot show rev 3 as "Currently open on Match Over"!
  assert.equal(c2.getViewModel().history.count, 0);
  assert.equal(c2.inspectHistoryMatch('m-rearchive'), false);
  await c2.handlePageHideOrFreeze();

  // 3. P2: Valid archived matchId="active" exports archived row, NOT the live match!
  const storage3 = createMemoryStorage();
  const archivedActiveId = { ...baseE, matchId: 'active' };
  storage3.setRaw(HISTORY_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, matches: [archivedActiveId] }));
  const c3 = createAppController({
    storage: storage3,
    locks: createSharedMockLocks(),
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: createSimpleMediaSession(),
    createMatchId: () => 'm-live-other',
    now: () => T0 + 20_000,
  });
  await c3.init();
  c3.setSetupInitialServer(0);
  await c3.startMatch({ linkWrist: false });
  assert.equal(c3.getViewModel().record.matchId, 'm-live-other');

  c3.openHistory();
  assert.equal(c3.inspectHistoryMatch('active'), true);
  const jsonExp = c3.getExportData({ source: 'history', matchId: 'active' }, 'json');
  const csvExp = c3.getExportData({ source: 'history', matchId: 'active' }, 'csv');
  assert.equal(jsonExp.ok, true);
  assert.equal(csvExp.ok, true);
  assert.equal(JSON.parse(jsonExp.content).match.matchId, 'active');
  assert.equal(JSON.parse(jsonExp.content).match.events[0].code, 'E');
  assert.match(csvExp.content, /,E,THEM,true,/);
  await c3.handlePageHideOrFreeze();
});

test('S4.2 Priority Trace (stalled publisher): EDIT -> Prev x2 -> Phone Cancel -> Next -> drain -> Center -> Next', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const audioH = createSimpleAudioHarness();
  const metadataLog = [];
  const handlers = new Map();
  const ms = {
    playbackState: 'none',
    setActionHandler(action, fn) {
      if (fn === null) handlers.delete(action);
      else handlers.set(action, fn);
    },
    setPositionState() {},
    handlers,
    set metadata(val) {
      this._m = val;
      if (val) metadataLog.push({ title: val.title, artist: val.artist });
    },
    get metadata() {
      return this._m ?? null;
    },
  };

  let clock = Date.UTC(2026, 4, 5, 18, 0, 0);
  let stallGate = null;
  let releaseGate = null;

  const ctrl = createAppController({
    storage,
    locks,
    createAudio: audioH.createAudio,
    mediaSession: ms,
    createMatchId: () => 'm-s42-trace',
    now: () => clock,
    beforePublish: async () => {
      if (stallGate) {
        await stallGate;
      }
    },
  });

  await ctrl.init();
  ctrl.setSetupInitialServer(0);
  ctrl.setWristCenterMode('EDIT_MODE');
  await ctrl.startMatch({ linkWrist: true });
  clock += 1000;
  await ctrl.scorePoint('A'); // rev 2, 15-0
  assert.equal(ctrl.getViewModel().record.revision, 2);
  const logCountBeforeStall = metadataLog.length;

  // Stall the publish queue!
  stallGate = new Promise((res) => {
    releaseGate = res;
  });

  // 1. Center opens EDIT #2
  handlers.get('pause')();
  assert.equal(ctrl.getViewModel().editState.phase, 'PROMPT');
  assert.equal(ctrl.getViewModel().editState.baseRevision, 2);

  // 2. Press Prev TWICE: first Prev undoes to rev 3 (0-0), second Prev is ignored!
  handlers.get('previoustrack')();
  handlers.get('previoustrack')();
  assert.equal(ctrl.getViewModel().record.revision, 3);
  assert.equal(ctrl.getViewModel().record.events.length, 0);
  assert.equal(ctrl.getViewModel().editState.phase, 'AWAITING_LIVE');
  assert.equal(ctrl.getViewModel().editState.reason, 'UNDO');

  // 3. Cancel on phone -> enters AWAITING_LIVE(INVALIDATED, #3), arrows stay blocked!
  const cancelPromise = ctrl.cancelWristEdit();
  assert.equal(ctrl.getViewModel().editState.phase, 'AWAITING_LIVE');
  assert.equal(ctrl.getViewModel().editState.reason, 'INVALIDATED');

  // 4. Press Next BEFORE draining -> consumed without scoring!
  handlers.get('nexttrack')();
  assert.equal(ctrl.getViewModel().record.revision, 3);
  assert.equal(ctrl.getViewModel().record.events.length, 0);

  // 5. Release stalled publisher -> ZERO obsolete EDIT #2 or UNDO written; ONLY EDIT OFF #3 writes!
  stallGate = null;
  releaseGate();
  await cancelPromise;
  await Promise.resolve();

  const writtenDuringStall = metadataLog.slice(logCountBeforeStall);
  assert.deepEqual(writtenDuringStall, [{ title: 'EDIT OFF #3', artist: 'TAP || FOR LIVE' }]);

  // 6. Press Center -> returns to LIVE; Next arrow now scores THEM +1 (rev 4)!
  handlers.get('play')();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctrl.getViewModel().editState.phase, 'LIVE');

  clock += 1000;
  handlers.get('nexttrack')();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctrl.getViewModel().record.revision, 4);
  assert.deepEqual(
    ctrl.getViewModel().record.events.map((e) => e.code),
    ['B']
  );

  await ctrl.handlePageHideOrFreeze();
});

test('S4.2: Interruption -> Re-link restores INVALIDATED barrier, quota failure preserves PROMPT, mode switch blocks arrows until Center, and winning UE disarms', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const listenersByEl = new Map();
  const createdAudio = [];
  const ms = createSimpleMediaSession();
  let clock = Date.UTC(2026, 4, 6, 18, 0, 0);

  const ctrl = createAppController({
    storage,
    locks,
    mediaSession: ms,
    createMatchId: () => 'm-s42-edge',
    now: () => clock,
    createAudio: () => {
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
        emit(t) {
          for (const fn of [...(listeners.get(t) || [])]) fn({ type: t });
        },
        play() {
          el.paused = false;
          return Promise.resolve();
        },
        pause() {
          el.paused = true;
        },
      };
      listenersByEl.set(el, listeners);
      createdAudio.push(el);
      return el;
    },
  });

  await ctrl.init();
  ctrl.setSetupInitialServer(0);
  ctrl.setWristCenterMode('EDIT_MODE');
  await ctrl.startMatch({ linkWrist: true });
  await ctrl.scorePoint('A'); // rev 2

  // 1. Open EDIT #2 -> quota error on Prev keeps PROMPT #2 intact for retry
  ms.handlers.get('pause')();
  assert.equal(ctrl.getViewModel().editState.phase, 'PROMPT');
  storage.setFailNextSet(new Error('QuotaExceeded'));
  ms.handlers.get('previoustrack')();
  assert.equal(ctrl.getViewModel().record.revision, 2);
  assert.equal(ctrl.getViewModel().editState.phase, 'PROMPT');

  // 2. OS audio interruption while PROMPT is open -> Re-link restores AWAITING_LIVE(INVALIDATED)
  const el1 = createdAudio.at(-1);
  el1.paused = true;
  el1.emit('pause');
  assert.equal(ctrl.getViewModel().wrist.status, 'INTERRUPTED');

  await ctrl.relinkWrist();
  assert.equal(ctrl.getViewModel().wrist.status, 'ARMED');
  assert.equal(ctrl.getViewModel().editState.phase, 'AWAITING_LIVE');
  assert.equal(ctrl.getViewModel().editState.reason, 'INVALIDATED');
  assert.equal(ms.metadata.title, 'EDIT OFF #2');

  // Arrows swallowed until Center
  ms.handlers.get('previoustrack')();
  assert.equal(ctrl.getViewModel().record.revision, 2);
  ms.handlers.get('pause')(); // Center -> LIVE
  assert.equal(ctrl.getViewModel().editState.phase, 'LIVE');

  // 3. Mode switch EDIT_MODE -> ONE_TAP_UE while PROMPT open blocks arrows until Center (and Center does NOT score MY UE!)
  ms.handlers.get('pause')();
  assert.equal(ctrl.getViewModel().editState.phase, 'PROMPT');
  ctrl.setWristCenterMode('ONE_TAP_UE');
  assert.equal(ctrl.getViewModel().editState.phase, 'AWAITING_LIVE');
  ms.handlers.get('previoustrack')(); // Swallowed!
  assert.equal(ctrl.getViewModel().record.revision, 2);
  ms.handlers.get('pause')(); // Center returns to LIVE (does NOT log MY UE!)
  assert.equal(ctrl.getViewModel().editState.phase, 'LIVE');
  assert.equal(ctrl.getViewModel().record.revision, 2);

  // 4. Switch back to EDIT_MODE, play to match point for THEM (47 B points + undo A -> 47 B), then EDIT -> Next (MY UE) wins match & disarms!
  ctrl.setWristCenterMode('EDIT_MODE');
  await ctrl.undo(); // back to 0-0
  for (let i = 0; i < 47; i += 1) {
    clock += 1000;
    await ctrl.scorePoint('B');
  }
  ms.handlers.get('pause')(); // Open EDIT prompt
  assert.equal(ctrl.getViewModel().editState.phase, 'PROMPT');
  ms.handlers.get('nexttrack')(); // MY UE -> THEM wins match!
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(ctrl.getViewModel().screen, 'MATCH_OVER');
  assert.equal(ctrl.getViewModel().state.status, 'WON');
  assert.equal(ctrl.getViewModel().state.winner, 1);
  assert.equal(ctrl.getViewModel().editState.phase, 'LIVE');
  assert.equal(ctrl.getViewModel().wrist.status, 'DISARMED');
  assert.ok(ms.metadata.title.startsWith('LOSS 0-2'));
  assert.equal(createdAudio.at(-1).paused, true);

  await ctrl.handlePageHideOrFreeze();
});

test('S4.2 review regression (P1): writer takeover and page restore reload saved wristCenterMode from storage', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const clock = Date.UTC(2026, 4, 7, 18, 0, 0);

  const msA = createSimpleMediaSession();
  const msB = createSimpleMediaSession();

  // Seed ONE_TAP_UE so both tabs start in ONE_TAP_UE before Tab A switches to EDIT_MODE
  storage.setItem(
    DEFAULTS_STORAGE_KEY,
    JSON.stringify({ scoringMode: 'AD', initialServer: null, wristCenterMode: 'ONE_TAP_UE' })
  );

  const tabA = createAppController({
    storage,
    locks,
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: msA,
    createMatchId: () => 'm-takeover-mode',
    now: () => clock,
  });
  const tabB = createAppController({
    storage,
    locks,
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: msB,
    createMatchId: () => 'm-unused',
    now: () => clock,
  });

  // Both tabs start with ONE_TAP_UE loaded from storage
  await tabA.init();
  await tabB.init();
  assert.equal(tabA.getViewModel().isWriter, true);
  assert.equal(tabB.getViewModel().isWriter, false);
  assert.equal(tabA.getViewModel().wristCenterMode, 'ONE_TAP_UE');
  assert.equal(tabB.getViewModel().wristCenterMode, 'ONE_TAP_UE');

  // Read-only Tab B cannot mutate wristCenterMode or defaults storage
  const roRes = tabB.setWristCenterMode('EDIT_MODE');
  assert.equal(roRes.ok, false);
  assert.equal(roRes.persisted, false);
  assert.equal(tabB.getViewModel().wristCenterMode, 'ONE_TAP_UE');
  assert.match(tabB.getViewModel().actionError, /Read-only/i);

  // Tab A starts match with known server, switches to EDIT_MODE, and steps down
  tabA.setSetupInitialServer(0);
  await tabA.startMatch({ linkWrist: false });
  const modeRes = tabA.setWristCenterMode('EDIT_MODE');
  assert.equal(modeRes.ok, true);
  assert.equal(modeRes.persisted, true);
  await tabA.stepDownToReadOnly();

  // Tab B takes over WITHOUT having received a storage event -> MUST reload EDIT_MODE!
  const tookOver = await tabB.takeOverWriter();
  assert.equal(tookOver, true);
  assert.equal(tabB.getViewModel().wristCenterMode, 'EDIT_MODE');

  await tabB.relinkWrist();
  msB.handlers.get('pause')();
  assert.equal(tabB.getViewModel().editState.phase, 'PROMPT');
  assert.equal(tabB.getViewModel().record.events.length, 0); // Did NOT record MY UE!

  // Page hide -> storage changed externally back to ONE_TAP_UE -> page restore reloads ONE_TAP_UE
  await tabB.handlePageHideOrFreeze();
  storage.setItem(
    'padelScore.defaults.v1',
    JSON.stringify({ scoringMode: 'AD', initialServer: 0, wristCenterMode: 'ONE_TAP_UE' })
  );
  const restored = await tabB.handlePageShowOrResume();
  assert.equal(restored, true);
  assert.equal(tabB.getViewModel().wristCenterMode, 'ONE_TAP_UE');

  await tabB.handlePageHideOrFreeze();
  await tabA.handlePageHideOrFreeze();
});

test('S4.2 review regression (P1): failed defaults write surfaces session-only warning on setWristCenterMode', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const ctrl = createAppController({
    storage,
    locks,
    createAudio: createSimpleAudioHarness().createAudio,
    mediaSession: createSimpleMediaSession(),
    now: () => Date.UTC(2026, 4, 8, 18, 0, 0),
  });

  await ctrl.init();
  assert.equal(ctrl.getViewModel().wristCenterMode, 'EDIT_MODE');

  const quotaErr = new Error('QuotaExceededError');
  quotaErr.name = 'QuotaExceededError';
  storage.setFailDefaultsSet(quotaErr);

  const res = ctrl.setWristCenterMode('ONE_TAP_UE');
  assert.equal(res.ok, true);
  assert.equal(res.persisted, false);
  assert.equal(ctrl.getViewModel().wristCenterMode, 'ONE_TAP_UE');
  assert.match(ctrl.getViewModel().actionError, /this session only/i);

  await ctrl.handlePageHideOrFreeze();
});

test('S4.2 review regression (P2): ordinary LIVE revisions stay in FIFO publish queue when stalled', async () => {
  const storage = createMemoryStorage();
  const locks = createSharedMockLocks();
  const audioH = createSimpleAudioHarness();
  const metadataLog = [];
  const handlers = new Map();
  const ms = {
    playbackState: 'none',
    setActionHandler(action, fn) {
      if (fn === null) handlers.delete(action);
      else handlers.set(action, fn);
    },
    setPositionState() {},
    handlers,
    set metadata(val) {
      this._m = val;
      if (val) metadataLog.push({ title: val.title, artist: val.artist });
    },
    get metadata() {
      return this._m ?? null;
    },
  };

  let clock = Date.UTC(2026, 4, 9, 18, 0, 0);
  let stallGate = null;
  let releaseGate = null;

  const ctrl = createAppController({
    storage,
    locks,
    createAudio: audioH.createAudio,
    mediaSession: ms,
    createMatchId: () => 'm-live-fifo',
    now: () => clock,
    beforePublish: async () => {
      if (stallGate) {
        await stallGate;
      }
    },
  });

  await ctrl.init();
  ctrl.setSetupInitialServer(0);
  await ctrl.startMatch({ linkWrist: true });
  const beforeStallCount = metadataLog.length;

  stallGate = new Promise((res) => {
    releaseGate = res;
  });

  clock += 1000;
  const p2 = ctrl.scorePoint('A'); // #2: *15-0
  clock += 1000;
  const p3 = ctrl.scorePoint('B'); // #3: *15-15

  stallGate = null;
  releaseGate();

  const [r2, r3] = await Promise.all([p2, p3]);
  assert.equal(r2.ok, true);
  assert.equal(r2.wristPublished, true);
  assert.equal(r3.ok, true);
  assert.equal(r3.wristPublished, true);

  const written = metadataLog.slice(beforeStallCount);
  assert.equal(written.length, 2);
  assert.ok(written[0].title.includes('#2'));
  assert.ok(written[0].title.includes('*15-0'));
  assert.ok(written[1].title.includes('#3'));
  assert.ok(written[1].title.includes('*15-15'));

  await ctrl.handlePageHideOrFreeze();
});

test('Phone UI Redesign: EDIT_MODE default migration (fresh, explicit both, missing, invalid, legacy resume) + guideOpen isolation', async () => {
  const T0 = Date.UTC(2026, 4, 10, 19, 0, 0);

  async function checkCase(label, rawDefaults, { seedActive = false } = {}) {
    const storage = createMemoryStorage();
    if (rawDefaults !== undefined) {
      storage.setRaw(DEFAULTS_STORAGE_KEY, rawDefaults);
    }
    if (seedActive) {
      storage.setRaw(
        MATCH_STORAGE_KEY,
        JSON.stringify({
          schemaVersion: 1,
          matchId: `m-legacy-${label}`,
          revision: 2,
          config: { scoringMode: 'GP', format: 'BO3', decidingSet: 'NORMAL', initialServer: 1 },
          startTimeMs: T0,
          finishTimeMs: null,
          status: 'ACTIVE',
          nextEventId: 2,
          events: [{ id: 1, t: T0 + 1000, code: 'A' }],
        })
      );
    }

    const ms = createSimpleMediaSession();
    const ctrl = createAppController({
      storage,
      locks: createSharedMockLocks(),
      createAudio: createSimpleAudioHarness().createAudio,
      mediaSession: ms,
      createMatchId: () => `m-case-${label}`,
      now: () => T0 + 2000,
    });
    await ctrl.init();

    const beforeVm = ctrl.getViewModel();
    if (!seedActive) {
      ctrl.setSetupInitialServer(0);
      await ctrl.startMatch({ linkWrist: true });
    } else {
      await ctrl.relinkWrist();
    }

    // Toggle Band guide open & closed -> zero storage/revision mutation
    const revBeforeGuide = ctrl.getViewModel().record.revision;
    ctrl.setGuideOpen(true);
    assert.equal(ctrl.getViewModel().ui.guideOpen, true);
    assert.equal(ctrl.getViewModel().ui.menuOpen, false);
    ctrl.setMenuOpen(true);
    assert.equal(ctrl.getViewModel().ui.menuOpen, true);
    assert.equal(ctrl.getViewModel().ui.guideOpen, false);
    ctrl.setMenuOpen(false);
    assert.equal(ctrl.getViewModel().record.revision, revBeforeGuide);

    // Press Center once and observe exact outcome
    ms.handlers.get('pause')();
    const afterVm = ctrl.getViewModel();
    await ctrl.handlePageHideOrFreeze();
    return { beforeVm, afterVm };
  }

  // 1. Fresh install -> EDIT_MODE default, first Center opens PROMPT without scoring
  const fresh = await checkCase('fresh', undefined);
  assert.equal(fresh.beforeVm.wristCenterMode, 'EDIT_MODE');
  assert.equal(fresh.beforeVm.setupScoringMode, 'AD');
  assert.equal(fresh.beforeVm.setupInitialServer, null);
  assert.equal(fresh.afterVm.editState.phase, 'PROMPT');
  assert.equal(fresh.afterVm.record.events.length, 0);

  // 2. Explicit ONE_TAP_UE -> honored, preserves scoringMode/initialServer, first Center scores E
  const explicitOneTap = await checkCase(
    'explicit-1tap',
    JSON.stringify({ scoringMode: 'GP', initialServer: 1, wristCenterMode: 'ONE_TAP_UE' })
  );
  assert.equal(explicitOneTap.beforeVm.wristCenterMode, 'ONE_TAP_UE');
  assert.equal(explicitOneTap.beforeVm.setupScoringMode, 'GP');
  assert.equal(explicitOneTap.beforeVm.setupInitialServer, 1);
  assert.equal(explicitOneTap.afterVm.editState.phase, 'LIVE');
  assert.deepEqual(explicitOneTap.afterVm.record.events.map((e) => e.code), ['E']);

  // 3. Explicit EDIT_MODE -> honored, preserves scoringMode/initialServer, first Center opens PROMPT
  const explicitEdit = await checkCase(
    'explicit-edit',
    JSON.stringify({ scoringMode: 'GP', initialServer: 0, wristCenterMode: 'EDIT_MODE' })
  );
  assert.equal(explicitEdit.beforeVm.wristCenterMode, 'EDIT_MODE');
  assert.equal(explicitEdit.beforeVm.setupScoringMode, 'GP');
  assert.equal(explicitEdit.beforeVm.setupInitialServer, 0);
  assert.equal(explicitEdit.afterVm.editState.phase, 'PROMPT');
  assert.equal(explicitEdit.afterVm.record.events.length, 0);

  // 4. Missing wristCenterMode -> EDIT_MODE default, preserves scoringMode/initialServer
  const missingField = await checkCase(
    'missing',
    JSON.stringify({ scoringMode: 'GP', initialServer: 1 })
  );
  assert.equal(missingField.beforeVm.wristCenterMode, 'EDIT_MODE');
  assert.equal(missingField.beforeVm.setupScoringMode, 'GP');
  assert.equal(missingField.beforeVm.setupInitialServer, 1);
  assert.equal(missingField.afterVm.editState.phase, 'PROMPT');

  // 5. Invalid wristCenterMode -> EDIT_MODE default, preserves scoringMode/initialServer
  const invalidField = await checkCase(
    'invalid',
    JSON.stringify({ scoringMode: 'AD', initialServer: 1, wristCenterMode: 'BOGUS' })
  );
  assert.equal(invalidField.beforeVm.wristCenterMode, 'EDIT_MODE');
  assert.equal(invalidField.beforeVm.setupScoringMode, 'AD');
  assert.equal(invalidField.beforeVm.setupInitialServer, 1);
  assert.equal(invalidField.afterVm.editState.phase, 'PROMPT');

  // 6. Legacy active match resume with explicit ONE_TAP_UE vs missing field
  const legacyOneTap = await checkCase(
    'legacy-1tap',
    JSON.stringify({ scoringMode: 'GP', initialServer: 1, wristCenterMode: 'ONE_TAP_UE' }),
    { seedActive: true }
  );
  assert.equal(legacyOneTap.afterVm.wristCenterMode, 'ONE_TAP_UE');
  assert.deepEqual(legacyOneTap.afterVm.record.events.map((e) => e.code), ['A', 'E']);

  const legacyMissing = await checkCase(
    'legacy-missing',
    JSON.stringify({ scoringMode: 'GP', initialServer: 1 }),
    { seedActive: true }
  );
  assert.equal(legacyMissing.afterVm.wristCenterMode, 'EDIT_MODE');
  assert.equal(legacyMissing.afterVm.editState.phase, 'PROMPT');
  assert.deepEqual(legacyMissing.afterVm.record.events.map((e) => e.code), ['A']);
});
