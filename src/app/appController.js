import {
  addPoint,
  correctInitialServer,
  deriveMatchState,
  finishManual,
  resumeMatch,
  undoLastPoint,
} from '../core/scoreEngine.js';
import { formatWristDisplay } from '../core/wristDisplay.js';
import { createMatchStore, MATCH_STORAGE_KEY } from '../core/matchStore.js';
import { createDiagnosticLog } from '../core/diagnosticLog.js';
import { analyzeMatch, isValidDateMs } from '../core/matchAnalytics.js';
import { buildExportFilename, exportMatchCsv, exportMatchJson } from '../core/matchExport.js';
import {
  createMatchHistoryStore,
  HISTORY_STORAGE_KEY,
  isSameTerminalSnapshot,
  isTerminalMatchRecord,
} from '../core/matchHistory.js';
import {
  createInitialEditState,
  invalidateEditToAwaitingLive,
  normalizeWristCenterMode,
  reconcileEditStateAfterRecordChange,
  reduceEditWristInput,
} from '../core/wristEditMode.js';
import { DEFAULTS_STORAGE_KEY, loadMatchDefaults, saveMatchDefaults } from './defaultsStore.js';
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
  beforePublish = null,
} = {}) {
  const diagLog = createDiagnosticLog({ storage, now });
  const historyStore = createMatchHistoryStore({ storage });
  const initialDefaults = loadMatchDefaults(storage);

  let setupScoringMode = initialDefaults.scoringMode;
  let setupInitialServer = initialDefaults.initialServer;
  let wristCenterMode = initialDefaults.wristCenterMode;
  let wasWriter = false;
  let editState = createInitialEditState();
  let interruptedEditMatchId = null;
  let displayGen = 0;
  let pendingWristEditCommit = null; // { matchId, expectedBaseRev, targetReason } | null

  function setEditStateAndBump(next) {
    const prev = editState;
    editState = next;
    // Only bump displayGen across non-LIVE edit-overlay transitions so ordinary LIVE -> LIVE
    // commits preserve strict FIFO one-snapshot-per-revision delivery while stale edit overlays skip.
    if (prev.phase !== 'LIVE' || next.phase !== 'LIVE' || prev !== next) {
      displayGen += 1;
    }
  }
  let replacementDraft = null; // { baseMatchId, baseRevision, scoringMode, initialServer } | null
  let archiveBlockedDraft = false;
  let menuOpen = false;
  let guideOpen = false;
  let confirmFinishOpen = false;
  let confirmClearCorruptOpen = false;
  let confirmOpenerOpen = false;
  let historyView = null; // null | 'LIST' | 'DETAIL'
  let inspectedMatchId = null;
  let confirmDeleteMatchId = null;
  let historySnapshot = historyStore.readAll();
  let historyError = null;
  let lastReconciledKey = null;
  let lastReconciledMatchId = null;
  let lastReconciledStatus = null;
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

  const historySummaryCache = new WeakMap();

  function getCachedHistorySummary(matchRecord) {
    let cached = historySummaryCache.get(matchRecord);
    if (!cached) {
      const st = deriveMatchState(matchRecord, matchRecord.finishTimeMs ?? matchRecord.startTimeMs);
      const hasPartial =
        st.status === 'FINISHED_MANUAL' &&
        (st.games[0] > 0 || st.games[1] > 0 || st.points[0] > 0 || st.points[1] > 0 || st.inTieBreak);
      cached = Object.freeze({
        matchId: matchRecord.matchId,
        status: matchRecord.status,
        winner: st.winner,
        scoringMode: st.scoringMode,
        timestampMs: matchRecord.finishTimeMs ?? matchRecord.startTimeMs,
        dateText: formatMatchDateText(matchRecord.finishTimeMs ?? matchRecord.startTimeMs),
        setsText: `${st.sets[0]}-${st.sets[1]}`,
        setHistory: Object.freeze(st.setHistory),
        setLines: Object.freeze(st.setHistory.map(formatSetLine)),
        partialGames: hasPartial ? Object.freeze([st.games[0], st.games[1]]) : null,
        durationText: formatDuration(st.durationSec),
        myUePoints: st.counts.myUePoints,
        uePctText: formatUePercent(st.myUePctOfPointsLost),
      });
      historySummaryCache.set(matchRecord, cached);
    }
    return cached;
  }

  function getVisibleHistoryMatches(activeRecord) {
    if (!activeRecord) {
      return historySnapshot.matches;
    }
    // Suppress stale archived copy while that matchId is ACTIVE (including across reload if removal failed),
    // AND suppress any older stale finish when a newer terminal snapshot with the same matchId is open on Match Over.
    if (activeRecord.status === 'ACTIVE') {
      return historySnapshot.matches.filter((m) => m.matchId !== activeRecord.matchId);
    }
    if (isTerminalMatchRecord(activeRecord)) {
      return historySnapshot.matches.filter(
        (m) => m.matchId !== activeRecord.matchId || isSameTerminalSnapshot(m, activeRecord)
      );
    }
    return historySnapshot.matches;
  }

  function refreshHistorySnapshot(activeRecord = store?.getSnapshot(now()).record ?? null) {
    historySnapshot = historyStore.readAll();
    const visible = getVisibleHistoryMatches(activeRecord);
    if (historyView === 'DETAIL' && inspectedMatchId !== null) {
      if (!visible.some((m) => m.matchId === inspectedMatchId)) {
        inspectedMatchId = null;
        confirmDeleteMatchId = null;
        historyView = 'LIST';
      }
    }
    if (confirmDeleteMatchId !== null && !visible.some((m) => m.matchId === confirmDeleteMatchId)) {
      confirmDeleteMatchId = null;
    }
  }

  /**
   * Single authoritative post-commit reconciliation between activeMatch and padelScore.history.v1.
   * Runs under the already-held Web Lock on startup/takeover and after every phone or wrist save.
   */
  function reconcileActiveWithHistory(snapshot) {
    if (snapshot.role !== 'WRITER' || snapshot.storageStatus !== 'READY' || !snapshot.record) {
      return;
    }
    const rec = snapshot.record;
    const key = `${rec.matchId}:${rec.status}:${rec.revision}`;

    if (isTerminalMatchRecord(rec)) {
      if (lastReconciledKey === key && historyError === null) {
        return;
      }
      lastReconciledKey = key;
      lastReconciledMatchId = rec.matchId;
      lastReconciledStatus = rec.status;

      if (historyStore.hasExactSnapshot(rec)) {
        historyError = null;
        archiveBlockedDraft = false;
        refreshHistorySnapshot(rec);
        return;
      }

      const res = historyStore.upsertMatch(rec);
      if (res.ok && res.archivedExact) {
        historyError = null;
        archiveBlockedDraft = false;
      } else {
        historyError = `Match saved on this device. History update failed: ${toErrorMessage(res.error)}`;
      }
      refreshHistorySnapshot(rec);
      return;
    }

    // ACTIVE match: only check history on first sight of matchId or transition from terminal -> ACTIVE (Undo/Resume)
    const needsActiveCheck =
      lastReconciledMatchId !== rec.matchId || lastReconciledStatus !== 'ACTIVE';
    lastReconciledKey = key;
    lastReconciledMatchId = rec.matchId;
    lastReconciledStatus = 'ACTIVE';

    if (!needsActiveCheck) {
      return;
    }

    const rem = historyStore.removeMatch(rec.matchId);
    if (rem.ok) {
      historyError = null;
    } else {
      historyError = `History sync warning (active match unaffected): ${toErrorMessage(rem.error)}`;
    }
    refreshHistorySnapshot(rec);
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
      archiveBlockedDraft = false;
    }
  }

  store = createMatchStore({
    storage,
    locks,
    now,
    capturePublishContext: (_nextState, nextRecord) => {
      let ownReason = null;
      if (
        pendingWristEditCommit !== null &&
        nextRecord &&
        nextRecord.status === 'ACTIVE' &&
        nextRecord.matchId === pendingWristEditCommit.matchId &&
        nextRecord.revision === pendingWristEditCommit.expectedBaseRev + 1
      ) {
        ownReason = pendingWristEditCommit.targetReason;
        pendingWristEditCommit = null;
        interruptedEditMatchId = null;
      }

      const nextEdit = reconcileEditStateAfterRecordChange(editState, nextRecord, {
        ownCommitReason: ownReason,
      });
      setEditStateAndBump(nextEdit);

      if (
        !nextRecord ||
        nextRecord.status !== 'ACTIVE' ||
        (interruptedEditMatchId !== null && interruptedEditMatchId !== nextRecord.matchId)
      ) {
        interruptedEditMatchId = null;
      }

      const myGen = displayGen;
      return Object.freeze({
        token: wristBridge ? wristBridge.capturePublishContext() : null,
        displayGen: myGen,
        editState,
      });
    },
    publishWrist: async (state, record, originContext) => {
      if (typeof beforePublish === 'function') {
        await beforePublish(state, record, originContext);
      }
      if (!wristBridge) return { skipped: true };
      return wristBridge.publishSnapshot(state, record, originContext);
    },
    onStateChange: (snapshot) => {
      reconcileDraft(snapshot);
      if (snapshot.role !== 'WRITER') {
        wasWriter = false;
        menuOpen = false;
        confirmFinishOpen = false;
        confirmClearCorruptOpen = false;
        confirmOpenerOpen = false;
        confirmDeleteMatchId = null;
        lastReconciledKey = null;
        lastReconciledMatchId = null;
        lastReconciledStatus = null;
        setEditStateAndBump(createInitialEditState());
        interruptedEditMatchId = null;
        displayGen += 1;
      } else {
        if (!wasWriter) {
          wasWriter = true;
          wristCenterMode = loadMatchDefaults(storage).wristCenterMode;
        }
        takeoverNotice = null;
      }
      if (snapshot.storageStatus !== 'CORRUPT') {
        confirmClearCorruptOpen = false;
      }
      if (snapshot.record?.status !== 'ACTIVE') {
        confirmFinishOpen = false;
        confirmOpenerOpen = false;
        setEditStateAndBump(createInitialEditState());
        interruptedEditMatchId = null;
      }
      if (wristBridge) {
        wristBridge.syncStoreSnapshot(snapshot);
      }
      if (snapshot.role === 'WRITER' && snapshot.storageStatus === 'READY' && snapshot.record) {
        reconcileActiveWithHistory(snapshot);
      } else {
        refreshHistorySnapshot(snapshot.record);
      }
      emitUpdate();
    },
  });

  function republishIfArmed() {
    const snap = store.getSnapshot(now());
    if (
      snap.role === 'WRITER' &&
      snap.storageStatus === 'READY' &&
      snap.record?.status === 'ACTIVE' &&
      wristBridge &&
      wristBridge.getStatus().status === 'ARMED'
    ) {
      return store.republishWrist(now());
    }
    return Promise.resolve({ ok: true, wristPublished: false });
  }

  wristBridge = createWristBridge({
    createAudio,
    mediaSession,
    createMetadata,
    diagLog,
    now,
    getStoreSnapshot: () => store.getSnapshot(now()),
    isDisplayGenCurrent: (gen) => gen === displayGen,
    onInterrupted: () => {
      const snap = store.getSnapshot(now());
      if (editState.phase !== 'LIVE' && snap.record?.status === 'ACTIVE') {
        interruptedEditMatchId = snap.record.matchId;
        setEditStateAndBump(invalidateEditToAwaitingLive(editState, snap.record));
        emitUpdate();
      }
    },
    onCommand: (_code, action) => {
      actionError = null;
      const nowMs = now();
      const beforeSnap = store.getSnapshot(nowMs);
      const beforeRec = beforeSnap.record;
      const beforeRev = beforeRec?.revision ?? null;

      if (beforeSnap.role !== 'WRITER' || beforeSnap.storageStatus !== 'READY' || !beforeRec) {
        return { outcome: 'noop', revision: beforeRev, detail: 'not_live_writer' };
      }

      const { nextEditState, effect } = reduceEditWristInput(
        editState,
        action,
        beforeRec,
        wristCenterMode
      );

      if (effect.type === 'IGNORE_AWAITING_SERVER') {
        return {
          outcome: 'ignored_awaiting_server',
          revision: beforeRev,
          detail: effect.detail,
        };
      }

      if (effect.type === 'OPEN_PROMPT' || effect.type === 'KEEP_PROMPT_OPEN') {
        setEditStateAndBump(nextEditState);
        const promise = republishIfArmed();
        emitUpdate();
        return { outcome: 'noop', revision: beforeRev, detail: `edit_${effect.type.toLowerCase()}`, promise };
      }

      if (effect.type === 'RETURN_TO_LIVE') {
        setEditStateAndBump(nextEditState);
        interruptedEditMatchId = null;
        const promise = republishIfArmed();
        emitUpdate();
        return { outcome: 'noop', revision: beforeRev, detail: `edit_return_live_${effect.detail}`, promise };
      }

      if (effect.type === 'CONSUME_STALE_ARROW') {
        setEditStateAndBump(nextEditState);
        const promise = republishIfArmed();
        emitUpdate();
        return { outcome: 'noop', revision: beforeRev, detail: `edit_${effect.detail}`, promise };
      }

      if (effect.type === 'CONSUME_ARROW' || effect.type === 'NO_UNDO_AVAILABLE' || effect.type === 'IGNORE') {
        return { outcome: 'noop', revision: beforeRev, detail: `edit_${effect.type.toLowerCase()}` };
      }

      // Mutating wrist command: PICK_SERVER, SCORE, COMMIT_UNDO, or COMMIT_UE
      let actionDetail = effect.type;
      let promise;

      if (effect.type === 'COMMIT_UNDO' || effect.type === 'COMMIT_UE') {
        const targetReason = effect.type === 'COMMIT_UNDO' ? 'UNDO' : 'UE';
        actionDetail = targetReason === 'UNDO' ? 'edit_undo' : 'edit_ue';
        pendingWristEditCommit = {
          matchId: effect.matchId,
          expectedBaseRev: effect.expectedRevision,
          targetReason,
        };
        try {
          promise = store.commit((rec) => {
            if (
              rec.status !== 'ACTIVE' ||
              rec.matchId !== effect.matchId ||
              rec.revision !== effect.expectedRevision
            ) {
              return rec;
            }
            return targetReason === 'UNDO' ? undoLastPoint(rec) : addPoint(rec, 'E', nowMs);
          }, nowMs);
        } finally {
          pendingWristEditCommit = null;
        }
      } else if (effect.type === 'PICK_SERVER') {
        actionDetail = effect.team === 0 ? 'pick_server=US' : 'pick_server=THEM';
        promise = store.commit((rec) => {
          if (rec.status !== 'ACTIVE' || rec.config.initialServer !== null) {
            return rec;
          }
          return correctInitialServer(rec, effect.team);
        }, nowMs);
      } else {
        // effect.type === 'SCORE'
        actionDetail = `code=${effect.code}`;
        promise = store.commit((rec) => addPoint(rec, effect.code, nowMs), nowMs);
      }

      const afterSnap = store.getSnapshot(nowMs);
      const afterRev = afterSnap.record?.revision ?? null;

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

  function formatMatchDateText(timestampMs) {
    if (!isValidDateMs(timestampMs)) return 'Undated';
    const iso = new Date(timestampMs).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  }

  function determineBaseScreen(snapshot) {
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
    const baseScreen = determineBaseScreen(snapshot);
    const isWriter = snapshot.role === 'WRITER';
    const state = snapshot.state;
    const record = snapshot.record;

    const visibleHistory = getVisibleHistoryMatches(record);
    let screen = baseScreen;
    let inspectedRecord = null;
    if (baseScreen !== 'LOADING' && historyView === 'DETAIL' && inspectedMatchId !== null) {
      inspectedRecord = visibleHistory.find((m) => m.matchId === inspectedMatchId) ?? null;
      if (inspectedRecord) {
        screen = 'HISTORY_DETAIL';
      } else {
        screen = 'HISTORY';
      }
    } else if (baseScreen !== 'LOADING' && historyView === 'LIST') {
      screen = 'HISTORY';
    }

    let wristPreview = null;
    if (state) {
      try {
        wristPreview = formatWristDisplay(state, { editState });
      } catch {
        wristPreview = null;
      }
    }

    const activeScoringMode = replacementDraft ? replacementDraft.scoringMode : setupScoringMode;
    const activeInitialServer = replacementDraft ? replacementDraft.initialServer : setupInitialServer;

    let readOnlyReason = null;
    if (!isWriter && baseScreen !== 'LOADING') {
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

    let matchOverAnalytics = null;
    if (screen === 'MATCH_OVER' && record && isTerminalMatchRecord(record)) {
      try {
        matchOverAnalytics = analyzeMatch(record, record.finishTimeMs ?? record.startTimeMs);
      } catch {
        matchOverAnalytics = null;
      }
    }

    let inspectedAnalytics = null;
    if (screen === 'HISTORY_DETAIL' && inspectedRecord) {
      try {
        inspectedAnalytics = analyzeMatch(
          inspectedRecord,
          inspectedRecord.finishTimeMs ?? inspectedRecord.startTimeMs
        );
      } catch {
        inspectedAnalytics = null;
      }
    }

    const activeMatchId = record?.matchId ?? null;
    const historyItems = Object.freeze(
      visibleHistory.map((m) => {
        const base = getCachedHistorySummary(m);
        const isCurrentlyOpenActive = Boolean(activeMatchId && m.matchId === activeMatchId);
        return Object.freeze({
          ...base,
          isCurrentlyOpenActive,
          canDelete: Boolean(isWriter && !isCurrentlyOpenActive),
        });
      })
    );

    const currentTerminalArchived = Boolean(
      record && isTerminalMatchRecord(record) && historyStore.hasExactSnapshot(record)
    );

    const diagRead = diagLog.readAll();

    return Object.freeze({
      screen,
      baseScreen,
      isWriter,
      isReplacementSetup: screen === 'SETUP' && replacementDraft !== null,
      archiveBlockedDraft: Boolean(screen === 'SETUP' && replacementDraft !== null && archiveBlockedDraft),
      currentTerminalArchived,
      role: snapshot.role,
      lockStatus: snapshot.lockStatus,
      storageStatus: snapshot.storageStatus,
      readOnlyReason,
      takeoverNotice,
      record,
      state,
      wristPreview,
      wrist,
      wristCenterMode,
      editState,
      setupScoringMode: activeScoringMode,
      setupInitialServer: activeInitialServer,
      durationText: state ? formatDuration(state.durationSec) : '00:00',
      uePctText: state ? formatUePercent(state.myUePctOfPointsLost) : '—',
      setLines: state ? state.setHistory.map(formatSetLine) : [],
      canUndo: Boolean(isWriter && record && record.events.length > 0 && record.status !== 'FINISHED_MANUAL'),
      canResume: Boolean(isWriter && record && record.status === 'FINISHED_MANUAL'),
      matchOverAnalytics,
      history: Object.freeze({
        status: historySnapshot.status,
        corruptCount: historySnapshot.corruptCount,
        count: historyItems.length,
        items: historyItems,
        error: historyError,
        inspectedRecord,
        inspectedAnalytics,
        inspectedDateText: inspectedRecord
          ? formatMatchDateText(inspectedRecord.finishTimeMs ?? inspectedRecord.startTimeMs)
          : '',
        inspectedTimestampMs: inspectedRecord
          ? (inspectedRecord.finishTimeMs ?? inspectedRecord.startTimeMs)
          : null,
        inspectedCanDelete: Boolean(
          isWriter && inspectedRecord && inspectedRecord.matchId !== activeMatchId
        ),
        inspectedIsOpenActive: Boolean(
          inspectedRecord && activeMatchId && inspectedRecord.matchId === activeMatchId
        ),
        confirmDeleteMatchId,
      }),
      corruptRaw: snapshot.corruptRaw,
      corruptError: snapshot.corruptError,
      storageReadError: snapshot.storageReadError,
      lastSaveError: snapshot.lastSaveError,
      lastPublishError: snapshot.lastPublishError,
      actionError,
      ui: Object.freeze({
        menuOpen,
        guideOpen,
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
   * Before replacing a finished match, verifies that history contains that exact terminal snapshot
   * unless allowDiscardUnarchived is explicitly true.
   * Calls store.startNewMatch() synchronously; if persistence succeeds and linkWrist is true,
   * calls wristBridge.linkFromUserGesture() synchronously in the same user gesture!
   */
  function startMatch({ linkWrist = true, allowDiscardUnarchived = false } = {}) {
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
        archiveBlockedDraft = false;
        actionError = 'Match state changed; confirm New Match again before replacing.';
        emitUpdate();
        return Promise.resolve({ ok: false, error: new Error(actionError) });
      }

      if (!allowDiscardUnarchived && !historyStore.hasExactSnapshot(snap.record)) {
        const arch = historyStore.upsertMatch(snap.record);
        refreshHistorySnapshot(snap.record);
        if (!arch.ok || !arch.archivedExact) {
          archiveBlockedDraft = true;
          historyError = `Match saved on this device. History update failed: ${toErrorMessage(arch.error)}`;
          emitUpdate();
          return Promise.resolve({ ok: false, stage: 'archive', error: arch.error });
        }
        historyError = null;
        archiveBlockedDraft = false;
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
    saveMatchDefaults(storage, {
      scoringMode: chosenScoringMode,
      initialServer: chosenServer,
      wristCenterMode,
    });

    editState = createInitialEditState();
    interruptedEditMatchId = null;

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
    archiveBlockedDraft = false;
    historyError = null;
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
    archiveBlockedDraft = false;
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
    archiveBlockedDraft = false;
    actionError = null;
    emitUpdate();
  }

  function retryArchiveCurrentMatch() {
    actionError = null;
    const snap = store.getSnapshot(now());
    if (snap.role !== 'WRITER') {
      historyError = 'Read-only mode cannot save match history.';
      emitUpdate();
      return { ok: false, error: new Error(historyError) };
    }
    if (snap.storageStatus !== 'READY' || !isTerminalMatchRecord(snap.record)) {
      // Match was reopened or replaced before retry clicked: never archive an ACTIVE match!
      historyError = null;
      archiveBlockedDraft = false;
      emitUpdate();
      return { ok: false, stale: true, error: new Error('No finished active match to archive') };
    }

    const res = historyStore.upsertMatch(snap.record);
    refreshHistorySnapshot(snap.record);
    if (res.ok && res.archivedExact) {
      historyError = null;
      archiveBlockedDraft = false;
    } else {
      historyError = `Match saved on this device. History update failed: ${toErrorMessage(res.error)}`;
    }
    emitUpdate();
    return res;
  }

  function openHistory() {
    actionError = null;
    refreshHistorySnapshot();
    historyView = 'LIST';
    inspectedMatchId = null;
    confirmDeleteMatchId = null;
    emitUpdate();
  }

  function closeHistory() {
    actionError = null;
    historyView = null;
    inspectedMatchId = null;
    confirmDeleteMatchId = null;
    emitUpdate();
  }

  function inspectHistoryMatch(matchId) {
    actionError = null;
    refreshHistorySnapshot();
    const visible = getVisibleHistoryMatches(store.getSnapshot(now()).record);
    if (!visible.some((m) => m.matchId === matchId)) {
      historyView = 'LIST';
      inspectedMatchId = null;
      confirmDeleteMatchId = null;
      emitUpdate();
      return false;
    }
    historyView = 'DETAIL';
    inspectedMatchId = matchId;
    confirmDeleteMatchId = null;
    emitUpdate();
    return true;
  }

  function backToHistoryList() {
    actionError = null;
    refreshHistorySnapshot();
    historyView = 'LIST';
    inspectedMatchId = null;
    confirmDeleteMatchId = null;
    emitUpdate();
  }

  function setConfirmDeleteMatchId(matchId) {
    confirmDeleteMatchId = typeof matchId === 'string' && matchId.length > 0 ? matchId : null;
    emitUpdate();
  }

  function deleteHistoryMatch(matchId) {
    actionError = null;
    const snap = store.getSnapshot(now());
    if (snap.role !== 'WRITER') {
      actionError = 'Read-only mode cannot delete history entries.';
      confirmDeleteMatchId = null;
      emitUpdate();
      return { ok: false, error: new Error(actionError) };
    }
    if (snap.record && snap.record.matchId === matchId) {
      actionError = 'Currently open on Match Over — start a New Match before deleting from history.';
      confirmDeleteMatchId = null;
      emitUpdate();
      return { ok: false, error: new Error(actionError) };
    }

    const res = historyStore.removeMatch(matchId);
    refreshHistorySnapshot(snap.record);
    if (!res.ok) {
      historyError = `Could not delete history entry: ${toErrorMessage(res.error)}`;
      emitUpdate();
      return res;
    }

    confirmDeleteMatchId = null;
    historyError = null;
    if (inspectedMatchId === matchId) {
      inspectedMatchId = null;
      historyView = 'LIST';
    }
    emitUpdate();
    return res;
  }

  /**
   * Generates CSV or JSON export data for an explicit source ('current' active/Match Over snapshot
   * OR 'history' archived snapshot identified by matchId). Separating source from matchId ensures
   * a valid archived matchId such as "active" never collides with the live/current match.
   */
  function getExportData(target = { source: 'current' }, format = 'csv') {
    const snap = store.getSnapshot(now());
    let targetRecord = null;

    if (target && typeof target === 'object') {
      if (target.source === 'current') {
        targetRecord = snap.record;
      } else if (target.source === 'history' && typeof target.matchId === 'string' && target.matchId.length > 0) {
        const visible = getVisibleHistoryMatches(snap.record);
        targetRecord = visible.find((m) => m.matchId === target.matchId) ?? null;
      }
    }

    if (!targetRecord) {
      return { ok: false, error: new Error('Match snapshot not found for export') };
    }

    try {
      const analytics = analyzeMatch(
        targetRecord,
        targetRecord.finishTimeMs ?? targetRecord.startTimeMs
      );
      const isJson = format === 'json';
      const content = isJson
        ? exportMatchJson(targetRecord, analytics)
        : exportMatchCsv(targetRecord, analytics);
      return {
        ok: true,
        filename: buildExportFilename(targetRecord, isJson ? 'json' : 'csv'),
        mimeType: isJson ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8',
        content,
      };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  function setWristCenterMode(mode) {
    const snap = store.getSnapshot(now());
    if (snap.role !== 'WRITER') {
      actionError = 'Read-only mode cannot change wrist center mode.';
      emitUpdate();
      return { ok: false, persisted: false, error: new Error(actionError) };
    }

    const normalized = normalizeWristCenterMode(mode);
    wristCenterMode = normalized;
    const saved = saveMatchDefaults(storage, {
      scoringMode: setupScoringMode,
      initialServer: setupInitialServer,
      wristCenterMode: normalized,
    });
    if (!saved.ok) {
      actionError = `Could not save wrist mode (applies to this session only; reload will revert): ${toErrorMessage(saved.error)}`;
    } else {
      actionError = null;
    }

    if (
      normalized === 'ONE_TAP_UE' &&
      editState.phase !== 'LIVE' &&
      snap.storageStatus === 'READY' &&
      snap.record?.status === 'ACTIVE'
    ) {
      // Keep wrist arrows blocked until Center so a player still seeing EDIT #<rev> cannot score A/B
      setEditStateAndBump(invalidateEditToAwaitingLive(editState, snap.record));
      republishIfArmed();
    }
    emitUpdate();
    return { ok: true, persisted: saved.ok, error: saved.error };
  }

  function cancelWristEdit() {
    actionError = null;
    if (editState.phase === 'LIVE') {
      return Promise.resolve({ ok: true, changed: false });
    }
    const snap = store.getSnapshot(now());
    let pubPromise = Promise.resolve({ ok: true, wristPublished: false });
    if (snap.role === 'WRITER' && snap.storageStatus === 'READY' && snap.record?.status === 'ACTIVE') {
      setEditStateAndBump(invalidateEditToAwaitingLive(editState, snap.record));
      pubPromise = republishIfArmed();
    } else {
      setEditStateAndBump(createInitialEditState());
      interruptedEditMatchId = null;
    }
    emitUpdate();
    return pubPromise;
  }

  function relinkWrist() {
    actionError = null;
    const snap = store.getSnapshot(now());
    const rec = snap.record;
    if (rec?.status === 'ACTIVE') {
      if (interruptedEditMatchId !== null && interruptedEditMatchId === rec.matchId) {
        setEditStateAndBump(
          invalidateEditToAwaitingLive(
            { phase: 'AWAITING_LIVE', matchId: rec.matchId, baseRevision: rec.revision, canUndo: false, reason: 'INVALIDATED' },
            rec
          )
        );
        interruptedEditMatchId = null;
      } else if (editState.phase !== 'LIVE') {
        setEditStateAndBump(
          editState.matchId === rec.matchId
            ? invalidateEditToAwaitingLive(editState, rec)
            : createInitialEditState()
        );
      }
    } else {
      setEditStateAndBump(createInitialEditState());
      interruptedEditMatchId = null;
    }
    emitUpdate();
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
    if (menuOpen) {
      guideOpen = false;
    } else {
      confirmFinishOpen = false;
      confirmOpenerOpen = false;
    }
    emitUpdate();
  }

  function setGuideOpen(open) {
    guideOpen = Boolean(open);
    if (guideOpen) {
      menuOpen = false;
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
    const matchTouched = key === null || key === MATCH_STORAGE_KEY;
    const historyTouched = key === null || key === HISTORY_STORAGE_KEY;
    const defaultsTouched = key === null || key === DEFAULTS_STORAGE_KEY;
    if (!matchTouched && !historyTouched && !defaultsTouched) {
      return;
    }
    const isWriter = store.getSnapshot(now()).role === 'WRITER';
    if (matchTouched && !isWriter) {
      store.refreshReadOnly();
    }
    if (defaultsTouched && !isWriter) {
      wristCenterMode = loadMatchDefaults(storage).wristCenterMode;
    }
    if (historyTouched) {
      refreshHistorySnapshot(store.getSnapshot(now()).record);
    }
    if (historyTouched || (defaultsTouched && !isWriter)) {
      emitUpdate();
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
      wristCenterMode = loadMatchDefaults(storage).wristCenterMode;
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
    setWristCenterMode,
    cancelWristEdit,
    startMatch,
    scorePoint,
    undo,
    selectInitialServer,
    correctFirstServer,
    finishNow,
    resume,
    openReplacementSetup,
    cancelReplacementSetup,
    retryArchiveCurrentMatch,
    openHistory,
    closeHistory,
    inspectHistoryMatch,
    backToHistoryList,
    setConfirmDeleteMatchId,
    deleteHistoryMatch,
    getExportData,
    relinkWrist,
    takeOverWriter,
    stepDownToReadOnly,
    retryRead,
    clearCorruptRecord,
    setMenuOpen,
    setGuideOpen,
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
