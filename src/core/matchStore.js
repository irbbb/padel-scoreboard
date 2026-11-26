import { createMatch, deriveMatchState, validateMatchRecord } from './scoreEngine.js';

export const MATCH_STORAGE_KEY = 'padelScore.activeMatch.v1';
export const WRITER_LOCK_NAME = 'padel-scoreboard-writer';

function toErrorMessage(err) {
  if (err && typeof err.message === 'string' && err.message.length > 0) {
    return err.message;
  }
  return String(err);
}

/**
 * Single-writer match store enforcing mutual exclusion via Web Locks API,
 * synchronous save-before-publish persistence, ordered async wrist publishing,
 * scoped lock-session cleanup, and safe recovery on read/write/corrupt-storage failures.
 *
 * Pure ES module: browser APIs (`storage`, `locks`) are injected for full unit testability.
 */
export function createMatchStore({
  storage,
  locks = null,
  publishWrist = null,
  capturePublishContext = null,
  onStateChange = null,
  now = () => Date.now(),
  storageKey = MATCH_STORAGE_KEY,
  lockName = WRITER_LOCK_NAME,
} = {}) {
  if (
    !storage ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function'
  ) {
    throw new Error('createMatchStore requires a storage object with getItem, setItem, and removeItem');
  }

  let role = 'READ_ONLY'; // 'WRITER' | 'READ_ONLY'
  let lockStatus = 'IDLE'; // 'IDLE' | 'ACQUIRING' | 'HELD' | 'BUSY' | 'UNAVAILABLE' | 'RELEASING' | 'ERROR'
  let storageStatus = 'UNREAD'; // 'UNREAD' | 'EMPTY' | 'READY' | 'CORRUPT' | 'READ_ERROR'

  let record = null;
  let corruptRaw = null;
  let corruptError = null;
  let storageReadError = null;
  let lastSaveError = null;
  let lastPublishError = null;

  // Scoped acquisition/release tracking so concurrent releases never erase a newer grant
  let nextSessionId = 0;
  let activeSession = null; // { id, releaseLockFn, outerReq, releasing }
  let pendingAcquire = null; // { id, promise, cancelled }
  let pendingReleasePromise = null;

  let publishQueue = Promise.resolve();

  function safeNotify() {
    if (typeof onStateChange !== 'function') return;
    try {
      onStateChange(getSnapshot());
    } catch {
      // Isolate observer exceptions so they cannot suppress storage commits or wrist delivery
    }
  }

  function getSnapshot(nowMs = now()) {
    let state = null;
    if (record !== null) {
      try {
        state = deriveMatchState(record, nowMs);
      } catch {
        state = null;
      }
    }
    return Object.freeze({
      role,
      lockStatus,
      storageStatus,
      record,
      state,
      corruptRaw,
      corruptError,
      storageReadError,
      lastSaveError,
      lastPublishError,
    });
  }

  function loadFromStorage() {
    let raw;
    try {
      raw = storage.getItem(storageKey);
    } catch (err) {
      storageStatus = 'READ_ERROR';
      storageReadError = toErrorMessage(err);
      record = null;
      corruptRaw = null;
      corruptError = null;
      return;
    }

    storageReadError = null;

    // Only an explicit null means empty storage; empty string "" is corrupt
    if (raw === null) {
      storageStatus = 'EMPTY';
      record = null;
      corruptRaw = null;
      corruptError = null;
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      record = validateMatchRecord(parsed); // Deep-freezes validated record
      storageStatus = 'READY';
      corruptRaw = null;
      corruptError = null;
    } catch (err) {
      storageStatus = 'CORRUPT';
      record = null;
      corruptRaw = String(raw);
      corruptError = toErrorMessage(err);
    }
  }

  function enqueuePublish(snapshotState, snapshotRecord) {
    if (typeof publishWrist !== 'function') {
      return Promise.resolve({ wristPublished: false, publishError: null });
    }

    const publishContext =
      typeof capturePublishContext === 'function'
        ? capturePublishContext(snapshotState, snapshotRecord)
        : undefined;

    const job = publishQueue.then(async () => {
      try {
        const result = await publishWrist(snapshotState, snapshotRecord, publishContext);
        if (result && result.skipped === true) {
          return { wristPublished: false, publishError: null };
        }
        if (lastPublishError !== null) {
          lastPublishError = null;
          safeNotify();
        }
        return { wristPublished: true, publishError: null };
      } catch (err) {
        lastPublishError = toErrorMessage(err);
        safeNotify();
        return { wristPublished: false, publishError: err };
      }
    });

    // Keep queue alive even if a publish rejects (handled inside try/catch above)
    publishQueue = job.then(() => undefined);
    return job;
  }

  async function tryAcquireWriter() {
    if (pendingReleasePromise) {
      return false;
    }
    if (activeSession && !activeSession.releasing && role === 'WRITER' && lockStatus === 'HELD') {
      return true;
    }
    if (pendingAcquire) {
      return pendingAcquire.promise;
    }

    if (!locks || typeof locks.request !== 'function') {
      role = 'READ_ONLY';
      lockStatus = 'UNAVAILABLE';
      loadFromStorage();
      safeNotify();
      return false;
    }

    const sessionId = ++nextSessionId;
    lockStatus = 'ACQUIRING';

    let resolveDecision;
    let rejectDecision;
    const decisionPromise = new Promise((resolve, reject) => {
      resolveDecision = resolve;
      rejectDecision = reject;
    });

    const acq = {
      id: sessionId,
      promise: decisionPromise,
      cancelled: false,
      outerReq: null,
    };
    pendingAcquire = acq;

    let decisionSettled = false;
    let createdSession = null;

    try {
      const outerReq = locks.request(
        lockName,
        { mode: 'exclusive', ifAvailable: true },
        (lock) => {
          if (!lock) {
            if (!acq.cancelled && pendingAcquire === acq) {
              role = 'READ_ONLY';
              lockStatus = 'BUSY';
              loadFromStorage();
              safeNotify();
            }
            decisionSettled = true;
            resolveDecision(false);
            return;
          }

          // If releaseWriter() raced this pending acquisition, drop the grant immediately
          if (acq.cancelled) {
            decisionSettled = true;
            resolveDecision(false);
            return;
          }

          let resolveRelease;
          const holdPromise = new Promise((res) => {
            resolveRelease = res;
          });

          const session = {
            id: sessionId,
            releaseLockFn: () => {
              session.releaseLockFn = null;
              resolveRelease();
            },
            outerReq: null,
            releasing: false,
          };

          createdSession = session;
          activeSession = session;
          role = 'WRITER';
          lockStatus = 'HELD';
          loadFromStorage(); // Mandatory reread under the held lock

          // Clear pendingAcquire before notifying HELD so an observer calling releaseWriter()
          // releases this session cleanly instead of treating it as a pending acquire.
          if (pendingAcquire === acq) {
            pendingAcquire = null;
          }

          safeNotify();

          // If the HELD observer synchronously called releaseWriter(), report false (now READ_ONLY)
          const stillHeld =
            activeSession === session &&
            !session.releasing &&
            role === 'WRITER' &&
            lockStatus === 'HELD';

          decisionSettled = true;
          resolveDecision(stillHeld);

          return holdPromise;
        }
      );

      acq.outerReq = outerReq;
      if (createdSession) {
        createdSession.outerReq = outerReq;
      }

      outerReq.catch((err) => {
        if (!acq.cancelled && (pendingAcquire === acq || (activeSession && activeSession.id === sessionId))) {
          if (activeSession && activeSession.id === sessionId) {
            activeSession = null;
          }
          role = 'READ_ONLY';
          lockStatus = 'ERROR';
          safeNotify();
        }
        if (!decisionSettled) {
          decisionSettled = true;
          rejectDecision(err);
        }
      });
    } catch (err) {
      role = 'READ_ONLY';
      lockStatus = 'ERROR';
      safeNotify();
      if (!decisionSettled) {
        decisionSettled = true;
        rejectDecision(err);
      }
    }

    try {
      return await decisionPromise;
    } finally {
      if (pendingAcquire === acq) {
        pendingAcquire = null;
      }
    }
  }

  function releaseWriter() {
    // Share one active release operation across concurrent releaseWriter() calls
    if (pendingReleasePromise) {
      return pendingReleasePromise;
    }

    const sessionToRelease = activeSession;
    const acqToCancel = pendingAcquire;

    // Immediately disable mutations before notifying observers
    if (sessionToRelease) {
      sessionToRelease.releasing = true;
    }
    if (acqToCancel) {
      acqToCancel.cancelled = true;
    }
    role = 'READ_ONLY';
    const wasActive =
      Boolean(sessionToRelease) ||
      Boolean(acqToCancel) ||
      lockStatus === 'HELD' ||
      lockStatus === 'ACQUIRING';

    if (wasActive) {
      lockStatus = 'RELEASING';
    }

    const releaseOp = (async () => {
      // Yield one microtask so pendingReleasePromise is always assigned before cleanup runs
      await Promise.resolve();

      try {
        if (acqToCancel) {
          try {
            await acqToCancel.promise;
          } catch {
            // Ignore acquisition failure during shutdown
          }
        }

        // Drain all accepted wrist publish jobs before releasing the Web Lock
        await publishQueue;

        if (sessionToRelease && sessionToRelease.releaseLockFn) {
          sessionToRelease.releaseLockFn();
        }

        const outerReq = sessionToRelease?.outerReq ?? acqToCancel?.outerReq ?? null;
        if (outerReq) {
          try {
            await outerReq;
          } catch {
            // Ignore outer rejection already handled
          }
        }
      } finally {
        // Scope cleanup strictly to THIS release operation and THIS session!
        if (sessionToRelease && activeSession === sessionToRelease) {
          activeSession = null;
        }
        if (acqToCancel && pendingAcquire === acqToCancel) {
          pendingAcquire = null;
        }
        if (pendingReleasePromise === releaseOp) {
          pendingReleasePromise = null;
        }
        // Only transition to IDLE if no newer session was started
        if (activeSession === null && pendingAcquire === null) {
          role = 'READ_ONLY';
          if (lockStatus === 'RELEASING') {
            lockStatus = 'IDLE';
          }
          safeNotify();
        }
      }
    })();

    // Install shared promise BEFORE notifying RELEASING so any reentrant releaseWriter() returns it
    pendingReleasePromise = releaseOp;
    if (wasActive) {
      safeNotify();
    }
    return releaseOp;
  }

  function assertCanMutate({ allowEmpty = false } = {}) {
    if (
      pendingReleasePromise ||
      !activeSession ||
      activeSession.releasing ||
      role !== 'WRITER' ||
      lockStatus !== 'HELD'
    ) {
      throw new Error('Read-only client cannot mutate match');
    }
    if (storageStatus === 'READ_ERROR') {
      throw new Error(`Storage read error active (${storageReadError}); retry read before mutating`);
    }
    if (storageStatus === 'CORRUPT') {
      throw new Error('Corrupt match record present; explicit recovery required before mutating');
    }
    if (storageStatus === 'UNREAD') {
      throw new Error('Storage has not been read under the writer lock');
    }
    if (!allowEmpty && storageStatus === 'EMPTY') {
      throw new Error('No active match in storage; start a new match first');
    }
  }

  function runCommitPipeline(transformFn, nowMs, { allowEmpty = false, isReplacement = false } = {}) {
    assertCanMutate({ allowEmpty });

    const baseSession = activeSession;
    const baseRecord = record;

    // Synchronous transform
    const nextRecord = transformFn(baseRecord);

    // Recheck ownership, storage status, and record identity after transform in case of reentrancy
    assertCanMutate({ allowEmpty });
    if (activeSession !== baseSession || record !== baseRecord) {
      throw new Error('Concurrent or reentrant state change detected during commit transform');
    }

    // No-op: skip write, state notification, and wrist publish; preserve prior errors
    if (nextRecord === baseRecord) {
      const currentState = baseRecord !== null ? deriveMatchState(baseRecord, nowMs) : null;
      return Promise.resolve({
        ok: true,
        changed: false,
        wristPublished: false,
        record: baseRecord,
        state: currentState,
      });
    }

    const validatedNext = validateMatchRecord(nextRecord);

    // Ordinary commits within a match must preserve matchId and increment revision by exactly 1
    if (!isReplacement && baseRecord !== null) {
      if (validatedNext.matchId !== baseRecord.matchId) {
        throw new Error(
          `Ordinary commit cannot change matchId ("${baseRecord.matchId}" -> "${validatedNext.matchId}"); use startNewMatch`
        );
      }
      if (validatedNext.revision !== baseRecord.revision + 1) {
        throw new Error(
          `Ordinary commit must increment revision by exactly 1 (expected ${baseRecord.revision + 1}, got ${validatedNext.revision})`
        );
      }
    }

    const nextState = deriveMatchState(validatedNext, nowMs);

    try {
      storage.setItem(storageKey, JSON.stringify(validatedNext));
    } catch (err) {
      lastSaveError = toErrorMessage(err);
      safeNotify();
      return Promise.resolve({
        ok: false,
        changed: false,
        stage: 'save',
        error: err,
        record: baseRecord,
      });
    }

    // Save succeeded: commit synchronously in memory
    record = validatedNext;
    storageStatus = 'READY';
    lastSaveError = null;

    // Reserve publish queue position BEFORE notifying observers so reentrant commits stay ordered
    const publishPromise = enqueuePublish(nextState, record);

    safeNotify();

    return publishPromise.then(({ wristPublished, publishError }) => ({
      ok: true,
      changed: true,
      wristPublished,
      publishError,
      record: validatedNext,
      state: nextState,
    }));
  }

  function commit(transformFn, nowMs = now()) {
    return runCommitPipeline(transformFn, nowMs, { allowEmpty: false, isReplacement: false });
  }

  function startNewMatch({ matchId, config, nowMs = now() }) {
    return runCommitPipeline(() => createMatch({ matchId, config, nowMs }), nowMs, {
      allowEmpty: true,
      isReplacement: true,
    });
  }

  function republishWrist(nowMs = now()) {
    assertCanMutate({ allowEmpty: false });
    const snapshotRecord = record;
    const snapshotState = deriveMatchState(snapshotRecord, nowMs);
    return enqueuePublish(snapshotState, snapshotRecord).then(({ wristPublished, publishError }) => ({
      ok: true,
      wristPublished,
      publishError,
      record: snapshotRecord,
      state: snapshotState,
    }));
  }

  function retryRead() {
    if (pendingReleasePromise || !activeSession || activeSession.releasing || role !== 'WRITER' || lockStatus !== 'HELD') {
      throw new Error('Read-only client cannot run writer retryRead');
    }
    loadFromStorage();
    safeNotify();
    return getSnapshot();
  }

  function refreshReadOnly() {
    if (role === 'WRITER') {
      return getSnapshot();
    }
    loadFromStorage();
    safeNotify();
    return getSnapshot();
  }

  function clearCorruptRecord() {
    if (pendingReleasePromise || !activeSession || activeSession.releasing || role !== 'WRITER' || lockStatus !== 'HELD') {
      throw new Error('Read-only client cannot clear corrupt storage');
    }
    if (storageStatus === 'READ_ERROR') {
      throw new Error(`Storage read error active (${storageReadError}); retry read before clearing`);
    }
    if (storageStatus !== 'CORRUPT' || corruptRaw === null) {
      throw new Error('Cannot clear storage: no corrupt match record is present');
    }

    // Verify stored value has not changed since it was shown to the user
    let currentRaw;
    try {
      currentRaw = storage.getItem(storageKey);
    } catch (err) {
      storageStatus = 'READ_ERROR';
      storageReadError = toErrorMessage(err);
      safeNotify();
      return { ok: false, stage: 'clear', error: err };
    }

    if (currentRaw !== corruptRaw) {
      loadFromStorage();
      safeNotify();
      return {
        ok: false,
        stage: 'clear',
        changed: true,
        error: new Error('Stored value changed before clear; reloaded current storage state'),
      };
    }

    try {
      storage.removeItem(storageKey);
    } catch (err) {
      // Retain corruptRaw so the user can retry
      return { ok: false, stage: 'clear', error: err };
    }

    corruptRaw = null;
    corruptError = null;
    record = null;
    storageStatus = 'EMPTY';
    lastSaveError = null;
    safeNotify();
    return { ok: true };
  }

  return {
    getSnapshot,
    tryAcquireWriter,
    releaseWriter,
    commit,
    startNewMatch,
    republishWrist,
    retryRead,
    refreshReadOnly,
    clearCorruptRecord,
  };
}
