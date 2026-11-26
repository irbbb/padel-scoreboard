import {
  addPoint,
  correctInitialServer,
  finishManual,
  resumeMatch,
  undoLastPoint,
} from '../core/scoreEngine.js';
import { formatWristDisplay } from '../core/wristDisplay.js';
import { createMatchStore, MATCH_STORAGE_KEY } from '../core/matchStore.js';
import { createDiagnosticLog } from '../core/diagnosticLog.js';
import { loadMatchDefaults, saveMatchDefaults } from './defaultsStore.js';
import { createWristBridge } from './wristBridge.js';

function toErrorMessage(err) {
  if (err && typeof err.message === 'string' && err.message.length > 0) {
    return err.message;
  }
  return String(err);
}

export function formatDuration(totalSec) {
  const safe = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (hrs > 0) {
    return `${hrs}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

export function formatUePercent(ratio) {
  if (ratio === null || ratio === undefined) return '—';
  if (ratio === 0) return '0%';
  const rounded = Math.round(ratio * 100);
  if (ratio > 0 && rounded === 0) return '<1%';
  return `${rounded}%`;
}

export function formatSetLine(setEntry) {
  const base = `${setEntry.games[0]}-${setEntry.games[1]}`;
  if (Array.isArray(setEntry.tieBreakPoints)) {
    return `${base} (${setEntry.tieBreakPoints[0]}-${setEntry.tieBreakPoints[1]})`;
  }
  return base;
}

export function formatDiagTime(timestampMs) {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) {
    return '--:--:--';
  }
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }
  return date.toISOString().slice(11, 19);
}

/**
 * Wraps lazy browser storage access (e.g. `() => window.localStorage`) so a throwing
 * getter (such as SecurityError when cookies/storage are blocked) is deferred into
 * guarded storage methods instead of crashing app boot.
 */
export function createGuardedStorage(getStorage) {
  function resolve() {
    const target = typeof getStorage === 'function' ? getStorage() : null;
    if (
      !target ||
      typeof target.getItem !== 'function' ||
      typeof target.setItem !== 'function' ||
      typeof target.removeItem !== 'function'
    ) {
      throw new Error('Browser storage is unavailable');
    }
    return target;
  }

  return {
    getItem(key) {
      return resolve().getItem(key);
    },
    setItem(key, value) {
      return resolve().setItem(key, value);
    },
    removeItem(key) {
      return resolve().removeItem(key);
    },
  };
}

function defaultCreateMatchId(nowMs) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `m-${nowMs}-${rand}`;
}

/**
 * Pure-JS application controller uniting S1.1–S1.4 core modules with the S2.2 MediaSession
 * wrist bridge and S2.1 mobile UI view-model. Zero DOM dependencies.
 */
export function createAppController({
  storage,
  locks = null,
  createAudio = null,
  mediaSession = null,
  createMetadata = undefined,
  createMatchId = defaultCreateMatchId,
  now = () => Date.now(),
  onUpdate = null,
  onDurationTick = null,
} = {}) {
  const diagLog = createDiagnosticLog({ storage, now });
  const initialDefaults = loadMatchDefaults(storage);

  let setupScoringMode = initialDefaults.scoringMode;
  let setupInitialServer = initialDefaults.initialServer;
  let replacementDraft = null; // { baseMatchId, baseRevision, scoringMode, initialServer } | null
  let menuOpen = false;
  let confirmFinishOpen = false;
  let confirmClearCorruptOpen = false;
  let confirmOpenerOpen = false;
  let actionError = null;
  let takeoverNotice = null;
  let initialized = false;
  let tornDown = false;
  let lifecycleGen = 0;
  let pendingRelease = null;

  let wristBridge = null;
  let store = null;

  function emitUpdate() {
    if (typeof onUpdate !== 'function') return;
    try {
      onUpdate(getViewModel());
    } catch {
      // Isolate view render exceptions
    }
  }

  function emitDurationTick(durationText) {
    if (typeof onDurationTick !== 'function') return;
    try {
      onDurationTick(durationText);
    } catch {
      // Isolate view tick exceptions
    }
  }

  function reconcileDraft(snapshot) {
    if (!replacementDraft) return;
    const valid =
      snapshot.role === 'WRITER' &&
      snapshot.storageStatus === 'READY' &&
      snapshot.record !== null &&
      snapshot.record.status !== 'ACTIVE' &&
      snapshot.record.matchId === replacementDraft.baseMatchId &&
      snapshot.record.revision === replacementDraft.baseRevision;
    if (!valid) {
      replacementDraft = null;
    }
  }

  store = createMatchStore({
    storage,
    locks,
    now,
    capturePublishContext: () => (wristBridge ? wristBridge.capturePublishContext() : null),
    publishWrist: (state, record, originToken) => {
      if (!wristBridge) return { skipped: true };
      return wristBridge.publishSnapshot(state, record, originToken);
    },
    onStateChange: (snapshot) => {
      reconcileDraft(snapshot);
      if (snapshot.role !== 'WRITER') {
        menuOpen = false;
        confirmFinishOpen = false;
        confirmClearCorruptOpen = false;
        confirmOpenerOpen = false;
      } else {
        takeoverNotice = null;
      }
      if (snapshot.storageStatus !== 'CORRUPT') {
        confirmClearCorruptOpen = false;
      }
      if (snapshot.record?.status !== 'ACTIVE') {
        confirmFinishOpen = false;
        confirmOpenerOpen = false;
      }
      if (wristBridge) {
        wristBridge.syncStoreSnapshot(snapshot);
      }
      emitUpdate();
    },
  });

  wristBridge = createWristBridge({
    createAudio,
    mediaSession,
    createMetadata,
    diagLog,
    now,
    getStoreSnapshot: () => store.getSnapshot(now()),
    onCommand: (code, action) => {
      actionError = null;
      const nowMs = now();
      const beforeSnap = store.getSnapshot(nowMs);
      const beforeRev = beforeSnap.record?.revision ?? null;

      let ignoredAwaitingServer = false;
      let actionDetail = `code=${code}`;

      const promise = store.commit((rec) => {
        if (rec.status === 'ACTIVE' && rec.config.initialServer === null) {
          if (code === 'A') {
            actionDetail = 'pick_server=US';
            return correctInitialServer(rec, 0);
          }
          if (code === 'B') {
            actionDetail = 'pick_server=THEM';
            return correctInitialServer(rec, 1);
          }
          ignoredAwaitingServer = true;
          return rec;
        }
        return addPoint(rec, code, nowMs);
      }, nowMs);

      const afterSnap = store.getSnapshot(nowMs);
      const afterRev = afterSnap.record?.revision ?? null;

      if (ignoredAwaitingServer) {
        return {
          outcome: 'ignored_awaiting_server',
          revision: afterRev,
          detail: `action=${action}`,
          promise,
        };
      }
      if (afterSnap.lastSaveError !== null) {
        return {
          outcome: 'save_failed',
          revision: afterRev,
          detail: afterSnap.lastSaveError,
          promise,
        };
      }
      if (afterRev !== beforeRev) {
        return {
          outcome: 'saved',
          revision: afterRev,
          detail: actionDetail,
          promise,
        };
      }
      return {
        outcome: 'noop',
        revision: afterRev,
        detail: actionDetail,
        promise,
      };
    },
    onStatusChange: () => {
      emitUpdate();
    },
  });

  function determineScreen(snapshot) {
    if (snapshot.storageStatus === 'UNREAD') return 'LOADING';
    if (snapshot.storageStatus === 'READ_ERROR') return 'READ_ERROR';
    if (snapshot.storageStatus === 'CORRUPT') return 'CORRUPT';
    if (snapshot.storageStatus === 'EMPTY') return 'SETUP';

    // storageStatus === 'READY'
    if (snapshot.record && snapshot.record.status === 'ACTIVE') {
      return 'LIVE';
    }
    if (
      replacementDraft !== null &&
      snapshot.role === 'WRITER' &&
      snapshot.record &&
      snapshot.record.matchId === replacementDraft.baseMatchId &&
      snapshot.record.revision === replacementDraft.baseRevision
    ) {
      return 'SETUP';
    }
    return 'MATCH_OVER';
  }

  function getViewModel(nowMs = now()) {
    const snapshot = store.getSnapshot(nowMs);
    const wrist = wristBridge.getStatus();
    const screen = determineScreen(snapshot);
    const isWriter = snapshot.role === 'WRITER';
    const state = snapshot.state;
    const record = snapshot.record;

    let wristPreview = null;
    if (state) {
      try {
        wristPreview = formatWristDisplay(state);
      } catch {
        wristPreview = null;
      }
    }

    const activeScoringMode = replacementDraft ? replacementDraft.scoringMode : setupScoringMode;
    const activeInitialServer = replacementDraft ? replacementDraft.initialServer : setupInitialServer;

    let readOnlyReason = null;
    if (!isWriter && screen !== 'LOADING') {
      if (snapshot.lockStatus === 'BUSY') {
        readOnlyReason = 'Another tab or installed PWA holds the active match.';
      } else if (snapshot.lockStatus === 'UNAVAILABLE') {
        readOnlyReason = 'Web Locks unavailable — open over HTTPS or localhost to edit.';
      } else if (snapshot.lockStatus === 'ERROR') {
        readOnlyReason = 'Writer lock error — tap Take Over Writer to retry.';
      } else {
        readOnlyReason = 'Read-only mode — wrist controls are disarmed.';
      }
    }

    const diagRead = diagLog.readAll();

    return Object.freeze({
      screen,
      isWriter,
      isReplacementSetup: screen === 'SETUP' && replacementDraft !== null,
      role: snapshot.role,
      lockStatus: snapshot.lockStatus,
      storageStatus: snapshot.storageStatus,
      readOnlyReason,
      takeoverNotice,
      record,
      state,
      wristPreview,
      wrist,
      setupScoringMode: activeScoringMode,
      setupInitialServer: activeInitialServer,
      durationText: state ? formatDuration(state.durationSec) : '00:00',
      uePctText: state ? formatUePercent(state.myUePctOfPointsLost) : '—',
      setLines: state ? state.setHistory.map(formatSetLine) : [],
      canUndo: Boolean(isWriter && record && record.events.length > 0 && record.status !== 'FINISHED_MANUAL'),
      canResume: Boolean(isWriter && record && record.status === 'FINISHED_MANUAL'),
      corruptRaw: snapshot.corruptRaw,
      corruptError: snapshot.corruptError,
      storageReadError: snapshot.storageReadError,
      lastSaveError: snapshot.lastSaveError,
      lastPublishError: snapshot.lastPublishError,
      actionError,
      ui: Object.freeze({
        menuOpen,
        confirmFinishOpen,
        confirmClearCorruptOpen,
        confirmOpenerOpen,
      }),
      diagEntries: diagRead.entries.slice(-30).reverse(),
    });
  }

  async function tryAcquireWriterSafely() {
    try {
      const acquired = await store.tryAcquireWriter();
      return { acquired, error: null };
    } catch (err) {
      // Move storageStatus out of UNREAD so UI renders saved/recovery view + retry banner
      store.refreshReadOnly();
      return { acquired: false, error: err };
    }
  }

  async function init() {
    tornDown = false;
    initialized = true;
    emitUpdate();
    const { acquired, error } = await tryAcquireWriterSafely();
    if (error) {
      takeoverNotice = `Writer lock error: ${toErrorMessage(error)}`;
    }
    emitUpdate();
    return acquired;
  }

  function setSetupScoringMode(mode) {
    const normalized = mode === 'GP' ? 'GP' : 'AD';
    if (replacementDraft) {
      replacementDraft = { ...replacementDraft, scoringMode: normalized };
    } else {
      setupScoringMode = normalized;
    }
    emitUpdate();
  }

  function setSetupInitialServer(team) {
    const normalized = team === 0 ? 0 : team === 1 ? 1 : null;
    if (replacementDraft) {
      replacementDraft = { ...replacementDraft, initialServer: normalized };
    } else {
      setupInitialServer = normalized;
    }
    emitUpdate();
  }

  /**
   * Starts a new match from SETUP (empty storage or validated replacement draft).
   * Calls store.startNewMatch() synchronously; if persistence succeeds and linkWrist is true,
   * calls wristBridge.linkFromUserGesture() synchronously in the same user gesture!
   */
  function startMatch({ linkWrist = true } = {}) {
    actionError = null;
    const nowMs = now();
    const snap = store.getSnapshot(nowMs);

    if (snap.role !== 'WRITER') {
      actionError = 'Read-only mode cannot start a match.';
      emitUpdate();
      return Promise.resolve({ ok: false, error: new Error(actionError) });
    }

    if (snap.storageStatus === 'READY') {
      const draftMatches =
        replacementDraft !== null &&
        snap.record !== null &&
        snap.record.status !== 'ACTIVE' &&
        snap.record.matchId === replacementDraft.baseMatchId &&
        snap.record.revision === replacementDraft.baseRevision;
      if (!draftMatches) {
        replacementDraft = null;
        actionError = 'Match state changed; confirm New Match again before replacing.';
        emitUpdate();
        return Promise.resolve({ ok: false, error: new Error(actionError) });
      }
    } else if (snap.storageStatus !== 'EMPTY') {
      actionError = 'Resolve storage issue before starting a new match.';
      emitUpdate();
      return Promise.resolve({ ok: false, error: new Error(actionError) });
    }

    const chosenScoringMode = replacementDraft ? replacementDraft.scoringMode : setupScoringMode;
    const chosenServer = replacementDraft ? replacementDraft.initialServer : setupInitialServer;
    setupScoringMode = chosenScoringMode;
    setupInitialServer = chosenServer;
    saveMatchDefaults(storage, { scoringMode: chosenScoringMode, initialServer: chosenServer });

    const matchId = createMatchId(nowMs);
    const commitPromise = store.startNewMatch({
      matchId,
      config: { scoringMode: chosenScoringMode, initialServer: chosenServer },
      nowMs,
    });

    // Synchronously verify persistence before calling audio.play() inside this user gesture
    const afterSnap = store.getSnapshot(nowMs);
    const persisted =
      afterSnap.storageStatus === 'READY' &&
      afterSnap.record !== null &&
      afterSnap.record.matchId === matchId &&
      afterSnap.record.status === 'ACTIVE';

    if (!persisted) {
      // Failed save preserves both the finished match (if any) and replacementDraft!
      emitUpdate();
      return commitPromise;
    }

    replacementDraft = null;
    menuOpen = false;
    confirmFinishOpen = false;
    confirmOpenerOpen = false;
    emitUpdate();

    if (linkWrist && wristBridge.getStatus().supported) {
      const linkPromise = wristBridge.linkFromUserGesture(() => store.republishWrist(now()));
      return Promise.all([commitPromise, linkPromise]).then(([commitRes, linkRes]) => ({
        ...commitRes,
        linkResult: linkRes,
      }));
    }

    return commitPromise;
  }

  function runGuardedCommit(transformFn) {
    actionError = null;
    const nowMs = now();
    try {
      return store.commit(transformFn, nowMs);
    } catch (err) {
      actionError = toErrorMessage(err);
      emitUpdate();
      return Promise.resolve({ ok: false, error: err });
    }
  }

  function scorePoint(code) {
    const nowMs = now();
    return runGuardedCommit((rec) => addPoint(rec, code, nowMs));
  }

  function undo() {
    return runGuardedCommit((rec) => undoLastPoint(rec));
  }

  function selectInitialServer(team) {
    if (team !== 0 && team !== 1) {
      return Promise.resolve({ ok: false, error: new Error('Invalid team index') });
    }
    // Harmless no-op if the opener was already chosen (e.g. from the watch moments earlier)
    return runGuardedCommit((rec) => {
      if (rec.status !== 'ACTIVE' || rec.config.initialServer !== null) {
        return rec;
      }
      return correctInitialServer(rec, team);
    });
  }

  function correctFirstServer(newInitialServer) {
    const target = newInitialServer === 1 ? 1 : 0;
    confirmOpenerOpen = false;
    menuOpen = false;
    const res = runGuardedCommit((rec) => correctInitialServer(rec, target));
    emitUpdate();
    return res;
  }

  function finishNow() {
    const nowMs = now();
    confirmFinishOpen = false;
    menuOpen = false;
    const res = runGuardedCommit((rec) => finishManual(rec, nowMs));
    emitUpdate();
    return res;
  }

  function resume() {
    return runGuardedCommit((rec) => resumeMatch(rec));
  }

  function openReplacementSetup() {
    actionError = null;
    const snap = store.getSnapshot(now());
    if (snap.role !== 'WRITER' || snap.storageStatus !== 'READY' || !snap.record || snap.record.status === 'ACTIVE') {
      return false;
    }
    replacementDraft = {
      baseMatchId: snap.record.matchId,
      baseRevision: snap.record.revision,
      scoringMode: setupScoringMode,
      initialServer: setupInitialServer,
    };
    emitUpdate();
    return true;
  }

  function cancelReplacementSetup() {
    replacementDraft = null;
    actionError = null;
    emitUpdate();
  }

  function relinkWrist() {
    actionError = null;
    return wristBridge.linkFromUserGesture(() => store.republishWrist(now()));
  }

  async function takeOverWriter() {
    actionError = null;
    takeoverNotice = null;
    const { acquired, error } = await tryAcquireWriterSafely();
    if (!acquired) {
      const snap = store.getSnapshot(now());
      if (error) {
        takeoverNotice = `Writer lock error: ${toErrorMessage(error)}`;
      } else if (snap.lockStatus === 'BUSY') {
        takeoverNotice = 'Still held by another open tab or PWA window.';
      } else if (snap.lockStatus === 'UNAVAILABLE') {
        takeoverNotice = 'Web Locks API is unavailable in this context.';
      } else {
        takeoverNotice = 'Could not acquire writer lock.';
      }
      emitUpdate();
    }
    return acquired;
  }

  async function stepDownToReadOnly() {
    menuOpen = false;
    confirmFinishOpen = false;
    confirmOpenerOpen = false;
    wristBridge.disarm('step_down_read_only');
    await store.releaseWriter();
    emitUpdate();
  }

  function retryRead() {
    actionError = null;
    try {
      const snap = store.retryRead();
      emitUpdate();
      return { ok: true, snapshot: snap };
    } catch (err) {
      actionError = toErrorMessage(err);
      emitUpdate();
      return { ok: false, error: err };
    }
  }

  function clearCorruptRecord() {
    actionError = null;
    try {
      const res = store.clearCorruptRecord();
      confirmClearCorruptOpen = false;
      if (!res.ok) {
        actionError = toErrorMessage(res.error);
      }
      emitUpdate();
      return res;
    } catch (err) {
      actionError = toErrorMessage(err);
      emitUpdate();
      return { ok: false, error: err };
    }
  }

  function setMenuOpen(open) {
    menuOpen = Boolean(open);
    if (!menuOpen) {
      confirmFinishOpen = false;
      confirmOpenerOpen = false;
    }
    emitUpdate();
  }

  function setConfirmFinishOpen(open) {
    confirmFinishOpen = Boolean(open);
    emitUpdate();
  }

  function setConfirmOpenerOpen(open) {
    confirmOpenerOpen = Boolean(open);
    emitUpdate();
  }

  function setConfirmClearCorruptOpen(open) {
    confirmClearCorruptOpen = Boolean(open);
    emitUpdate();
  }

  function clearDiagnosticLog() {
    diagLog.clear();
    emitUpdate();
  }

  function handleStorageEvent(key) {
    if (key !== null && key !== MATCH_STORAGE_KEY) {
      return;
    }
    if (store.getSnapshot(now()).role !== 'WRITER') {
      store.refreshReadOnly();
    }
  }

  function handleVisibilityChange(visibilityState) {
    wristBridge.handleVisibilityChange(visibilityState);
    if (visibilityState === 'visible') {
      // Immediately refresh displayed durationSec in place without mutating or replacing DOM controls
      tickDisplay();
    }
  }

  function handlePageHideOrFreeze(reason = 'pagehide') {
    lifecycleGen += 1;
    if (tornDown) {
      return pendingRelease ?? Promise.resolve();
    }
    tornDown = true;
    wristBridge.destroy();
    const rel = Promise.resolve(store.releaseWriter()).finally(() => {
      if (pendingRelease === rel) {
        pendingRelease = null;
      }
    });
    pendingRelease = rel;
    return rel;
  }

  async function handlePageShowOrResume() {
    if (!initialized) return false;
    const myGen = ++lifecycleGen;
    tornDown = false;
    // Always start disarmed on BFCache restore / resume; wait for any in-flight release first
    wristBridge.disarm('page_restore');

    if (pendingRelease) {
      try {
        await pendingRelease;
      } catch {
        // Ignore release errors before rechecking lock
      }
    }

    // Abort if another hide/freeze or newer restore superseded this restore while waiting
    if (myGen !== lifecycleGen || tornDown) {
      return false;
    }

    const { acquired, error } = await tryAcquireWriterSafely();

    if (myGen !== lifecycleGen || tornDown) {
      if (acquired) {
        await store.releaseWriter();
      }
      return false;
    }

    if (error) {
      takeoverNotice = `Writer lock error: ${toErrorMessage(error)}`;
    } else if (!acquired) {
      store.refreshReadOnly();
    }
    emitUpdate();
    return acquired;
  }

  function tickDisplay() {
    // Lightweight UI refresh for live durationSec; zero commits, zero revision bumps, zero wrist publishes
    const snap = store.getSnapshot(now());
    if (snap.record && snap.record.status === 'ACTIVE' && snap.state) {
      const text = formatDuration(snap.state.durationSec);
      emitDurationTick(text);
      return text;
    }
    return null;
  }

  return {
    init,
    getViewModel,
    setSetupScoringMode,
    setSetupInitialServer,
    startMatch,
    scorePoint,
    undo,
    selectInitialServer,
    correctFirstServer,
    finishNow,
    resume,
    openReplacementSetup,
    cancelReplacementSetup,
    relinkWrist,
    takeOverWriter,
    stepDownToReadOnly,
    retryRead,
    clearCorruptRecord,
    setMenuOpen,
    setConfirmFinishOpen,
    setConfirmOpenerOpen,
    setConfirmClearCorruptOpen,
    clearDiagnosticLog,
    handleStorageEvent,
    handleVisibilityChange,
    handlePageHideOrFreeze,
    handlePageShowOrResume,
    tickDisplay,
    // Exposed for targeted diagnostics/tests
    _store: store,
    _wristBridge: wristBridge,
    _diagLog: diagLog,
  };
}
