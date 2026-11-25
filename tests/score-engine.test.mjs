import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMatch,
  deriveMatchState,
  addPoint,
  undoLastPoint,
  correctInitialServer,
  finishManual,
  resumeMatch,
  validateMatchRecord,
} from '../src/core/scoreEngine.js';

const T0 = 1_700_000_000_000;

function winGameToLove(record, code, startT) {
  let r = record;
  let t = startT;
  for (let i = 0; i < 4; i += 1) {
    t += 5_000;
    r = addPoint(r, code, t);
  }
  return { record: r, t };
}

function winSetSixZero(record, code, startT) {
  let r = record;
  let t = startT;
  for (let g = 0; g < 6; g += 1) {
    ({ record: r, t } = winGameToLove(r, code, t));
  }
  return { record: r, t };
}

function playToSixAll(record, startT) {
  let r = record;
  let t = startT;
  for (let g = 0; g < 6; g += 1) {
    ({ record: r, t } = winGameToLove(r, 'A', t));
    ({ record: r, t } = winGameToLove(r, 'B', t));
  }
  return { record: r, t };
}

test('ordinary Golden Point game progression and deep snapshot immutability', () => {
  const inputConfig = { scoringMode: 'GP', format: 'BO3', decidingSet: 'NORMAL', initialServer: 0 };
  const m0 = createMatch({ matchId: 'gp1', config: inputConfig, nowMs: T0 });
  inputConfig.initialServer = 1; // Mutating caller object must not affect match

  assert.equal(Object.isFrozen(m0), true);
  assert.equal(Object.isFrozen(m0.config), true);
  assert.equal(Object.isFrozen(m0.events), true);
  assert.equal(deriveMatchState(m0, T0).server, 0);
  assert.deepEqual(deriveMatchState(m0, T0).uesPerSet, []);

  // Attempting to mutate frozen config or event throws in strict mode
  assert.throws(() => {
    m0.config.initialServer = 1;
  }, TypeError);

  let m = addPoint(m0, 'E', T0 + 1000);
  assert.equal(Object.isFrozen(m.events[0]), true);
  assert.throws(() => {
    m.events[0].code = 'A';
  }, TypeError);

  // Successive snapshots stay isolated (modifying a newer record via commands never alters older snapshot)
  const mCorrected = correctInitialServer(m, 1);
  assert.equal(deriveMatchState(m, T0 + 1000).server, 0);
  assert.equal(deriveMatchState(m, T0 + 1000).uesWhileServing, 1);
  assert.equal(deriveMatchState(mCorrected, T0 + 1000).server, 1);
  assert.equal(deriveMatchState(mCorrected, T0 + 1000).uesWhileReceiving, 1);

  // Golden Point 40-40 -> next point wins
  let mg = createMatch({ matchId: 'gp2', config: { initialServer: 0 }, nowMs: T0 });
  mg = addPoint(mg, 'A', T0 + 1000);
  mg = addPoint(mg, 'A', T0 + 2000);
  mg = addPoint(mg, 'A', T0 + 3000);
  mg = addPoint(mg, 'B', T0 + 4000);
  mg = addPoint(mg, 'B', T0 + 5000);
  mg = addPoint(mg, 'B', T0 + 6000);
  assert.deepEqual(deriveMatchState(mg, T0 + 6000).pointsLabel, ['40', '40']);
  assert.deepEqual(deriveMatchState(mg, T0 + 6000).uesPerSet, [0]);

  mg = addPoint(mg, 'A', T0 + 7000);
  const s = deriveMatchState(mg, T0 + 7000);
  assert.deepEqual(s.games, [1, 0]);
  assert.deepEqual(s.pointsLabel, ['0', '0']);
  assert.equal(s.server, 1);
  assert.equal(s.changeEndsAlert, true);
});

test('set completion boundaries: 6-3 (alert), 6-4 (no alert), 6-5 continues, 7-5 (no alert), 6-6 enters TB (no alert)', () => {
  let m63 = createMatch({ matchId: 's63', config: { initialServer: 0 }, nowMs: T0 });
  let t = T0;
  for (let g = 0; g < 3; g += 1) {
    ({ record: m63, t } = winGameToLove(m63, 'A', t));
    ({ record: m63, t } = winGameToLove(m63, 'B', t));
  }
  for (let g = 0; g < 3; g += 1) {
    ({ record: m63, t } = winGameToLove(m63, 'A', t));
  }
  const s63 = deriveMatchState(m63, t);
  assert.deepEqual(s63.sets, [1, 0]);
  assert.deepEqual(s63.setHistory[0].games, [6, 3]);
  assert.equal(s63.changeEndsAlert, true);
  assert.deepEqual(s63.uesPerSet, [0]);

  m63 = addPoint(m63, 'A', t + 5000);
  const s63Next = deriveMatchState(m63, t + 5000);
  assert.equal(s63Next.changeEndsAlert, false);
  assert.deepEqual(s63Next.uesPerSet, [0, 0]);

  let m64 = createMatch({ matchId: 's64', config: { initialServer: 0 }, nowMs: T0 });
  t = T0;
  for (let g = 0; g < 4; g += 1) {
    ({ record: m64, t } = winGameToLove(m64, 'A', t));
    ({ record: m64, t } = winGameToLove(m64, 'B', t));
  }
  ({ record: m64, t } = winGameToLove(m64, 'A', t));
  ({ record: m64, t } = winGameToLove(m64, 'A', t));
  assert.equal(deriveMatchState(m64, t).changeEndsAlert, false);

  let m75 = createMatch({ matchId: 's75', config: { initialServer: 0 }, nowMs: T0 });
  t = T0;
  for (let g = 0; g < 5; g += 1) {
    ({ record: m75, t } = winGameToLove(m75, 'A', t));
    ({ record: m75, t } = winGameToLove(m75, 'B', t));
  }
  ({ record: m75, t } = winGameToLove(m75, 'A', t)); // 6-5 continues
  assert.deepEqual(deriveMatchState(m75, t).sets, [0, 0]);
  assert.deepEqual(deriveMatchState(m75, t).games, [6, 5]);
  assert.equal(deriveMatchState(m75, t).changeEndsAlert, true);

  ({ record: m75, t } = winGameToLove(m75, 'A', t)); // 7-5 wins, no alert
  assert.deepEqual(deriveMatchState(m75, t).setHistory[0].games, [7, 5]);
  assert.equal(deriveMatchState(m75, t).changeEndsAlert, false);
});

test('mirrored tie-break service order, 6-point alerts, marathon 15-13 TB, and post-TB receiver opens next set', () => {
  for (const opener of [0, 1]) {
    const other = opener === 0 ? 1 : 0;
    const base = createMatch({ matchId: `tb-${opener}`, config: { initialServer: opener }, nowMs: T0 });
    let { record: m, t } = playToSixAll(base, T0);

    let s = deriveMatchState(m, t);
    assert.equal(s.inTieBreak, true);
    assert.equal(s.changeEndsAlert, false);
    assert.equal(s.server, opener);

    const expectedServersBeforeNext = [other, other, opener, opener, other, other, opener];
    for (let i = 0; i < expectedServersBeforeNext.length; i += 1) {
      t += 2000;
      m = addPoint(m, i % 2 === 0 ? 'A' : 'B', t);
      s = deriveMatchState(m, t);
      assert.equal(s.server, expectedServersBeforeNext[i], `after TB pt ${i + 1} (opener=${opener})`);
      assert.equal(s.changeEndsAlert, (i + 1) % 6 === 0);
    }

    // Play out to 14-13 live, then 15-13 closes set 7-6
    m = addPoint(m, 'B', (t += 2000)); // 4-4
    for (let i = 0; i < 9; i += 1) {
      m = addPoint(m, 'A', (t += 2000));
      m = addPoint(m, 'B', (t += 2000));
    }
    m = addPoint(m, 'A', (t += 2000)); // 14-13 live
    assert.equal(deriveMatchState(m, t).inTieBreak, true);
    assert.deepEqual(deriveMatchState(m, t).pointsLabel, ['14', '13']);

    m = addPoint(m, 'A', (t += 2000)); // 15-13 -> wins set 7-6
    s = deriveMatchState(m, t);
    assert.equal(s.inTieBreak, false);
    assert.deepEqual(s.setHistory[0].games, [7, 6]);
    assert.deepEqual(s.setHistory[0].tieBreakPoints, [15, 13]);
    assert.equal(s.changeEndsAlert, true);
    assert.equal(s.server, other);
  }
});

test('3rd-set deciding tie-break for both openers and both winners, Undo restores live TB, and WON rejects correctInitialServer', () => {
  for (const opener of [0, 1]) {
    for (const winCode of ['A', 'B']) {
      let m = createMatch({ matchId: `s3-${opener}-${winCode}`, config: { initialServer: opener }, nowMs: T0 });
      let t = T0;
      // Split sets 1-1 (6-0, 0-6)
      ({ record: m, t } = winSetSixZero(m, 'A', t));
      ({ record: m, t } = winSetSixZero(m, 'B', t));
      // Reach 6-6 in deciding 3rd set
      ({ record: m, t } = playToSixAll(m, t));

      // Play tie-break to 6-6, verify mid-TB opener correction flips serve & UE attribution
      m = addPoint(m, 'E', (t += 1000)); // 0-1 (UE)
      const preFix = deriveMatchState(m, t);
      const flipped = correctInitialServer(m, opener === 0 ? 1 : 0);
      const postFix = deriveMatchState(flipped, t);
      assert.equal(postFix.server, preFix.server === 0 ? 1 : 0);
      assert.equal(postFix.uesWhileServing, preFix.uesWhileReceiving);
      assert.equal(postFix.uesWhileReceiving, preFix.uesWhileServing);

      // Continue original match m to 6-6 in TB
      m = addPoint(m, 'A', (t += 1000)); // 1-1
      for (let i = 0; i < 5; i += 1) {
        m = addPoint(m, 'A', (t += 1000));
        m = addPoint(m, 'B', (t += 1000));
      }
      // 6-6 -> win 8-6 or 6-8
      m = addPoint(m, winCode, (t += 1000));
      m = addPoint(m, winCode, (t += 1000));

      const sEnd = deriveMatchState(m, t);
      const expectedWinner = winCode === 'A' ? 0 : 1;
      assert.equal(sEnd.status, 'WON');
      assert.equal(sEnd.winner, expectedWinner);
      assert.equal(sEnd.changeEndsAlert, false);
      assert.deepEqual(sEnd.setHistory[2].games, expectedWinner === 0 ? [7, 6] : [6, 7]);
      assert.deepEqual(sEnd.setHistory[2].tieBreakPoints, expectedWinner === 0 ? [8, 6] : [6, 8]);

      // correctInitialServer must throw on WON for BOTH opener values (0 and 1)
      assert.throws(() => correctInitialServer(m, 0), /WON/);
      assert.throws(() => correctInitialServer(m, 1), /WON/);

      // Undo restores live 3rd-set tie-break at 7-6 or 6-7
      const mUndo = undoLastPoint(m);
      const sUndo = deriveMatchState(mUndo, t);
      assert.equal(sUndo.status, 'ACTIVE');
      assert.equal(sUndo.inTieBreak, true);
      assert.equal(sUndo.winner, null);
      assert.deepEqual(sUndo.points, expectedWinner === 0 ? [7, 6] : [6, 7]);
    }
  }
});

test('7-5 tie-break ends on point 12 and emits single changeEndsAlert (suppressed on match win)', () => {
  const base = createMatch({ matchId: 'tb75', config: { initialServer: 0 }, nowMs: T0 });
  let { record: m, t } = playToSixAll(base, T0);
  for (let i = 0; i < 5; i += 1) {
    m = addPoint(m, 'A', (t += 1000));
    m = addPoint(m, 'B', (t += 1000));
  }
  m = addPoint(m, 'A', (t += 1000));
  m = addPoint(m, 'A', (t += 1000)); // 7-5 (pt 12)
  assert.equal(deriveMatchState(m, t).changeEndsAlert, true);

  for (let g = 0; g < 3; g += 1) {
    ({ record: m, t } = winGameToLove(m, 'A', t));
    ({ record: m, t } = winGameToLove(m, 'B', t));
  }
  for (let g = 0; g < 3; g += 1) {
    ({ record: m, t } = winGameToLove(m, 'A', t));
  }
  const sEnd = deriveMatchState(m, t);
  assert.equal(sEnd.status, 'WON');
  assert.equal(sEnd.changeEndsAlert, false);
});

test('canonical 90-minute manual-finish fixture (6-4 | 5-4 | 30-15) and Resume vs Undo contracts', () => {
  let m = createMatch({ matchId: 'm90', config: { initialServer: 0 }, nowMs: T0 });
  let t = T0;
  const step = (code) => {
    t += 10_000;
    m = addPoint(m, code, t);
  };

  for (let g = 0; g < 4; g += 1) {
    for (let p = 0; p < 4; p += 1) step('A');
    for (let p = 0; p < 4; p += 1) step(g === 0 && p < 2 ? 'E' : 'B');
  }
  for (let g = 0; g < 2; g += 1) for (let p = 0; p < 4; p += 1) step('A');

  for (let g = 0; g < 4; g += 1) {
    for (let p = 0; p < 4; p += 1) step('A');
    for (let p = 0; p < 4; p += 1) step(g === 0 && p === 0 ? 'E' : 'B');
  }
  for (let p = 0; p < 4; p += 1) step('A');

  step('A');
  step('A');
  step('B');

  const finishAt = T0 + 5_400_000;
  m = finishManual(m, finishAt);
  const s = deriveMatchState(m, finishAt);
  assert.equal(s.status, 'FINISHED_MANUAL');
  assert.equal(s.winner, null);
  assert.equal(s.changeEndsAlert, false);
  assert.deepEqual(s.setHistory[0].games, [6, 4]);
  assert.deepEqual(s.games, [5, 4]);
  assert.deepEqual(s.pointsLabel, ['30', '15']);
  assert.equal(s.counts.ourPoints, 46);
  assert.equal(s.counts.themOtherPoints, 30);
  assert.equal(s.counts.myUePoints, 3);
  assert.equal(s.counts.theirPoints, 33);
  assert.deepEqual(s.uesPerSet, [2, 1]);
  assert.equal(s.durationSec, 5400);

  assert.throws(() => undoLastPoint(m), /resumeMatch/);
  const revBeforeResume = m.revision;
  m = resumeMatch(m);
  assert.equal(m.status, 'ACTIVE');
  assert.equal(m.finishTimeMs, null);
  assert.equal(m.events.length, 79);
  assert.equal(m.revision, revBeforeResume + 1);
  assert.equal(deriveMatchState(m, finishAt + 60_900).durationSec, 5460);
});

test('winning point -> Undo -> winning point again keeps fresh event ID and 3 successive revisions', () => {
  let m = createMatch({ matchId: 'win-undo', config: { initialServer: 0 }, nowMs: T0 });
  let t = T0;
  for (let g = 0; g < 11; g += 1) {
    ({ record: m, t } = winGameToLove(m, 'A', t));
  }
  m = addPoint(m, 'A', (t += 1000));
  m = addPoint(m, 'A', (t += 1000));
  m = addPoint(m, 'A', (t += 1000));
  const revBeforeWin = m.revision;
  const idBeforeWin = m.nextEventId;

  m = addPoint(m, 'A', (t += 1000));
  assert.equal(m.status, 'WON');
  assert.equal(m.revision, revBeforeWin + 1);
  const firstWinEventId = m.events[m.events.length - 1].id;
  assert.equal(firstWinEventId, idBeforeWin);

  m = undoLastPoint(m);
  assert.equal(m.status, 'ACTIVE');
  assert.equal(m.finishTimeMs, null);
  assert.equal(m.revision, revBeforeWin + 2);
  assert.equal(m.nextEventId, idBeforeWin + 1);

  m = addPoint(m, 'A', (t += 1000));
  assert.equal(m.status, 'WON');
  assert.equal(m.revision, revBeforeWin + 3);
  assert.equal(m.events[m.events.length - 1].id, firstWinEventId + 1);
  assert.deepEqual(deriveMatchState(m, t).sets, [2, 0]);
});

test('1-event [E] denominator, point -> Undo -> different point -> JSON reload, and backwards clock clamping', () => {
  let m = createMatch({ matchId: 'rev-test', config: { initialServer: 0 }, nowMs: T0 });
  assert.strictEqual(undoLastPoint(m), m);

  m = addPoint(m, 'E', T0 + 10_000);
  const s1 = deriveMatchState(m, T0 + 10_000);
  assert.equal(s1.counts.ourPoints, 0);
  assert.equal(s1.counts.theirPoints, 1);
  assert.equal(s1.counts.myUePoints, 1);
  assert.equal(s1.myUePctOfPointsLost, 1);

  m = undoLastPoint(m);
  assert.equal(deriveMatchState(m, T0 + 11_000).myUePctOfPointsLost, null);

  m = addPoint(m, 'B', T0 + 20_000);
  const reloaded = validateMatchRecord(JSON.parse(JSON.stringify(m)));
  assert.equal(Object.isFrozen(reloaded), true);
  assert.equal(Object.isFrozen(reloaded.events[0]), true);

  const sReload = deriveMatchState(reloaded, T0 - 5000);
  assert.equal(sReload.revision, 4);
  assert.equal(reloaded.events[0].id, 2);
  assert.equal(reloaded.events[0].t, T0 + 20_000);
  assert.equal(sReload.counts.themOtherPoints, 1);
  assert.equal(sReload.counts.myUePoints, 0);
  assert.equal(sReload.durationSec, 0);
});

test('correctInitialServer enforces ACTIVE-first guard and empty FINISHED_MANUAL rejects Undo and Finish', () => {
  let m = createMatch({ matchId: 'srv-fix', config: { initialServer: 0 }, nowMs: T0 });
  assert.strictEqual(correctInitialServer(m, 0), m);

  const emptyManual = finishManual(
    createMatch({ matchId: 'empty-fin', config: { initialServer: 0 }, nowMs: T0 }),
    T0 + 5000
  );
  assert.throws(() => undoLastPoint(emptyManual), /resumeMatch/);
  assert.throws(() => correctInitialServer(emptyManual, 0), /FINISHED_MANUAL/);
  assert.throws(() => finishManual(emptyManual, T0 + 6000), /FINISHED_MANUAL/);
});

test('strict persisted-record validation rejects missing rules, mismatched WON finishTimeMs, MAX_SAFE_INTEGER overflow, trailing events, and bad IDs', () => {
  let won = createMatch({ matchId: 'imp', config: { initialServer: 0 }, nowMs: T0 });
  let t = T0;
  for (let g = 0; g < 12; g += 1) {
    ({ record: won, t } = winGameToLove(won, 'A', t));
  }

  // 1. Trailing event after win -> rejected
  assert.throws(
    () =>
      validateMatchRecord({
        ...won,
        nextEventId: won.nextEventId + 1,
        events: [...won.events, { id: won.nextEventId, t: t + 1000, code: 'A' }],
      }),
    /already won/
  );

  // 2. WON finishTimeMs differing from winning event timestamp -> rejected
  assert.throws(
    () => validateMatchRecord({ ...won, finishTimeMs: won.finishTimeMs + 1 }),
    /must equal winning event timestamp/
  );

  // 3. Status mismatch (WON marked ACTIVE) -> rejected
  assert.throws(() => validateMatchRecord({ ...won, status: 'ACTIVE', finishTimeMs: null }), /Status mismatch/);

  // 4. Missing or null config fields on persisted record -> rejected (no silent defaults!)
  let active = createMatch({ matchId: 'cfg-strict', config: { initialServer: 0 }, nowMs: T0 });
  assert.throws(
    () => validateMatchRecord({ ...active, config: { initialServer: 0 } }),
    /Unsupported P0 scoringMode/
  );
  assert.throws(
    () => validateMatchRecord({ ...active, config: { ...active.config, format: null } }),
    /Unsupported P0 format/
  );

  // 5. MAX_SAFE_INTEGER overflow guard on revision and nextEventId
  assert.throws(
    () => addPoint({ ...active, nextEventId: Number.MAX_SAFE_INTEGER }, 'A', T0 + 1000),
    /Counter overflow: nextEventId/
  );
  assert.throws(
    () => addPoint({ ...active, revision: Number.MAX_SAFE_INTEGER }, 'A', T0 + 1000),
    /Counter overflow: revision/
  );
  assert.throws(
    () => validateMatchRecord({ ...active, nextEventId: Number.MAX_SAFE_INTEGER + 1 }),
    /expected positive safe integer/
  );

  // 6. Duplicate IDs rejected, gaps valid
  active = addPoint(active, 'A', T0 + 1000);
  active = undoLastPoint(active);
  active = addPoint(active, 'A', T0 + 2000); // id=2 (gap at 1 is valid)
  assert.ok(validateMatchRecord(active));
  assert.throws(
    () =>
      validateMatchRecord({
        ...active,
        nextEventId: 5,
        events: [
          { id: 2, t: T0 + 1000, code: 'A' },
          { id: 2, t: T0 + 2000, code: 'B' },
        ],
      }),
    /strictly increase/
  );
  assert.throws(() => validateMatchRecord({ ...active, nextEventId: 2 }), /must exceed highest event id/);

  // 7. Unsupported P0 config at creation -> rejected
  assert.throws(
    () => createMatch({ matchId: 'bad-cfg', config: { scoringMode: 'AD', initialServer: 0 }, nowMs: T0 }),
    /Unsupported P0 scoringMode/
  );
});
