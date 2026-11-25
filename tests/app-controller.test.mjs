import test from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_STORAGE_KEY } from '../src/core/matchStore.js';
import { createAppController, formatDuration, formatSetLine, formatUePercent } from '../src/app/appController.js';
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
