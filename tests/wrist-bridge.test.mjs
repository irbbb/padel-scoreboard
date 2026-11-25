import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatchStore } from '../src/core/matchStore.js';
import { addPoint, finishManual, resumeMatch, undoLastPoint } from '../src/core/scoreEngine.js';
import { createDiagnosticLog } from '../src/core/diagnosticLog.js';
import { createWristBridge } from '../src/app/wristBridge.js';

function createMemoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

function createMockLocks() {
  let held = false;
  return {
    request(name, opts, cb) {
      if (held && opts?.ifAvailable) return Promise.resolve(cb(null));
      held = true;
      return Promise.resolve(cb({ name })).finally(() => {
        held = false;
      });
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAudioFactory({ queuePauseEvents = false } = {}) {
  const created = [];
  let nextPlayDeferred = null;
  let nextPlayError = null;

  function createAudio() {
    const id = created.length + 1;
    const listeners = new Map();
    const audio = {
      id,
      paused: true,
      ended: false,
      error: null,
      loop: false,
      volume: 1,
      duration: 10,
      currentTime: 0,
      playCalls: 0,
      pauseCalls: 0,
      listenerCount() {
        let total = 0;
        for (const set of listeners.values()) total += set.size;
        return total;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      emit(type) {
        for (const fn of [...(listeners.get(type) || [])]) {
          fn({ type });
        }
      },
      play() {
        audio.playCalls += 1;
        if (nextPlayError) {
          const err = nextPlayError;
          nextPlayError = null;
          return Promise.reject(err);
        }
        if (nextPlayDeferred) {
          const def = nextPlayDeferred;
          nextPlayDeferred = null;
          return def.promise.then(() => {
            audio.paused = false;
            audio.ended = false;
            audio.emit('play');
            audio.emit('playing');
          });
        }
        audio.paused = false;
        audio.ended = false;
        audio.emit('play');
        audio.emit('playing');
        return Promise.resolve();
      },
      pause() {
        audio.pauseCalls += 1;
        const wasPlaying = !audio.paused;
        audio.paused = true;
        if (wasPlaying) {
          if (queuePauseEvents) {
            queueMicrotask(() => audio.emit('pause'));
          } else {
            audio.emit('pause');
          }
        }
      },
      simulateOsPause() {
        audio.paused = true;
        audio.emit('pause');
      },
    };
    created.push(audio);
    return audio;
  }

  return {
    createAudio,
    created,
    deferNextPlay() {
      nextPlayDeferred = createDeferred();
      return nextPlayDeferred;
    },
    rejectNextPlay(err) {
      nextPlayError = err;
    },
  };
}

function createFakeMediaSession({ failOnHandlerCount = null } = {}) {
  const handlers = new Map();
  const metadataLog = [];
  let setHandlerCalls = 0;
  let metadataThrow = null;
  let _metadata = null;

  const ms = {
    playbackState: 'none',
    positionState: null,
    get handlers() {
      return handlers;
    },
    get metadataLog() {
      return metadataLog;
    },
    setMetadataThrow(err) {
      metadataThrow = err;
    },
    setActionHandler(action, fn) {
      if (fn !== null) {
        setHandlerCalls += 1;
        if (failOnHandlerCount !== null && setHandlerCalls === failOnHandlerCount) {
          throw new Error(`Handler registration failed at #${setHandlerCalls} (${action})`);
        }
        handlers.set(action, fn);
      } else {
        handlers.delete(action);
      }
    },
    setPositionState(pos) {
      ms.positionState = pos;
    },
    trigger(action) {
      const fn = handlers.get(action);
      if (fn) fn();
    },
  };

  Object.defineProperty(ms, 'metadata', {
    get() {
      return _metadata;
    },
    set(val) {
      if (metadataThrow) {
        const err = metadataThrow;
        metadataThrow = null;
        throw err;
      }
      _metadata = val;
      if (val) {
        metadataLog.push({
          title: val.title,
          artist: val.artist,
          playbackState: ms.playbackState,
        });
      }
    },
  });

  return ms;
}

function buildRig({
  queuePauseEvents = false,
  failOnHandlerCount = null,
  holdPublish = null,
} = {}) {
  const storage = createMemoryStorage();
  const locks = createMockLocks();
  const audioFactory = createAudioFactory({ queuePauseEvents });
  const mediaSession = createFakeMediaSession({ failOnHandlerCount });
  const diagLog = createDiagnosticLog({ storage, now: () => 5000 });
  let clock = 1000;
  let bridge;

  const store = createMatchStore({
    storage,
    locks,
    now: () => clock,
    publishWrist: async (state, record) => {
      if (typeof holdPublish === 'function') {
        await holdPublish(state, record);
      }
      return bridge.publishSnapshot(state, record);
    },
    onStateChange: (snap) => {
      if (bridge) bridge.syncStoreSnapshot(snap);
    },
  });

  bridge = createWristBridge({
    createAudio: audioFactory.createAudio,
    mediaSession,
    diagLog,
    now: () => clock,
    getStoreSnapshot: () => store.getSnapshot(clock),
    onCommand: (code) => {
      clock += 1000;
      return store.commit((r) => addPoint(r, code, clock), clock);
    },
  });

  return {
    storage,
    locks,
    audioFactory,
    mediaSession,
    diagLog,
    store,
    bridge,
    nextTime: () => {
      clock += 1000;
      return clock;
    },
  };
}

function scoreToMatchPoint(store, nextTime) {
  // 2 sets of 6-0 = 48 points; score 47 points to reach 1 point before match win
  let p = Promise.resolve();
  for (let i = 0; i < 47; i += 1) {
    const t = nextTime();
    p = store.commit((r) => addPoint(r, 'A', t), t);
  }
  return p;
}

test('Gate 1: holding publish queue across ACTIVE -> WON never lets earlier ACTIVE consume pendingFinal or pause audio', async () => {
  const gate = createDeferred();
  let holdEnabled = false;
  const rig = buildRig({
    holdPublish: async () => {
      if (holdEnabled) {
        await gate.promise;
      }
    },
  });

  await rig.store.tryAcquireWriter();
  await rig.store.startNewMatch({ matchId: 'm-gate1', config: { initialServer: 0 }, nowMs: 1000 });
  await scoreToMatchPoint(rig.store, rig.nextTime); // 47 points, rev 48 (40-0 5-0 Set 2)

  // Undo 1 point so we have two points left: #50 ACTIVE then #51 WON
  await rig.store.commit((r) => undoLastPoint(r), rig.nextTime());
  await rig.bridge.linkFromUserGesture(() => rig.store.republishWrist(rig.nextTime()));
  assert.equal(rig.bridge.getStatus().status, 'ARMED');
  const activeAudio = rig.audioFactory.created.at(-1);
  const countBefore = rig.mediaSession.metadataLog.length;

  // Hold the FIFO queue while ACTIVE (#50) and WON (#51) both commit
  holdEnabled = true;
  const pActive = rig.store.commit((r) => addPoint(r, 'A', rig.nextTime()), rig.nextTime());
  const pWon = rig.store.commit((r) => addPoint(r, 'A', rig.nextTime()), rig.nextTime());

  // Synchronously after WON commits: handlers are cleared immediately, audio not paused yet
  assert.equal(rig.bridge.getStatus().status, 'DISARMED');
  assert.equal(rig.mediaSession.handlers.size, 0);
  assert.equal(activeAudio.paused, false);
  assert.equal(rig.bridge.getStatus().hasPendingFinal, true);

  // Drain the queue
  holdEnabled = false;
  gate.resolve();
  const [resActive, resWon] = await Promise.all([pActive, pWon]);

  assert.equal(resActive.wristPublished, false); // Earlier ACTIVE was skipped safely
  assert.equal(resWon.wristPublished, true); // Exact terminal WON consumed pendingFinal
  assert.equal(activeAudio.paused, true);
  assert.equal(rig.bridge.getStatus().hasPendingFinal, false);

  const newMeta = rig.mediaSession.metadataLog.slice(countBefore);
  assert.equal(newMeta.length, 1);
  assert.ok(newMeta[0].title.startsWith('WIN 2-0'));
  await rig.store.releaseWriter();
});

test('Gate 2: throwing during final metadata assignment preserves lastPublishError AND stops owned audio in finally', async () => {
  const rig = buildRig();
  await rig.store.tryAcquireWriter();
  await rig.store.startNewMatch({ matchId: 'm-gate2', config: { initialServer: 0 }, nowMs: 1000 });
  await rig.bridge.linkFromUserGesture(() => rig.store.republishWrist(rig.nextTime()));
  const ownedAudio = rig.audioFactory.created.at(-1);
  assert.equal(ownedAudio.paused, false);

  rig.mediaSession.setMetadataThrow(new Error('Metadata assignment boom'));
  const finishRes = await rig.store.commit((r) => finishManual(r, rig.nextTime()), rig.nextTime());

  assert.equal(finishRes.ok, true);
  assert.equal(finishRes.wristPublished, false);
  assert.equal(rig.store.getSnapshot().lastPublishError, 'Metadata assignment boom');
  assert.equal(ownedAudio.paused, true);
  assert.equal(rig.mediaSession.playbackState, 'paused');
  assert.equal(rig.mediaSession.handlers.size, 0);
  await rig.store.releaseWriter();
});

test('Gate 3: stale play() resolving after releaseWriter() or after a newer link succeeds is completely harmless', async () => {
  const rig = buildRig();
  await rig.store.tryAcquireWriter();
  await rig.store.startNewMatch({ matchId: 'm-gate3', config: { initialServer: 0 }, nowMs: 1000 });

  // Part A: resolve old play() after releaseWriter()
  const def1 = rig.audioFactory.deferNextPlay();
  const link1 = rig.bridge.linkFromUserGesture(() => rig.store.republishWrist(rig.nextTime()));
  const audio1 = rig.audioFactory.created[0];
  await rig.store.releaseWriter();

  def1.resolve();
  const res1 = await link1;
  assert.equal(res1.ok, false);
  assert.equal(res1.stale, true);
  assert.equal(audio1.paused, true);
  assert.equal(rig.bridge.getStatus().status, 'DISARMED');
  assert.equal(rig.mediaSession.handlers.size, 0);

  // Part B: resolve old play() after a newer linkFromUserGesture() succeeds
  await rig.store.tryAcquireWriter();
  const def2 = rig.audioFactory.deferNextPlay();
  const link2 = rig.bridge.linkFromUserGesture(() => rig.store.republishWrist(rig.nextTime()));
  const audio2 = rig.audioFactory.created[1];

  // Newer link starts and succeeds immediately
  const res3 = await rig.bridge.linkFromUserGesture(() => rig.store.republishWrist(rig.nextTime()));
  const audio3 = rig.audioFactory.created[2];
  assert.equal(res3.ok, true);
  assert.equal(rig.bridge.getStatus().status, 'ARMED');
  assert.equal(audio3.paused, false);

  // Now older play() resolves late
  def2.resolve();
  const res2 = await link2;
  assert.equal(res2.ok, false);
  assert.equal(res2.stale, true);
  assert.equal(audio2.paused, true);
  // Newer link remains ARMED and playing untouched!
  assert.equal(rig.bridge.getStatus().status, 'ARMED');
  assert.equal(audio3.paused, false);
  assert.equal(rig.mediaSession.handlers.size, 4);
  await rig.store.releaseWriter();
});

test('handler registration failure on 3rd of 4 handlers rolls back installed handlers and stops audio', async () => {
  const rig = buildRig({ failOnHandlerCount: 3 });
  await rig.store.tryAcquireWriter();
  await rig.store.startNewMatch({ matchId: 'm-handler-fail', config: { initialServer: 0 }, nowMs: 1000 });

  const res = await rig.bridge.linkFromUserGesture(() => rig.store.republishWrist(rig.nextTime()));
  const audio = rig.audioFactory.created[0];
  assert.equal(res.ok, false);
  assert.equal(rig.bridge.getStatus().status, 'DISARMED');
  assert.match(rig.bridge.getStatus().lastLinkError, /Handler registration failed/);
  assert.equal(rig.mediaSession.handlers.size, 0);
  assert.equal(audio.paused, true);
  assert.equal(audio.listenerCount(), 0);
  await rig.store.releaseWriter();
});

test('Re-link from ARMED detaches/pauses old element (even with queued HTML pause events) and plays fresh element without bumping revision', async () => {
  const rig = buildRig({ queuePauseEvents: true });
  await rig.store.tryAcquireWriter();
  await rig.store.startNewMatch({ matchId: 'm-relink', config: { initialServer: 0 }, nowMs: 1000 });

  await rig.bridge.linkFromUserGesture(() => rig.store.republishWrist(rig.nextTime()));
  const audio1 = rig.audioFactory.created[0];
  assert.equal(rig.bridge.getStatus().status, 'ARMED');
  assert.equal(rig.store.getSnapshot().record.revision, 1);

  // Re-link while ARMED (simulating Android silently routing band elsewhere while audio.paused is false)
  const relinkRes = await rig.bridge.linkFromUserGesture(() => rig.store.republishWrist(rig.nextTime()));
  await Promise.resolve(); // Flush queued microtask pause event on audio1

  const audio2 = rig.audioFactory.created[1];
  assert.equal(relinkRes.ok, true);
  assert.equal(audio1.paused, true);
  assert.equal(audio1.listenerCount(), 0);
  assert.equal(audio2.paused, false);
  assert.equal(rig.bridge.getStatus().status, 'ARMED');
  assert.equal(rig.store.getSnapshot().record.revision, 1); // Revision preserved!
  assert.equal(rig.mediaSession.metadata.title, '*0-0 0-0 #1');
  await rig.store.releaseWriter();
});

test('phone point scored during pending play() is valid and republished once armed', async () => {
  const rig = buildRig();
  await rig.store.tryAcquireWriter();
  await rig.store.startNewMatch({ matchId: 'm-mid-link', config: { initialServer: 0 }, nowMs: 1000 });

  const def = rig.audioFactory.deferNextPlay();
  const linkPromise = rig.bridge.linkFromUserGesture(() => rig.store.republishWrist(rig.nextTime()));
  assert.equal(rig.bridge.getStatus().status, 'DISARMED'); // Wrist disabled during pending link

  // User taps phone US +1 while play() is still pending
  await rig.store.commit((r) => addPoint(r, 'A', rig.nextTime()), rig.nextTime());
  assert.equal(rig.store.getSnapshot().record.revision, 2);

  def.resolve();
  const res = await linkPromise;
  assert.equal(res.ok, true);
  assert.equal(rig.bridge.getStatus().status, 'ARMED');
  assert.equal(rig.mediaSession.metadata.title, '*15-0 0-0 #2');
  await rig.store.releaseWriter();
});

test('zero phantom points: DOM events never score/arm, OS pause interrupts, center maps to E without pausing, screen lock stays armed', async () => {
  const rig = buildRig();
  await rig.store.tryAcquireWriter();
  await rig.store.startNewMatch({ matchId: 'm-zero', config: { initialServer: 0 }, nowMs: 1000 });
  await rig.bridge.linkFromUserGesture(() => rig.store.republishWrist(rig.nextTime()));
  const audio = rig.audioFactory.created[0];

  // Screen lock keeps bridge ARMED
  rig.bridge.handleVisibilityChange('hidden');
  assert.equal(rig.bridge.getStatus().status, 'ARMED');

  // Ordinary DOM play / playing never score
  audio.emit('play');
  audio.emit('playing');
  assert.equal(rig.store.getSnapshot().record.revision, 1);

  // Rapid independent wrist taps: Prev (A), Next (B), Center pause (E), Center play (E)
  rig.mediaSession.trigger('previoustrack');
  rig.mediaSession.trigger('nexttrack');
  rig.mediaSession.trigger('pause');
  rig.mediaSession.trigger('play');
  assert.equal(rig.store.getSnapshot().record.revision, 5);
  assert.deepEqual(
    rig.store.getSnapshot().record.events.map((e) => e.code),
    ['A', 'B', 'E', 'E']
  );
  assert.equal(audio.paused, false);
  assert.equal(rig.mediaSession.playbackState, 'playing');

  // OS audio interruption (DOM pause) disarms cleanly without scoring
  audio.simulateOsPause();
  assert.equal(rig.bridge.getStatus().status, 'INTERRUPTED');
  assert.equal(rig.mediaSession.handlers.size, 0);
  assert.equal(rig.store.getSnapshot().record.revision, 5);
  await rig.store.releaseWriter();
});

test('Resume cancels lingering pendingFinal and stops its audio without pausing a later link', async () => {
  const gate = createDeferred();
  let hold = false;
  const rig = buildRig({
    holdPublish: async () => {
      if (hold) await gate.promise;
    },
  });
  await rig.store.tryAcquireWriter();
  await rig.store.startNewMatch({ matchId: 'm-resume', config: { initialServer: 0 }, nowMs: 1000 });
  await rig.bridge.linkFromUserGesture(() => rig.store.republishWrist(rig.nextTime()));
  const oldAudio = rig.audioFactory.created[0];

  hold = true;
  const pFinish = rig.store.commit((r) => finishManual(r, rig.nextTime()), rig.nextTime());
  assert.equal(rig.bridge.getStatus().hasPendingFinal, true);

  // Immediately resume before final publish ran -> cancels pendingFinal and stops oldAudio!
  const pResume = rig.store.commit((r) => resumeMatch(r), rig.nextTime());
  assert.equal(rig.bridge.getStatus().hasPendingFinal, false);
  assert.equal(oldAudio.paused, true);

  hold = false;
  gate.resolve();
  await Promise.all([pFinish, pResume]);
  assert.equal(rig.bridge.getStatus().status, 'DISARMED'); // Reopens disarmed!
  await rig.store.releaseWriter();
});
