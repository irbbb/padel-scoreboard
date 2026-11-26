import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addPoint,
  correctInitialServer,
  createMatch,
  deriveMatchState,
  finishManual,
  undoLastPoint,
} from '../src/core/scoreEngine.js';
import { analyzeMatch } from '../src/core/matchAnalytics.js';
import {
  buildBandKeysForPhase,
  buildMatchTakeaway,
  buildScoreboardColumns,
  buildSetFlowModel,
  computePointShare,
  describeBandControls,
  formatLocalMatchDate,
  getBandGuideSteps,
  getCenterModeSummary,
  isSafeUpdateScreen,
  shouldReloadOnControllerChange,
} from '../src/app/uiHelpers.js';

function playGame(rec, winnerCode, clock) {
  let r = rec;
  for (let p = 0; p < 4; p += 1) {
    clock.t += 1000;
    r = addPoint(r, winnerCode, clock.t);
  }
  return r;
}

function playSet(rec, usGames, themGames, clock) {
  let r = rec;
  let u = 0;
  let th = 0;
  while (u < usGames || th < themGames) {
    if (u < usGames && (u <= th || th === themGames)) {
      r = playGame(r, 'A', clock);
      u += 1;
    } else {
      r = playGame(r, 'B', clock);
      th += 1;
    }
  }
  return r;
}

test('describeBandControls derives exact Band readout and keys across Setup, Warmup, Live, PROMPT, and AWAITING_LIVE', () => {
  const setupWatch = describeBandControls({
    screen: 'SETUP',
    setupInitialServer: null,
    wristCenterMode: 'EDIT_MODE',
  });
  assert.equal(setupWatch.phase, 'SETUP_WARMUP');
  assert.equal(setupWatch.title, 'WHO SERVES? #1');
  assert.equal(setupWatch.keys[0].label, 'US serves');
  assert.equal(setupWatch.keys[1].disabled, true);
  assert.equal(setupWatch.keys[2].label, 'THEM serves');
  assert.match(setupWatch.afterWarmupNote, /Edit/i);

  const setupFixed = describeBandControls({
    screen: 'SETUP',
    setupInitialServer: 1,
    setupScoringMode: 'AD',
    wristCenterMode: 'ONE_TAP_UE',
  });
  assert.equal(setupFixed.phase, 'SETUP_LIVE');
  assert.equal(setupFixed.showKeys, true);
  assert.equal(setupFixed.title, 'THEM SERVES #1');
  assert.equal(setupFixed.artist, '0-0 0-0 S0-0');
  assert.equal(setupFixed.keys[1].label, 'My error · +1 THEM');
  assert.equal(setupFixed.keys[1].tone, 'ue');

  const viewerState = describeBandControls({
    screen: 'LIVE',
    isWriter: false,
    wrist: { status: 'DISARMED' },
    wristCenterMode: 'EDIT_MODE',
    wristPreview: { title: '*30-15 2-1 #9', artist: 'S0-0 UE:1' },
    state: { status: 'ACTIVE', needsInitialServer: false },
    record: { matchId: 'm1', revision: 9, status: 'ACTIVE', events: [{ id: 1, t: 1000, code: 'A' }] },
    editState: { phase: 'LIVE' },
  });
  assert.equal(viewerState.phase, 'READ_ONLY');
  assert.equal(viewerState.showKeys, false);
  assert.equal(viewerState.keys.length, 0);

  const interruptedEdit = describeBandControls({
    screen: 'LIVE',
    isWriter: true,
    wrist: { status: 'INTERRUPTED' },
    wristCenterMode: 'EDIT_MODE',
    wristPreview: { title: 'EDIT OFF #9', artist: 'TAP || FOR LIVE' },
    state: { status: 'ACTIVE', needsInitialServer: false },
    record: { matchId: 'm1', revision: 9, status: 'ACTIVE', events: [{ id: 1, t: 1000, code: 'A' }] },
    editState: { phase: 'AWAITING_LIVE', matchId: 'm1', baseRevision: 9, reason: 'INVALIDATED' },
  });
  assert.equal(interruptedEdit.phase, 'INTERRUPTED');
  assert.equal(interruptedEdit.showKeys, false);
  assert.match(interruptedEdit.headline, /Re-link Band/i);
  assert.match(interruptedEdit.subcue, /Re-link Band/i);

  const liveWarmup = describeBandControls({
    screen: 'LIVE',
    isWriter: true,
    wrist: { status: 'ARMED' },
    wristCenterMode: 'EDIT_MODE',
    wristPreview: { title: 'WHO SERVES? #1', artist: '< US   THEM >' },
    state: { status: 'ACTIVE', needsInitialServer: true },
    record: { matchId: 'm1', revision: 1, status: 'ACTIVE', events: [] },
    editState: { phase: 'LIVE' },
  });
  assert.equal(liveWarmup.phase, 'WARMUP');
  assert.equal(liveWarmup.showKeys, true);
  assert.equal(liveWarmup.keys[1].disabled, true);

  const liveEditMode = describeBandControls({
    screen: 'LIVE',
    isWriter: true,
    wrist: { status: 'ARMED' },
    wristCenterMode: 'EDIT_MODE',
    wristPreview: { title: '*30-15 2-1 #9', artist: 'S0-0 UE:1' },
    state: { status: 'ACTIVE', needsInitialServer: false },
    record: { matchId: 'm1', revision: 9, status: 'ACTIVE', events: [{ id: 1, t: 1000, code: 'A' }] },
    editState: { phase: 'LIVE' },
  });
  assert.equal(liveEditMode.phase, 'LIVE');
  assert.equal(liveEditMode.keys[1].label, 'Edit point');

  const promptZero = describeBandControls({
    screen: 'LIVE',
    isWriter: true,
    wrist: { status: 'ARMED' },
    wristCenterMode: 'EDIT_MODE',
    wristPreview: { title: 'EDIT #2', artist: 'NO UNDO UE>' },
    state: { status: 'ACTIVE', needsInitialServer: false },
    record: { matchId: 'm1', revision: 2, status: 'ACTIVE', events: [] },
    editState: { phase: 'PROMPT', matchId: 'm1', baseRevision: 2, canUndo: false, reason: null },
  });
  assert.equal(promptZero.phase, 'PROMPT');
  assert.equal(promptZero.keys[0].disabled, true);
  assert.equal(promptZero.keys[0].label, 'Undo unavailable');
  assert.equal(promptZero.keys[2].disabled, false);

  const awaitingUe = describeBandControls({
    screen: 'LIVE',
    isWriter: true,
    wrist: { status: 'ARMED' },
    wristCenterMode: 'EDIT_MODE',
    wristPreview: { title: 'UE *30-30 #10', artist: 'TAP || FOR LIVE' },
    state: { status: 'ACTIVE', needsInitialServer: false },
    record: { matchId: 'm1', revision: 10, status: 'ACTIVE', events: [{ id: 1, t: 1000, code: 'E' }] },
    editState: { phase: 'AWAITING_LIVE', matchId: 'm1', baseRevision: 10, canUndo: false, reason: 'UE' },
  });
  assert.equal(awaitingUe.phase, 'AWAITING_LIVE');
  assert.equal(awaitingUe.headline, 'Press || to resume scoring');
  assert.equal(awaitingUe.emphasis, 'resume');
  assert.equal(awaitingUe.keys[0].disabled, true);
  assert.equal(awaitingUe.keys[1].highlight, true);
  assert.equal(awaitingUe.keys[1].label, 'Resume scoring');
  assert.equal(awaitingUe.keys[2].disabled, true);
});

test('getBandGuideSteps shares buildBandKeysForPhase and shows warmup ONLY when showWarmupStep=true', () => {
  const editWithWarmup = getBandGuideSteps('EDIT_MODE', { showWarmupStep: true });
  assert.equal(editWithWarmup.length, 4);
  assert.match(editWithWarmup[0].bandTitle, /WHO SERVES\?/);
  assert.deepEqual(editWithWarmup[0].keys, buildBandKeysForPhase('WARMUP', { wristCenterMode: 'EDIT_MODE' }));
  assert.deepEqual(editWithWarmup[3].keys, buildBandKeysForPhase('AWAITING_LIVE', { wristCenterMode: 'EDIT_MODE' }));

  const editFixed = getBandGuideSteps('EDIT_MODE', { showWarmupStep: false });
  assert.equal(editFixed.length, 3);
  assert.doesNotMatch(editFixed[0].bandTitle, /WHO SERVES\?/);
  assert.deepEqual(editFixed[0].keys, buildBandKeysForPhase('LIVE', { wristCenterMode: 'EDIT_MODE' }));

  const oneTapFixed = getBandGuideSteps('ONE_TAP_UE', { showWarmupStep: false });
  assert.equal(oneTapFixed.length, 3);
  assert.deepEqual(oneTapFixed[0].keys, buildBandKeysForPhase('LIVE', { wristCenterMode: 'ONE_TAP_UE' }));
  assert.doesNotMatch(oneTapFixed[1].caption, /EDIT #rev/);
});

test('computePointShare guards 0-point denominators and separates US / Other THEM / My UEs', () => {
  const zero = computePointShare({ ourPoints: 0, themOtherPoints: 0, myUePoints: 0 });
  assert.equal(zero.totalPoints, 0);
  assert.equal(zero.uePctOfLost, null);

  const mix = computePointShare({ ourPoints: 10, themOtherPoints: 6, myUePoints: 4 });
  assert.equal(mix.totalPoints, 20);
  assert.equal(mix.usPct, 50);
  assert.equal(mix.themOtherPct, 30);
  assert.equal(mix.myUePct, 20);
  assert.equal(mix.uePctOfLost, 0.4);
});

test('buildScoreboardColumns & buildSetFlowModel cover all 9 padel edge cases cleanly', () => {
  const T0 = Date.UTC(2026, 5, 1, 20, 0, 0);

  // 1. Ended early with 0 points -> fallback S1 0-0, empty Set Flow, no serve dot
  const emptyRec = finishManual(
    createMatch({ matchId: 'm-empty', nowMs: T0, config: { scoringMode: 'AD', initialServer: null } }),
    T0 + 5000
  );
  const emptyAna = analyzeMatch(emptyRec, T0 + 5000);
  const emptyBoard = buildScoreboardColumns(emptyAna.summary);
  assert.equal(emptyBoard.cols.length, 1);
  assert.equal(emptyBoard.cols[0].label, 'S1');
  assert.equal(emptyBoard.cols[0].us, 0);
  assert.equal(emptyBoard.showPoints, false);
  assert.equal(emptyBoard.activeServer, null);
  assert.equal(buildSetFlowModel(emptyAna).isEmpty, true);
  assert.equal(buildMatchTakeaway(emptyAna), 'No points recorded yet.');

  // 2. Golden Point at 40-40 decided by MY UE ('E') -> GP label & break tracked
  let gpRec = createMatch({ matchId: 'm-gp', nowMs: T0, config: { scoringMode: 'GP', initialServer: 0 } });
  let t = T0;
  for (const code of ['A', 'B', 'A', 'B', 'A', 'B', 'E']) {
    t += 1000;
    gpRec = addPoint(gpRec, code, t);
  }
  gpRec = finishManual(gpRec, t + 1000);
  const gpAna = analyzeMatch(gpRec, t + 1000);
  const gpFlow = buildSetFlowModel(gpAna);
  assert.equal(gpFlow.sets.length, 1);
  assert.equal(gpFlow.sets[0].games.length, 1);
  const gpGame = gpFlow.sets[0].games[0];
  assert.equal(gpGame.isIncomplete, false);
  assert.equal(gpGame.isBreak, true);
  assert.equal(gpGame.ueCount, 1);
  assert.equal(gpGame.points[gpGame.points.length - 1].themLabel, 'GP');
  assert.equal(gpGame.points[gpGame.points.length - 1].usLabel, '·');

  // 3. Advantage with three deuces (AD-40 -> 40-40 labeled 'D', unlimited UEs counted)
  let adRec = createMatch({ matchId: 'm-ad', nowMs: T0, config: { scoringMode: 'AD', initialServer: 0 } });
  t = T0;
  // 40-40 (A,E,A,E,A,E), then 3 deuce cycles: AD-40(A)->D(E), 40-AD(E)->D(A), AD-40(A)->D(E), then THEM wins (E,B)
  const adSeq = ['A', 'E', 'A', 'E', 'A', 'E', 'A', 'E', 'E', 'A', 'A', 'E', 'E', 'B'];
  for (const code of adSeq) {
    t += 1000;
    adRec = addPoint(adRec, code, t);
  }
  adRec = finishManual(adRec, t + 1000);
  const adFlow = buildSetFlowModel(analyzeMatch(adRec, t + 1000));
  const adPts = adFlow.sets[0].games[0].points;
  assert.equal(adFlow.sets[0].games[0].ueCount, 7); // scales beyond 3 cleanly!
  assert.equal(adPts[7].themLabel, 'D'); // AD-40 -> 40-40 by THEM (E)
  assert.equal(adPts[9].usLabel, 'D'); // 40-AD -> 40-40 by US (A)
  assert.equal(adPts[11].themLabel, 'D'); // AD-40 -> 40-40 by THEM (E)
  assert.equal(adPts[13].themLabel, 'G');

  // 4. 7-6 with a 10-8 tie-break -> TB label, tieBreakPoints from setHistory, server=null, isBreak=false
  const clock4 = { t: T0 };
  let tbRec = createMatch({ matchId: 'm-tb10', nowMs: T0, config: { scoringMode: 'GP', initialServer: 0 } });
  tbRec = playSet(tbRec, 6, 6, clock4);
  // Alternate points to 8-8, then US wins 10-8
  for (let i = 0; i < 8; i += 1) {
    tbRec = addPoint(tbRec, 'A', (clock4.t += 1000));
    tbRec = addPoint(tbRec, 'E', (clock4.t += 1000));
  }
  tbRec = addPoint(tbRec, 'A', (clock4.t += 1000));
  tbRec = addPoint(tbRec, 'A', (clock4.t += 1000));
  // 5. Ended early at 0-0 straight after Set 1 -> NO S2 column, NO empty game!
  tbRec = finishManual(tbRec, (clock4.t += 1000));
  const tbAna = analyzeMatch(tbRec, clock4.t);
  const tbBoard = buildScoreboardColumns(tbAna.summary);
  assert.equal(tbBoard.cols.length, 1);
  assert.equal(tbBoard.cols[0].us, 7);
  assert.equal(tbBoard.cols[0].them, 6);
  assert.equal(tbBoard.cols[0].themSup, 8);
  assert.equal(tbBoard.cols[0].usSup, null);
  assert.equal(tbBoard.showPoints, false);

  const tbFlow = buildSetFlowModel(tbAna);
  assert.equal(tbFlow.sets.length, 1);
  assert.equal(tbFlow.sets[0].games.length, 13);
  const tbGame = tbFlow.sets[0].games[12];
  assert.equal(tbGame.label, 'TB');
  assert.equal(tbGame.isTieBreak, true);
  assert.equal(tbGame.server, null);
  assert.equal(tbGame.isBreak, false);
  assert.equal(tbGame.tbScoreText, '10–8');
  assert.equal(tbGame.ueCount, 8);
  assert.equal(tbGame.points[tbGame.points.length - 1].usLabel, '10');
  assert.equal(tbGame.points[tbGame.points.length - 1].themLabel, '8');

  // 6. Ended early in the middle of a tie-break -> pointsHeader='TB', incomplete TB game
  const clock6 = { t: T0 };
  let midTbRec = createMatch({ matchId: 'm-midtb', nowMs: T0, config: { scoringMode: 'GP', initialServer: 0 } });
  midTbRec = playSet(midTbRec, 6, 6, clock6);
  midTbRec = addPoint(midTbRec, 'A', (clock6.t += 1000));
  midTbRec = addPoint(midTbRec, 'E', (clock6.t += 1000));
  midTbRec = addPoint(midTbRec, 'A', (clock6.t += 1000));
  // Active check first: TB header + live serve dot
  const activeMidState = deriveMatchState(midTbRec, clock6.t);
  const activeMidBoard = buildScoreboardColumns(activeMidState);
  assert.equal(activeMidBoard.pointsHeader, 'TB');
  assert.equal(activeMidBoard.showPoints, true);
  assert.notEqual(activeMidBoard.activeServer, null);

  midTbRec = finishManual(midTbRec, (clock6.t += 1000));
  const midTbAna = analyzeMatch(midTbRec, clock6.t);
  const midTbBoard = buildScoreboardColumns(midTbAna.summary);
  assert.equal(midTbBoard.pointsHeader, 'TB');
  assert.equal(midTbBoard.showPoints, true);
  assert.equal(midTbBoard.activeServer, null);
  const midTbFlow = buildSetFlowModel(midTbAna);
  assert.equal(midTbFlow.sets[0].games[12].isTieBreak, true);
  assert.equal(midTbFlow.sets[0].games[12].isIncomplete, true);
  assert.equal(midTbFlow.sets[0].games[12].winner, null);
  assert.equal(midTbFlow.sets[0].games[12].tbScoreText, '2–1');

  // 7. Won in 2 sets -> NO bogus S3 0-0 column, activeServer=null
  const clock7 = { t: T0 };
  let win2Rec = createMatch({ matchId: 'm-win2', nowMs: T0, config: { scoringMode: 'GP', initialServer: 0 } });
  win2Rec = playSet(win2Rec, 6, 3, clock7);
  win2Rec = playSet(win2Rec, 6, 4, clock7);
  const win2Ana = analyzeMatch(win2Rec, clock7.t);
  const win2Board = buildScoreboardColumns(win2Ana.summary);
  assert.equal(win2Board.cols.length, 2);
  assert.equal(win2Board.showPoints, false);
  assert.equal(win2Board.activeServer, null);

  // 8. Won in 3 sets -> S1, S2, S3
  const clock8 = { t: T0 };
  let win3Rec = createMatch({ matchId: 'm-win3', nowMs: T0, config: { scoringMode: 'GP', initialServer: 0 } });
  win3Rec = playSet(win3Rec, 6, 4, clock8);
  win3Rec = playSet(win3Rec, 3, 6, clock8);
  win3Rec = playSet(win3Rec, 6, 2, clock8);
  const win3Ana = analyzeMatch(win3Rec, clock8.t);
  const win3Board = buildScoreboardColumns(win3Ana.summary);
  assert.equal(win3Board.cols.length, 3);
  assert.deepEqual(
    win3Board.cols.map((c) => `${c.label}:${c.us}-${c.them}`),
    ['S1:6-4', 'S2:3-6', 'S3:6-2']
  );

  // 9. First server corrected mid-set -> server & break flags flip cleanly on recompute
  const clock9 = { t: T0 };
  let corrRec = createMatch({ matchId: 'm-corr', nowMs: T0, config: { scoringMode: 'GP', initialServer: 0 } });
  corrRec = playGame(corrRec, 'A', clock9); // Game 1 won by US (hold when US serves)
  const beforeFlow = buildSetFlowModel(analyzeMatch(corrRec, clock9.t));
  assert.equal(beforeFlow.sets[0].games[0].server, 0);
  assert.equal(beforeFlow.sets[0].games[0].isBreak, false);

  corrRec = correctInitialServer(corrRec, 1); // Flip opener to THEM -> Game 1 is now a BREAK by US!
  const afterFlow = buildSetFlowModel(analyzeMatch(corrRec, clock9.t));
  assert.equal(afterFlow.sets[0].games[0].server, 1);
  assert.equal(afterFlow.sets[0].games[0].isBreak, true);

  // Post-Undo sequence: E undone -> A -> 0 UEs
  let undoRec = createMatch({ matchId: 'm-undo', nowMs: T0, config: { scoringMode: 'AD', initialServer: 0 } });
  undoRec = addPoint(undoRec, 'E', T0 + 1000);
  undoRec = undoLastPoint(undoRec);
  undoRec = addPoint(undoRec, 'A', T0 + 2000);
  undoRec = finishManual(undoRec, T0 + 3000);
  const undoFlow = buildSetFlowModel(analyzeMatch(undoRec, T0 + 3000));
  assert.equal(undoFlow.sets[0].games[0].ueCount, 0);
  assert.equal(undoFlow.sets[0].games[0].points.length, 1);
});

test('formatLocalMatchDate handles Today, Yesterday, same year, older year, DST boundaries, and invalid dates', () => {
  const now = new Date(2026, 10, 26, 19, 30).getTime(); // Nov 26, 2026 19:30 local
  const today = new Date(2026, 10, 26, 8, 5).getTime();
  const yesterday = new Date(2026, 10, 25, 22, 15).getTime();
  const earlierSameYear = new Date(2026, 9, 12, 18, 40).getTime();
  const prevYear = new Date(2025, 11, 31, 23, 59).getTime();

  assert.equal(formatLocalMatchDate(today, now), 'Today 08:05');
  assert.equal(formatLocalMatchDate(yesterday, now), 'Yesterday 22:15');
  assert.equal(formatLocalMatchDate(earlierSameYear, now), 'Oct 12 18:40');
  assert.equal(formatLocalMatchDate(prevYear, now), 'Dec 31, 2025 23:59');
  assert.equal(formatLocalMatchDate(NaN, now), 'Undated');
  assert.equal(formatLocalMatchDate(null, now), 'Undated');
});

test('getCenterModeSummary and SW update helpers guard live screens and controller swaps', () => {
  assert.match(getCenterModeSummary('EDIT_MODE'), /Undo or My Error/i);
  assert.match(getCenterModeSummary('ONE_TAP_UE'), /unforced error/i);

  assert.equal(isSafeUpdateScreen('SETUP'), true);
  assert.equal(isSafeUpdateScreen('MATCH_OVER'), true);
  assert.equal(isSafeUpdateScreen('HISTORY'), true);
  assert.equal(isSafeUpdateScreen('HISTORY_DETAIL'), true);
  assert.equal(isSafeUpdateScreen('LIVE'), false);
  assert.equal(isSafeUpdateScreen('LOADING'), false);
  assert.equal(isSafeUpdateScreen('CORRUPT'), false);

  const workerA = { id: 'a' };
  const workerB = { id: 'b' };
  assert.equal(
    shouldReloadOnControllerChange({ requestedWorker: null, newController: workerA, screen: 'SETUP' }),
    false
  );
  assert.equal(
    shouldReloadOnControllerChange({ requestedWorker: workerA, newController: workerB, screen: 'SETUP' }),
    false
  );
  assert.equal(
    shouldReloadOnControllerChange({ requestedWorker: workerA, newController: workerA, screen: 'LIVE' }),
    false
  );
  assert.equal(
    shouldReloadOnControllerChange({ requestedWorker: workerA, newController: workerA, screen: 'SETUP' }),
    true
  );
});
