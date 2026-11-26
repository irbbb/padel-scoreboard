import test from 'node:test';
import assert from 'node:assert/strict';
import { addPoint, createMatch, finishManual, undoLastPoint } from '../src/core/scoreEngine.js';
import { analyzeMatch } from '../src/core/matchAnalytics.js';
import {
  buildMatchTapeData,
  computePointShare,
  describeBandControls,
  getBandGuideSteps,
  getCenterModeSummary,
  isSafeUpdateScreen,
  renderMatchTapeSvg,
  shouldReloadOnControllerChange,
  TAPE_BIN_COUNT,
  TAPE_VIEWBOX_HEIGHT,
  TAPE_VIEWBOX_WIDTH,
} from '../src/app/uiHelpers.js';

test('describeBandControls derives exact Band readout and keys across Setup, Warmup, Live, PROMPT, and AWAITING_LIVE', () => {
  // Setup: Pick on Band + EDIT_MODE (default)
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

  // Setup: Fixed opener + ONE_TAP_UE matches authoritative formatWristDisplay output verbatim
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

  // Read-only viewer never shows live actionable Band key assignments
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

  // Interrupted writer during Edit leads with Re-link Band first (never actionable keys before re-link)
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

  // Live: Warmup awaiting server (armed writer)
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
  assert.equal(liveWarmup.title, 'WHO SERVES? #1');
  assert.equal(liveWarmup.artist, '< US   THEM >');
  assert.equal(liveWarmup.keys[1].disabled, true);

  // Live: Normal scoring in EDIT_MODE keeps tested wrist lines verbatim
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
  assert.equal(liveEditMode.showKeys, true);
  assert.equal(liveEditMode.title, '*30-15 2-1 #9');
  assert.equal(liveEditMode.artist, 'S0-0 UE:1');
  assert.equal(liveEditMode.keys[1].label, 'Edit point');

  // Live: EDIT PROMPT at 0 points marks Undo as disabled
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

  // Live: AWAITING_LIVE makes "Press || to resume scoring" primary and pauses both arrows
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

test('getBandGuideSteps shows warmup picker ONLY when showWarmupStep=true and uses player-facing Edit point name', () => {
  const editWithWarmup = getBandGuideSteps('EDIT_MODE', { showWarmupStep: true });
  assert.equal(editWithWarmup.length, 4);
  assert.match(editWithWarmup[0].bandTitle, /WHO SERVES\?/);
  assert.match(editWithWarmup[3].title, /Press \|\| to resume/i);

  // Fixed or already-selected server omits warmup picker so player never awards an unintended point
  const editFixed = getBandGuideSteps('EDIT_MODE', { showWarmupStep: false });
  assert.equal(editFixed.length, 3);
  assert.doesNotMatch(editFixed[0].bandTitle, /WHO SERVES\?/);
  assert.match(editFixed[0].title, /Score normal rallies/i);
  assert.match(editFixed[2].title, /Press \|\| to resume/i);

  const oneTapFixed = getBandGuideSteps('ONE_TAP_UE', { showWarmupStep: false });
  assert.equal(oneTapFixed.length, 3);
  assert.doesNotMatch(oneTapFixed[0].bandTitle, /WHO SERVES\?/);
  assert.match(oneTapFixed[0].title, /1 tap/i);
  assert.match(oneTapFixed[1].caption, /Edit point/);
  assert.doesNotMatch(oneTapFixed[1].caption, /EDIT #rev/);
});

test('computePointShare guards 0-point denominators and separates US / Other THEM / My UEs', () => {
  const zero = computePointShare({ ourPoints: 0, themOtherPoints: 0, myUePoints: 0 });
  assert.equal(zero.totalPoints, 0);
  assert.equal(zero.usPct, 0);
  assert.equal(zero.uePctOfLost, null);

  const oneUe = computePointShare({ ourPoints: 0, themOtherPoints: 0, myUePoints: 1 });
  assert.equal(oneUe.totalPoints, 1);
  assert.equal(oneUe.myUePct, 100);
  assert.equal(oneUe.uePctOfLost, 1);

  const mix = computePointShare({ ourPoints: 10, themOtherPoints: 6, myUePoints: 4 });
  assert.equal(mix.totalPoints, 20);
  assert.equal(mix.usPct, 50);
  assert.equal(mix.themOtherPct, 30);
  assert.equal(mix.myUePct, 20);
  assert.equal(mix.uePctOfLost, 0.4);
});

test('Match Tape handles 0 points, 1 E point, post-undo sequence, mid-tiebreak manual finish, tiebreak set win, and 320-point dense match', () => {
  const T0 = Date.UTC(2026, 5, 1, 20, 0, 0);

  // 1. Zero points
  const emptyRec = finishManual(
    createMatch({ matchId: 'm-empty', nowMs: T0, config: { scoringMode: 'AD', initialServer: null } }),
    T0 + 5000
  );
  const emptyAna = analyzeMatch(emptyRec, T0 + 5000);
  assert.equal(buildMatchTapeData(emptyAna).isEmpty, true);
  assert.match(renderMatchTapeSvg(emptyAna), /No points recorded/);

  // 2. Single E point -> centered mark, distinct diamond polygon, no NaN
  let oneRec = createMatch({ matchId: 'm-one', nowMs: T0, config: { scoringMode: 'AD', initialServer: 0 } });
  oneRec = addPoint(oneRec, 'E', T0 + 2000);
  oneRec = finishManual(oneRec, T0 + 5000);
  const oneAna = analyzeMatch(oneRec, T0 + 5000);
  const oneData = buildMatchTapeData(oneAna);
  assert.equal(oneData.isEmpty, false);
  assert.equal(oneData.marks.length, 1);
  assert.equal(oneData.marks[0].cx, TAPE_VIEWBOX_WIDTH / 2);
  const oneSvg = renderMatchTapeSvg(oneAna);
  assert.ok(oneSvg.includes('<polygon'));
  assert.ok(!oneSvg.includes('NaN'));

  // 3. Post-undo effective sequence: score E, undo, score A -> only A plotted
  let undoRec = createMatch({ matchId: 'm-undo', nowMs: T0, config: { scoringMode: 'AD', initialServer: 0 } });
  undoRec = addPoint(undoRec, 'E', T0 + 1000);
  undoRec = undoLastPoint(undoRec);
  undoRec = addPoint(undoRec, 'A', T0 + 2000);
  undoRec = finishManual(undoRec, T0 + 3000);
  const undoData = buildMatchTapeData(analyzeMatch(undoRec, T0 + 3000));
  assert.equal(undoData.totalPoints, 1);
  assert.equal(undoData.usPoints, 1);
  assert.equal(undoData.myUePoints, 0);
  assert.equal(undoData.marks[0].kind, 'A');

  // 4. Mid-tiebreak manual finish: Set 1 goes to 6-6, 4 TB points played, stopped manually -> 0 dividers, open S1
  let tbStopRec = createMatch({ matchId: 'm-tb-stop', nowMs: T0, config: { scoringMode: 'GP', initialServer: 0 } });
  let t = T0;
  for (let g = 0; g < 6; g += 1) {
    for (let p = 0; p < 4; p += 1) tbStopRec = addPoint(tbStopRec, 'A', (t += 1000));
    for (let p = 0; p < 4; p += 1) tbStopRec = addPoint(tbStopRec, 'B', (t += 1000));
  }
  tbStopRec = addPoint(tbStopRec, 'A', (t += 1000));
  tbStopRec = addPoint(tbStopRec, 'E', (t += 1000));
  tbStopRec = finishManual(tbStopRec, (t += 1000));
  const tbStopData = buildMatchTapeData(analyzeMatch(tbStopRec, t));
  assert.equal(tbStopData.setDividers.length, 0);
  assert.equal(tbStopData.setLabels.length, 1);
  assert.equal(tbStopData.setLabels[0].label, 'S1');

  // 5. Tiebreak completed into Set 2 + dense 320-point match -> aggregated cleanly with exact divider & UE count
  let denseRec = createMatch({ matchId: 'm-dense', nowMs: T0, config: { scoringMode: 'AD', initialServer: 0 } });
  t = T0;
  // Set 1: 6-6 then TB 7-0 (US wins Set 1)
  for (let g = 0; g < 6; g += 1) {
    for (let p = 0; p < 4; p += 1) denseRec = addPoint(denseRec, 'A', (t += 1000));
    for (let p = 0; p < 4; p += 1) denseRec = addPoint(denseRec, 'B', (t += 1000));
  }
  for (let p = 0; p < 7; p += 1) denseRec = addPoint(denseRec, 'A', (t += 1000));
  const set1EndPts = denseRec.events.length; // 55

  // Set 2: long AD deuce marathon (> 270 points!) then finished manually
  for (let i = 0; i < 140; i += 1) {
    denseRec = addPoint(denseRec, 'A', (t += 1000));
    denseRec = addPoint(denseRec, i % 4 === 0 ? 'E' : 'B', (t += 1000));
  }
  denseRec = finishManual(denseRec, (t += 1000));
  assert.ok(denseRec.events.length > 300);

  const denseAna = analyzeMatch(denseRec, t);
  const denseData = buildMatchTapeData(denseAna);
  assert.equal(denseData.aggregated, true);
  assert.equal(denseData.marks.length, TAPE_BIN_COUNT);
  assert.equal(denseData.setDividers.length, 1);
  assert.equal(denseData.setDividers[0].afterPointNumber, set1EndPts);
  assert.equal(denseData.myUePoints, 35);
  assert.equal(
    denseData.marks.reduce((acc, m) => acc + m.ueCount, 0),
    35
  );

  const denseSvg = renderMatchTapeSvg(denseAna);
  assert.ok(denseSvg.includes(`viewBox="0 0 ${TAPE_VIEWBOX_WIDTH} ${TAPE_VIEWBOX_HEIGHT}"`));
  assert.ok(denseSvg.includes('35 My unforced errors'));
  assert.ok(denseSvg.includes('<polygon'));
  assert.ok(!denseSvg.includes('NaN'));
});

test('getCenterModeSummary and Service Worker update reload guards protect active matches and mismatched controllers', () => {
  assert.equal(getCenterModeSummary('EDIT_MODE'), 'Press || to choose Undo or My Error.');
  assert.equal(getCenterModeSummary(undefined), 'Press || to choose Undo or My Error.');
  assert.equal(
    getCenterModeSummary('ONE_TAP_UE'),
    'Press || to record my unforced error and give THEM a point.'
  );

  assert.equal(isSafeUpdateScreen('SETUP'), true);
  assert.equal(isSafeUpdateScreen('MATCH_OVER'), true);
  assert.equal(isSafeUpdateScreen('HISTORY'), true);
  assert.equal(isSafeUpdateScreen('HISTORY_DETAIL'), true);
  assert.equal(isSafeUpdateScreen('LIVE'), false);
  assert.equal(isSafeUpdateScreen('LOADING'), false);
  assert.equal(isSafeUpdateScreen('CORRUPT'), false);

  const workerV2 = { scriptURL: 'sw.js?v2' };
  const workerV3 = { scriptURL: 'sw.js?v3' };

  // Only reloads when exact requested worker became controller on a safe screen
  assert.equal(
    shouldReloadOnControllerChange({ requestedWorker: workerV2, newController: workerV2, screen: 'SETUP' }),
    true
  );
  assert.equal(
    shouldReloadOnControllerChange({ requestedWorker: workerV2, newController: workerV2, screen: 'LIVE' }),
    false
  );
  assert.equal(
    shouldReloadOnControllerChange({ requestedWorker: workerV2, newController: workerV3, screen: 'SETUP' }),
    false
  );
  assert.equal(
    shouldReloadOnControllerChange({ requestedWorker: null, newController: workerV2, screen: 'SETUP' }),
    false
  );
});
