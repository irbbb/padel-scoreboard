import { formatWristDisplay } from '../core/wristDisplay.js';
import { KEEP_ALIVE_DURATION_SEC, KEEP_ALIVE_VOLUME } from './wavGenerator.js';

const WRIST_ACTIONS = Object.freeze([
  ['previoustrack', 'A'],
  ['nexttrack', 'B'],
  ['pause', 'E'],
  ['play', 'E'],
]);

function toErrorMessage(err) {
  if (err && typeof err.message === 'string' && err.message.length > 0) {
    return err.message;
  }
  return String(err);
}

function defaultCreateMetadata({ title, artist, album }) {
  if (typeof globalThis.MediaMetadata === 'function') {
    return new globalThis.MediaMetadata({ title, artist, album });
  }
  return { title, artist, album };
}

function isAudioHealthyPlaying(audio) {
  return Boolean(audio) && !audio.paused && !audio.ended && !audio.error;
}

function getAudioStateLabel(audio) {
  if (!audio) return 'none';
  if (audio.error) return 'error';
  if (audio.ended) return 'ended';
  return audio.paused ? 'paused' : 'playing';
}

function canArmFromSnapshot(snapshot) {
  return Boolean(
    snapshot &&
      snapshot.role === 'WRITER' &&
      snapshot.storageStatus === 'READY' &&
      snapshot.record !== null &&
      snapshot.record.status === 'ACTIVE'
  );
}

function isWriterWithExactRecord(snapshot, expectedRecord) {
  return Boolean(
    snapshot &&
      snapshot.role === 'WRITER' &&
      snapshot.storageStatus === 'READY' &&
      snapshot.record === expectedRecord
  );
}

/**
 * S2.2 MediaSession Wrist Bridge.
 *
 * Enforces:
 * - Starts DISARMED (never auto-plays on load/reload).
 * - Fresh <audio> element per linkFromUserGesture() (detaches old listeners before pausing,
 *   enabling genuine Re-link restarts even from ARMED and avoiding queued HTML pause-event races).
 * - Exact arming scope: lock-holding WRITER of an ACTIVE match after user-initiated play() resolves.
 * - Zero phantom points at the app-enforceable boundary: one point per accepted MediaSession
 *   callback while ARMED and playing; zero points from ordinary <audio> DOM events.
 *   (Note: MediaSession exposes neither device ID nor physical-press ID.)
 * - Exact-record terminal publish binding: only the matching WON / FINISHED_MANUAL record may
 *   consume pendingFinal, write final metadata, and pause its owned audio in finally.
 */
export function createWristBridge({
  createAudio = null,
  mediaSession = null,
  getStoreSnapshot,
  onCommand,
  formatDisplay = formatWristDisplay,
  createMetadata = defaultCreateMetadata,
  diagLog = null,
  onStatusChange = null,
  onInterrupted = null,
  isDisplayGenCurrent = null,
  now = () => Date.now(),
} = {}) {
  if (typeof getStoreSnapshot !== 'function') {
    throw new Error('createWristBridge requires getStoreSnapshot()');
  }
  if (typeof onCommand !== 'function') {
    throw new Error('createWristBridge requires onCommand(code, action)');
  }

  const supported =
    typeof createAudio === 'function' &&
    Boolean(mediaSession) &&
    typeof mediaSession.setActionHandler === 'function';

  let status = supported ? 'DISARMED' : 'UNAVAILABLE'; // 'UNAVAILABLE' | 'DISARMED' | 'ARMED' | 'INTERRUPTED'
  let lastLinkError = null;
  let linkToken = 0;

  let activeSession = null; // { token, audio, detachListeners }
  let pendingLink = null; // { token, audio, detachListeners }
  let pendingFinal = null; // { token, record, audio }

  function logDiag(action, { audio = activeSession?.audio ?? null, revision = null, detail = '' } = {}) {
    if (!diagLog || typeof diagLog.append !== 'function') return;
    try {
      diagLog.append(
        {
          action,
          audioState: getAudioStateLabel(audio),
          revision,
          detail,
        },
        now()
      );
    } catch {
      // Diagnostic logging must never break scoring or audio lifecycle
    }
  }

  function getStatus() {
    return Object.freeze({
      status,
      supported,
      lastLinkError,
      hasPendingFinal: pendingFinal !== null,
    });
  }

  function notify() {
    if (typeof onStatusChange !== 'function') return;
    try {
      onStatusChange(getStatus());
    } catch {
      // Isolate observer exceptions
    }
  }

  function clearHandlers() {
    if (!supported) return;
    for (const [action] of WRIST_ACTIONS) {
      try {
        mediaSession.setActionHandler(action, null);
      } catch {
        // Ignore platform clear errors during teardown
      }
    }
  }

  function setPlaybackStateSafely(nextState) {
    if (!supported) return;
    try {
      mediaSession.playbackState = nextState;
    } catch {
      // Ignore read-only/unsupported playbackState environments
    }
  }

  function updatePositionStateSafely(audio) {
    if (!supported || typeof mediaSession.setPositionState !== 'function') return;
    try {
      const duration =
        audio && typeof audio.duration === 'number' && Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : KEEP_ALIVE_DURATION_SEC;
      const rawPos =
        audio && typeof audio.currentTime === 'number' && Number.isFinite(audio.currentTime)
          ? audio.currentTime
          : 0;
      const position = Math.min(Math.max(0, rawPos), duration);
      mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position,
      });
    } catch {
      // Guard against RangeError / TypeError before metadata loads
    }
  }

  function stopAudioSafely(audio, detachListeners = null) {
    if (typeof detachListeners === 'function') {
      try {
        detachListeners();
      } catch {
        // Ignore detach errors
      }
    }
    if (!audio) return;
    try {
      audio.pause();
    } catch {
      // Ignore pause errors
    }
  }

  function cancelPendingFinal() {
    if (!pendingFinal) return;
    const target = pendingFinal;
    pendingFinal = null;
    stopAudioSafely(target.audio);
  }

  function teardown({ nextStatus = 'DISARMED', reason = '', clearError = false } = {}) {
    if (!supported) return;

    const prevStatus = status;
    const prevError = lastLinkError;
    const prevAudio = activeSession?.audio ?? pendingLink?.audio ?? pendingFinal?.audio ?? null;
    const hadAnything =
      activeSession !== null || pendingLink !== null || pendingFinal !== null || prevStatus !== nextStatus;

    linkToken += 1;
    clearHandlers();

    if (pendingLink) {
      const link = pendingLink;
      pendingLink = null;
      stopAudioSafely(link.audio, link.detachListeners);
    }
    if (activeSession) {
      const sess = activeSession;
      activeSession = null;
      stopAudioSafely(sess.audio, sess.detachListeners);
    }
    cancelPendingFinal();

    status = nextStatus;
    if (clearError) {
      lastLinkError = null;
    }
    setPlaybackStateSafely(nextStatus === 'INTERRUPTED' ? 'paused' : 'none');

    if (reason && hadAnything) {
      logDiag(`wrist_${nextStatus.toLowerCase()}`, {
        audio: prevAudio,
        revision: getStoreSnapshot()?.record?.revision ?? null,
        detail: reason,
      });
    }

    if (status !== prevStatus || lastLinkError !== prevError) {
      notify();
    }
  }

  function interruptSession(myToken, audio, detail) {
    if (myToken !== linkToken || status !== 'ARMED' || activeSession?.token !== myToken) {
      return;
    }
    teardown({ nextStatus: 'INTERRUPTED', reason: detail, clearError: false });
    if (typeof onInterrupted === 'function') {
      try {
        onInterrupted(detail);
      } catch {
        // Isolate observer errors
      }
    }
  }

  function attachAudioListeners(audio, myToken) {
    if (typeof audio.addEventListener !== 'function' || typeof audio.removeEventListener !== 'function') {
      return () => {};
    }

    const onDomPlay = () => {
      if (myToken !== linkToken) return;
      if (status === 'ARMED' && activeSession?.token === myToken) {
        setPlaybackStateSafely(isAudioHealthyPlaying(audio) ? 'playing' : 'paused');
        updatePositionStateSafely(audio);
      }
      logDiag('audio_dom_play', {
        audio,
        revision: getStoreSnapshot()?.record?.revision ?? null,
        detail: `status=${status}`,
      });
    };

    const onDomPlaying = () => {
      if (myToken !== linkToken) return;
      if (status === 'ARMED' && activeSession?.token === myToken) {
        setPlaybackStateSafely('playing');
        updatePositionStateSafely(audio);
      }
    };

    const onDomPause = () => {
      if (myToken !== linkToken) return;
      if (status === 'ARMED' && activeSession?.token === myToken) {
        interruptSession(myToken, audio, 'audio_dom_pause');
      }
    };

    const onDomEnded = () => {
      if (myToken !== linkToken) return;
      if (status === 'ARMED' && activeSession?.token === myToken) {
        interruptSession(myToken, audio, 'audio_dom_ended');
      }
    };

    const onDomError = () => {
      if (myToken !== linkToken) return;
      if (status === 'ARMED' && activeSession?.token === myToken) {
        interruptSession(myToken, audio, 'audio_dom_error');
      }
    };

    audio.addEventListener('play', onDomPlay);
    audio.addEventListener('playing', onDomPlaying);
    audio.addEventListener('pause', onDomPause);
    audio.addEventListener('ended', onDomEnded);
    audio.addEventListener('error', onDomError);

    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      audio.removeEventListener('play', onDomPlay);
      audio.removeEventListener('playing', onDomPlaying);
      audio.removeEventListener('pause', onDomPause);
      audio.removeEventListener('ended', onDomEnded);
      audio.removeEventListener('error', onDomError);
    };
  }

  function handleMediaAction(myToken, action, code) {
    if (
      myToken !== linkToken ||
      status !== 'ARMED' ||
      !activeSession ||
      activeSession.token !== myToken
    ) {
      logDiag(`ignored_${action}`, { detail: `status=${status}` });
      return;
    }

    const snap = getStoreSnapshot();
    const audio = activeSession.audio;

    if (!canArmFromSnapshot(snap)) {
      teardown({ nextStatus: 'DISARMED', reason: `not_live_writer_on_${action}` });
      return;
    }

    if (!isAudioHealthyPlaying(audio)) {
      interruptSession(myToken, audio, `audio_not_playing_on_${action}`);
      return;
    }

    // Center tap ('pause'/'play') intentionally keeps audio playing and maps to E
    setPlaybackStateSafely('playing');
    updatePositionStateSafely(audio);

    let cmdRes;
    try {
      cmdRes = onCommand(code, action);
    } catch (err) {
      logDiag(`command_error_${action}`, {
        audio,
        revision: getStoreSnapshot()?.record?.revision ?? null,
        detail: toErrorMessage(err),
      });
      return;
    }

    if (cmdRes && typeof cmdRes === 'object' && typeof cmdRes.outcome === 'string') {
      const rev = cmdRes.revision ?? getStoreSnapshot()?.record?.revision ?? null;
      if (cmdRes.outcome === 'ignored_awaiting_server') {
        logDiag('ignored_awaiting_server', {
          audio,
          revision: rev,
          detail: cmdRes.detail || `action=${action}`,
        });
      } else if (cmdRes.outcome === 'save_failed') {
        logDiag(`wrist_save_failed_${action}`, {
          audio,
          revision: rev,
          detail: cmdRes.detail || 'save_failed',
        });
      } else if (cmdRes.outcome === 'saved') {
        logDiag(`wrist_${action}`, {
          audio,
          revision: rev,
          detail: cmdRes.detail || `code=${code}`,
        });
      } else {
        logDiag(`wrist_noop_${action}`, {
          audio,
          revision: rev,
          detail: cmdRes.detail || `code=${code}`,
        });
      }
      return;
    }

    const afterSnap = getStoreSnapshot();
    if (afterSnap?.lastSaveError) {
      logDiag(`wrist_save_failed_${action}`, {
        audio,
        revision: afterSnap?.record?.revision ?? null,
        detail: afterSnap.lastSaveError,
      });
      return;
    }

    logDiag(`wrist_${action}`, {
      audio,
      revision: afterSnap?.record?.revision ?? null,
      detail: `code=${code}`,
    });
  }

  function installHandlers(myToken) {
    try {
      for (const [action, code] of WRIST_ACTIONS) {
        mediaSession.setActionHandler(action, () => handleMediaAction(myToken, action, code));
      }
    } catch (err) {
      clearHandlers();
      throw err;
    }
  }

  function writeMetadata(state, editState = null) {
    const { title, artist } = editState
      ? formatDisplay(state, { editState })
      : formatDisplay(state);
    mediaSession.metadata = createMetadata({ title, artist, album: '' });
  }

  /**
   * Must be invoked directly from a user tap (Start Match or Re-link Wrist).
   * Invalidates any previous link, detaches/pauses its audio, and calls freshAudio.play()
   * synchronously before yielding so Android Chrome preserves user gesture activation.
   */
  function linkFromUserGesture(republishFn = null) {
    if (!supported) {
      const err = new Error('MediaSession is unavailable in this browser');
      return Promise.resolve({ ok: false, error: err });
    }

    // Real restart: tear down any prior ARMED/pending/final session first
    teardown({ nextStatus: 'DISARMED', reason: '', clearError: false });

    const startSnap = getStoreSnapshot();
    if (!canArmFromSnapshot(startSnap)) {
      const err = new Error('Wrist link requires an active match in writer mode');
      lastLinkError = err.message;
      notify();
      return Promise.resolve({ ok: false, error: err });
    }

    const startMatchId = startSnap.record.matchId;
    const myToken = ++linkToken;

    let audio;
    try {
      audio = createAudio();
    } catch (err) {
      lastLinkError = toErrorMessage(err);
      logDiag('link_create_audio_error', { revision: startSnap.record.revision, detail: lastLinkError });
      notify();
      return Promise.resolve({ ok: false, error: err });
    }

    audio.loop = true;
    try {
      audio.volume = KEEP_ALIVE_VOLUME;
    } catch {
      // Some environments expose read-only volume
    }

    const detachListeners = attachAudioListeners(audio, myToken);
    pendingLink = { token: myToken, audio, detachListeners };

    // Call audio.play() SYNCHRONOUSLY inside the user gesture before any await
    let playPromise;
    try {
      playPromise = Promise.resolve(audio.play());
    } catch (err) {
      if (pendingLink?.token === myToken) {
        pendingLink = null;
      }
      stopAudioSafely(audio, detachListeners);
      if (myToken === linkToken) {
        status = 'DISARMED';
        lastLinkError = toErrorMessage(err);
        setPlaybackStateSafely('none');
        logDiag('link_rejected', { audio, revision: startSnap.record.revision, detail: lastLinkError });
        notify();
      }
      return Promise.resolve({ ok: false, error: err });
    }

    return playPromise.then(
      async () => {
        if (pendingLink?.token === myToken) {
          pendingLink = null;
        }

        const currentSnap = getStoreSnapshot();
        const stillValid =
          myToken === linkToken &&
          canArmFromSnapshot(currentSnap) &&
          currentSnap.record.matchId === startMatchId &&
          isAudioHealthyPlaying(audio);

        if (!stillValid) {
          stopAudioSafely(audio, detachListeners);
          logDiag('link_stale_resolved', {
            audio,
            revision: currentSnap?.record?.revision ?? null,
            detail: `token=${myToken}/${linkToken}`,
          });
          return { ok: false, stale: true, error: new Error('Link attempt invalidated before arming') };
        }

        try {
          installHandlers(myToken);
        } catch (err) {
          stopAudioSafely(audio, detachListeners);
          status = 'DISARMED';
          lastLinkError = toErrorMessage(err);
          setPlaybackStateSafely('none');
          logDiag('link_handler_error', {
            audio,
            revision: currentSnap.record.revision,
            detail: lastLinkError,
          });
          notify();
          return { ok: false, error: err };
        }

        activeSession = { token: myToken, audio, detachListeners };
        status = 'ARMED';
        lastLinkError = null;
        setPlaybackStateSafely('playing');
        updatePositionStateSafely(audio);
        logDiag('wrist_linked', {
          audio,
          revision: currentSnap.record.revision,
          detail: `matchId=${startMatchId}`,
        });
        notify();

        if (myToken !== linkToken || activeSession?.token !== myToken) {
          return { ok: false, stale: true, error: new Error('Link superseded before republish') };
        }

        let publishResult = null;
        if (typeof republishFn === 'function') {
          try {
            publishResult = await republishFn();
          } catch (err) {
            return { ok: true, publishResult: { ok: false, publishError: err } };
          }
        }
        return { ok: true, publishResult };
      },
      (err) => {
        if (pendingLink?.token === myToken) {
          pendingLink = null;
        }
        stopAudioSafely(audio, detachListeners);

        if (myToken !== linkToken) {
          // Stale rejection from an invalidated attempt must be completely harmless
          return { ok: false, stale: true, error: err };
        }

        status = 'DISARMED';
        lastLinkError = toErrorMessage(err);
        setPlaybackStateSafely('none');
        logDiag('link_rejected', {
          audio,
          revision: getStoreSnapshot()?.record?.revision ?? null,
          detail: lastLinkError,
        });
        notify();
        return { ok: false, error: err };
      }
    );
  }

  /**
   * Synchronously tracks matchStore transitions.
   * - On ACTIVE -> WON / FINISHED_MANUAL while ARMED: immediately disarms scoring & clears handlers,
   *   and binds pendingFinal strictly to that exact frozen terminal record.
   * - On Undo, Resume, replacement New Match, or loss of writer lock: cancels any pendingFinal / link
   *   and stops audio immediately.
   */
  function syncStoreSnapshot(snapshot) {
    if (!supported) return;

    const isWriter = Boolean(snapshot && snapshot.role === 'WRITER' && snapshot.storageStatus === 'READY');
    const rec = isWriter ? snapshot.record : null;

    if (!isWriter || !rec) {
      teardown({ nextStatus: 'DISARMED', reason: 'lost_live_writer' });
      return;
    }

    if (rec.status === 'ACTIVE') {
      // Undo, Resume, or replacement ACTIVE match cancels any lingering terminal publish immediately
      if (pendingFinal !== null) {
        cancelPendingFinal();
        setPlaybackStateSafely('none');
      }
      return;
    }

    // Terminal state (WON or FINISHED_MANUAL)
    if (status === 'ARMED' && activeSession !== null) {
      const sess = activeSession;
      activeSession = null;
      linkToken += 1;
      clearHandlers();
      // Detach interruption listeners before handoff to pendingFinal
      try {
        sess.detachListeners();
      } catch {
        // Ignore
      }
      if (pendingLink) {
        const link = pendingLink;
        pendingLink = null;
        stopAudioSafely(link.audio, link.detachListeners);
      }
      cancelPendingFinal();

      pendingFinal = {
        token: sess.token,
        record: rec,
        audio: sess.audio,
      };
      status = 'DISARMED';
      logDiag('wrist_disarmed_finish', {
        audio: sess.audio,
        revision: rec.revision,
        detail: `status=${rec.status}`,
      });
      notify();
      return;
    }

    // Not currently ARMED: cancel any pending link or mismatched pendingFinal
    if (pendingLink) {
      const link = pendingLink;
      pendingLink = null;
      linkToken += 1;
      stopAudioSafely(link.audio, link.detachListeners);
    }
    if (pendingFinal && pendingFinal.record !== rec) {
      cancelPendingFinal();
      setPlaybackStateSafely('none');
    }
    clearHandlers();
  }

  /**
   * Captures the currently armed link token at publish enqueue time so a superseded link's
   * queued ACTIVE publishes or re-publishes are skipped cleanly if a newer link takes over.
   */
  function capturePublishContext() {
    if (status === 'ARMED' && activeSession) {
      return activeSession.token;
    }
    return null;
  }

  /**
   * Invoked by matchStore's FIFO publishQueue after storage.setItem succeeds.
   * Accepts either a numeric originToken or an immutable snapshot { token, displayGen, editState }.
   * Returns { skipped: true } whenever no metadata was actually published so matchStore
   * never lets a skipped publish clear an existing lastPublishError.
   */
  function publishSnapshot(state, record, originContext = undefined) {
    if (!supported) {
      return { skipped: true };
    }

    const isObjContext = originContext !== null && typeof originContext === 'object';
    const originToken = isObjContext ? originContext.token : originContext;
    const originDisplayGen = isObjContext ? originContext.displayGen : undefined;
    const originEditState = isObjContext ? originContext.editState ?? null : null;

    // Exact-record terminal publish path (independent of displayGen so final WIN/END always writes & pauses audio)
    if (pendingFinal !== null) {
      if (record !== pendingFinal.record) {
        return { skipped: true };
      }
      if (originToken !== undefined && originToken !== pendingFinal.token) {
        return { skipped: true };
      }

      const target = pendingFinal;
      pendingFinal = null;

      if (!isWriterWithExactRecord(getStoreSnapshot(), target.record)) {
        stopAudioSafely(target.audio);
        setPlaybackStateSafely('none');
        return { skipped: true };
      }

      try {
        writeMetadata(state, null);
        logDiag('wrist_publish_final', {
          audio: target.audio,
          revision: record.revision,
          detail: `status=${state.status}`,
        });
        return { skipped: false };
      } finally {
        stopAudioSafely(target.audio);
        setPlaybackStateSafely('paused');
        notify();
      }
    }

    // Active live publish path
    if (status !== 'ARMED' || !activeSession) {
      return { skipped: true };
    }

    if (originToken !== undefined && originToken !== activeSession.token) {
      return { skipped: true };
    }

    if (
      originDisplayGen !== undefined &&
      typeof isDisplayGenCurrent === 'function' &&
      !isDisplayGenCurrent(originDisplayGen)
    ) {
      return { skipped: true };
    }

    const currentSnap = getStoreSnapshot();
    if (
      !canArmFromSnapshot(currentSnap) ||
      !state ||
      state.status !== 'ACTIVE' ||
      !record ||
      currentSnap.record.matchId !== record.matchId
    ) {
      return { skipped: true };
    }

    writeMetadata(state, originEditState);
    const audio = activeSession.audio;
    setPlaybackStateSafely(isAudioHealthyPlaying(audio) ? 'playing' : 'paused');
    updatePositionStateSafely(audio);
    return { skipped: false };
  }

  function disarm(reason = 'manual_disarm') {
    teardown({ nextStatus: 'DISARMED', reason, clearError: false });
  }

  function handleVisibilityChange(visibilityState) {
    // Ordinary screen lock keeps the wrist bridge ARMED; log only for field diagnostics
    logDiag('visibility_change', {
      revision: getStoreSnapshot()?.record?.revision ?? null,
      detail: `visibility=${visibilityState},wrist=${status}`,
    });
  }

  function destroy() {
    teardown({ nextStatus: 'DISARMED', reason: 'page_teardown', clearError: false });
  }

  return {
    getStatus,
    linkFromUserGesture,
    syncStoreSnapshot,
    capturePublishContext,
    publishSnapshot,
    disarm,
    handleVisibilityChange,
    destroy,
  };
}
