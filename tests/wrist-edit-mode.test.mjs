import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialEditState,
  invalidateEditToAwaitingLive,
  reconcileEditStateAfterRecordChange,
  reduceEditWristInput,
  WRIST_CENTER_MODES,
} from '../src/core/wristEditMode.js';

function makeRec(overrides = {}) {
  return {
    matchId: 'm1',
    revision: 42,
    status: 'ACTIVE',
    config: { scoringMode: 'AD', format: 'BO3', decidingSet: 'NORMAL', initialServer: 0 },
    events: [{ id: 1, t: 1000, code: 'A' }],
    ...overrides,
  };
}

test('S4.2 state machine: LIVE -> PROMPT -> COMMIT_UNDO/UE -> AWAITING_LIVE -> LIVE, and repeated Center stays open', () => {
  const rec42 = makeRec();
  let st = createInitialEditState();

  // ONE_TAP_UE center scores E directly
  let out = reduceEditWristInput(st, 'pause', rec42, WRIST_CENTER_MODES.ONE_TAP_UE);
  assert.equal(out.effect.type, 'SCORE');
  assert.equal(out.effect.code, 'E');
  assert.equal(out.nextEditState.phase, 'LIVE');

  // EDIT_MODE center opens PROMPT without scoring
  out = reduceEditWristInput(st, 'pause', rec42, WRIST_CENTER_MODES.EDIT_MODE);
  assert.equal(out.effect.type, 'OPEN_PROMPT');
  st = out.nextEditState;
  assert.equal(st.phase, 'PROMPT');
  assert.equal(st.baseRevision, 42);
  assert.equal(st.canUndo, true);

  // Repeated center leaves PROMPT open
  out = reduceEditWristInput(st, 'play', rec42, WRIST_CENTER_MODES.EDIT_MODE);
  assert.equal(out.effect.type, 'KEEP_PROMPT_OPEN');
  assert.equal(out.nextEditState, st);

  // Empty history PROMPT: Prev is NO_UNDO_AVAILABLE, Next is still COMMIT_UE
  const emptyRec = makeRec({ revision: 2, events: [] });
  const emptyPrompt = reduceEditWristInput(createInitialEditState(), 'pause', emptyRec, WRIST_CENTER_MODES.EDIT_MODE).nextEditState;
  assert.equal(emptyPrompt.canUndo, false);
  assert.equal(
    reduceEditWristInput(emptyPrompt, 'previoustrack', emptyRec, WRIST_CENTER_MODES.EDIT_MODE).effect.type,
    'NO_UNDO_AVAILABLE'
  );
  assert.equal(
    reduceEditWristInput(emptyPrompt, 'nexttrack', emptyRec, WRIST_CENTER_MODES.EDIT_MODE).effect.type,
    'COMMIT_UE'
  );

  // Prev on non-empty PROMPT emits COMMIT_UNDO pinned to rev 42
  out = reduceEditWristInput(st, 'previoustrack', rec42, WRIST_CENTER_MODES.EDIT_MODE);
  assert.equal(out.effect.type, 'COMMIT_UNDO');
  assert.equal(out.effect.expectedRevision, 42);

  // Own commit reconciles to AWAITING_LIVE(UNDO, #43)
  const rec43 = makeRec({ revision: 43, events: [] });
  st = reconcileEditStateAfterRecordChange(st, rec43, { ownCommitReason: 'UNDO' });
  assert.equal(st.phase, 'AWAITING_LIVE');
  assert.equal(st.reason, 'UNDO');
  assert.equal(st.baseRevision, 43);

  // Repeated arrows in AWAITING_LIVE are consumed without scoring
  assert.equal(
    reduceEditWristInput(st, 'previoustrack', rec43, WRIST_CENTER_MODES.EDIT_MODE).effect.type,
    'CONSUME_ARROW'
  );
  assert.equal(
    reduceEditWristInput(st, 'nexttrack', rec43, WRIST_CENTER_MODES.EDIT_MODE).effect.type,
    'CONSUME_ARROW'
  );

  // Center returns to LIVE even if wristCenterMode was switched back to ONE_TAP_UE!
  out = reduceEditWristInput(st, 'pause', rec43, WRIST_CENTER_MODES.ONE_TAP_UE);
  assert.equal(out.effect.type, 'RETURN_TO_LIVE');
  assert.equal(out.nextEditState.phase, 'LIVE');
});

test('S4.2 state machine: stale revision, phone edits during PROMPT/AWAITING_LIVE, Cancel, and terminal finish', () => {
  const rec42 = makeRec();
  const rec43 = makeRec({ revision: 43 });
  const rec44 = makeRec({ revision: 44 });

  // Stale revision on arrow arrival consumes arrow and enters AWAITING_LIVE(INVALIDATED)
  const prompt42 = reduceEditWristInput(createInitialEditState(), 'pause', rec42, WRIST_CENTER_MODES.EDIT_MODE).nextEditState;
  const staleOut = reduceEditWristInput(prompt42, 'nexttrack', rec43, WRIST_CENTER_MODES.EDIT_MODE);
  assert.equal(staleOut.effect.type, 'CONSUME_STALE_ARROW');
  assert.equal(staleOut.nextEditState.phase, 'AWAITING_LIVE');
  assert.equal(staleOut.nextEditState.reason, 'INVALIDATED');
  assert.equal(staleOut.nextEditState.baseRevision, 43);

  // Phone edit during AWAITING_LIVE(UNDO, #43) updates to AWAITING_LIVE(INVALIDATED, #44)
  const confirmed43 = reconcileEditStateAfterRecordChange(prompt42, rec43, { ownCommitReason: 'UNDO' });
  const afterPhone = reconcileEditStateAfterRecordChange(confirmed43, rec44);
  assert.equal(afterPhone.phase, 'AWAITING_LIVE');
  assert.equal(afterPhone.reason, 'INVALIDATED');
  assert.equal(afterPhone.baseRevision, 44);

  // Cancel invalidates PROMPT -> AWAITING_LIVE(INVALIDATED)
  const canceled = invalidateEditToAwaitingLive(prompt42, rec42);
  assert.equal(canceled.phase, 'AWAITING_LIVE');
  assert.equal(canceled.reason, 'INVALIDATED');
  assert.equal(canceled.baseRevision, 42);

  // Terminal WON match resets to LIVE
  const wonRec = makeRec({ status: 'WON', revision: 45 });
  assert.equal(reconcileEditStateAfterRecordChange(confirmed43, wonRec).phase, 'LIVE');
});
