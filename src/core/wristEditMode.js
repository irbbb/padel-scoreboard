export const WRIST_CENTER_MODES = Object.freeze({
  ONE_TAP_UE: 'ONE_TAP_UE',
  EDIT_MODE: 'EDIT_MODE',
});

export function normalizeWristCenterMode(value) {
  return value === WRIST_CENTER_MODES.ONE_TAP_UE
    ? WRIST_CENTER_MODES.ONE_TAP_UE
    : WRIST_CENTER_MODES.EDIT_MODE;
}

export function createInitialEditState() {
  return Object.freeze({
    phase: 'LIVE', // 'LIVE' | 'PROMPT' | 'AWAITING_LIVE'
    matchId: null,
    baseRevision: null,
    canUndo: false,
    reason: null, // null | 'UNDO' | 'UE' | 'INVALIDATED'
  });
}

function makeAwaitingLive(record, reason) {
  return Object.freeze({
    phase: 'AWAITING_LIVE',
    matchId: record.matchId,
    baseRevision: record.revision,
    canUndo: false,
    reason,
  });
}

function makePrompt(record) {
  return Object.freeze({
    phase: 'PROMPT',
    matchId: record.matchId,
    baseRevision: record.revision,
    canUndo: record.events.length > 0,
    reason: null,
  });
}

/**
 * Pure reducer for wrist actions when either EDIT_MODE is active OR an AWAITING_LIVE
 * barrier is still active (e.g. after switching back to ONE_TAP_UE while a prompt was open).
 */
export function reduceEditWristInput(editState, action, record, wristCenterMode) {
  const isCenter = action === 'pause' || action === 'play';
  const isPrev = action === 'previoustrack';
  const isNext = action === 'nexttrack';

  if (!record || record.status !== 'ACTIVE') {
    return {
      nextEditState: createInitialEditState(),
      effect: { type: 'IGNORE', detail: 'match_not_active' },
    };
  }

  // Always honor AWAITING_LIVE even if wristCenterMode was switched back to ONE_TAP_UE,
  // so late arrows are swallowed and Center cleanly resumes live scoring without scoring MY UE!
  if (editState.phase === 'AWAITING_LIVE') {
    if (isCenter) {
      return {
        nextEditState: createInitialEditState(),
        effect: { type: 'RETURN_TO_LIVE', detail: `from=${editState.reason}` },
      };
    }
    return {
      nextEditState: editState,
      effect: { type: 'CONSUME_ARROW', detail: `awaiting_live_${editState.reason}` },
    };
  }

  // Server picker takes priority over opening a new EDIT prompt
  if (record.config.initialServer === null) {
    if (isPrev) return { nextEditState: createInitialEditState(), effect: { type: 'PICK_SERVER', team: 0 } };
    if (isNext) return { nextEditState: createInitialEditState(), effect: { type: 'PICK_SERVER', team: 1 } };
    return {
      nextEditState: createInitialEditState(),
      effect: { type: 'IGNORE_AWAITING_SERVER', detail: `action=${action}` },
    };
  }

  if (editState.phase === 'PROMPT') {
    if (isCenter) {
      // Repeated center taps leave PROMPT open without changing score
      return {
        nextEditState: editState,
        effect: { type: 'KEEP_PROMPT_OPEN', detail: `rev=${editState.baseRevision}` },
      };
    }

    // Stale revision or different match invalidates PROMPT and consumes the late arrow
    if (editState.matchId !== record.matchId || editState.baseRevision !== record.revision) {
      return {
        nextEditState: makeAwaitingLive(record, 'INVALIDATED'),
        effect: {
          type: 'CONSUME_STALE_ARROW',
          detail: `stale_${editState.baseRevision}_vs_${record.revision}`,
        },
      };
    }

    if (isPrev) {
      if (record.events.length === 0) {
        return {
          nextEditState: editState,
          effect: { type: 'NO_UNDO_AVAILABLE', detail: `rev=${record.revision}` },
        };
      }
      return {
        nextEditState: editState, // Transitions to AWAITING_LIVE(UNDO) only after storage commit succeeds
        effect: { type: 'COMMIT_UNDO', matchId: record.matchId, expectedRevision: record.revision },
      };
    }

    if (isNext) {
      return {
        nextEditState: editState, // Transitions to AWAITING_LIVE(UE) only after storage commit succeeds
        effect: { type: 'COMMIT_UE', matchId: record.matchId, expectedRevision: record.revision },
      };
    }

    return { nextEditState: editState, effect: { type: 'IGNORE', detail: `unknown_${action}` } };
  }

  // LIVE phase
  if (isPrev) {
    return { nextEditState: editState, effect: { type: 'SCORE', code: 'A' } };
  }
  if (isNext) {
    return { nextEditState: editState, effect: { type: 'SCORE', code: 'B' } };
  }
  if (isCenter) {
    if (normalizeWristCenterMode(wristCenterMode) === WRIST_CENTER_MODES.EDIT_MODE) {
      return {
        nextEditState: makePrompt(record),
        effect: { type: 'OPEN_PROMPT', detail: `rev=${record.revision}` },
      };
    }
    return { nextEditState: editState, effect: { type: 'SCORE', code: 'E' } };
  }

  return { nextEditState: editState, effect: { type: 'IGNORE', detail: `unknown_${action}` } };
}

/**
 * Synchronously reconciles editState after a committed match record change.
 * - If ownCommitReason ('UNDO' | 'UE') is supplied for a live commit, enters AWAITING_LIVE(reason).
 * - If match ended (WON / FINISHED_MANUAL) or cleared, resets to LIVE.
 * - If an external phone edit changed revision/match while in PROMPT or AWAITING_LIVE,
 *   pins AWAITING_LIVE(INVALIDATED) to the newest revision so wrist arrows stay blocked until Center.
 */
export function reconcileEditStateAfterRecordChange(
  editState,
  record,
  { ownCommitReason = null } = {}
) {
  if (!record || record.status !== 'ACTIVE') {
    return createInitialEditState();
  }

  if (ownCommitReason === 'UNDO' || ownCommitReason === 'UE') {
    return makeAwaitingLive(record, ownCommitReason);
  }

  if (editState.phase === 'LIVE') {
    return editState;
  }

  if (editState.matchId !== record.matchId || editState.baseRevision !== record.revision) {
    return makeAwaitingLive(record, 'INVALIDATED');
  }

  return editState;
}

/**
 * Transitions an open PROMPT or AWAITING_LIVE into AWAITING_LIVE(INVALIDATED)
 * when canceled on the phone, when switching out of EDIT_MODE, or on Re-link after interruption.
 */
export function invalidateEditToAwaitingLive(editState, record) {
  if (!record || record.status !== 'ACTIVE') {
    return createInitialEditState();
  }
  if (editState.phase === 'LIVE') {
    return editState;
  }
  return makeAwaitingLive(record, 'INVALIDATED');
}
