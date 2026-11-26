import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMatch,
  addPoint,
  finishManual,
} from '../src/core/scoreEngine.js';
import {
  analyzeMatch,
  LAST_DENSE_BUCKET_INDEX,
  WINDOW_DURATION_MS,
} from '../src/core/matchAnalytics.js';

const T0 = Date.UTC(2026, 4, 1, 18, 0, 0);

function winGameToLove(record, code, startT) {
  let r = record;
  let t = startT;
  for (let i = 0; i < 4; i += 1) {
    t += 5_000;
    r = addPoint(r, code, t);
  }
  return { record: r, t };
}

test('1-event [E] match and 0-event manual finish (including null opener) produce exact boundary analytics', () => {
  // 1-event [E]
  let m1 = createMatch({ matchId: 'one-e', config: { scoringMode: 'AD', initialServer: 0 }, nowMs: T0 });
  m1 = addPoint(m1, 'E', T0 + 10_000);
  m1 = finishManual(m1, T0 + 20_000);
  const a1 = analyzeMatch(m1);

  assert.equal(a1.summary.counts.myUePoints, 1);
  assert.equal(a1.summary.myUePctOfPointsLost, 1);
  assert.equal(a1.clutch.clutchUeTotal, 0);
  assert.equal(a1.serveReturn.serving.myUePoints, 1);
  assert.equal(a1.serveReturn.serving.uePctOfPointsLost, 1);
  assert.equal(a1.serveReturn.returning.totalPoints, 0);
  assert.equal(a1.serveReturn.returning.uePctOfPointsLost, null);
  assert.equal(a1.serviceHold.completedOrdinaryServiceGames, 0);
  assert.equal(a1.serviceHold.holdRate, null);
  assert.equal(a1.clusters.length, 0);
  assert.equal(a1.windows15m.length, 1);
  assert.equal(a1.windows15m[0].label, '0-15m');
  assert.equal(a1.windows15m[0].uePctOfPointsLost, 1);

  // 0-event manual finish with null initial server
  let m0 = createMatch({ matchId: 'zero-null', config: { scoringMode: 'AD', initialServer: null }, nowMs: T0 });
  m0 = finishManual(m0, T0 + 5_000);
  const a0 = analyzeMatch(m0);
  assert.equal(a0.serveReturn.serving.totalPoints, 0);
  assert.equal(a0.serveReturn.returning.totalPoints, 0);
  assert.equal(a0.serviceHold.holdRate, null);
  assert.deepEqual(a0.clusters, []);
  assert.deepEqual(a0.windows15m, []);
});

test('pre-point clutch classification distinguishes AD vs GP, counts overlapping labels once in clutchUeTotal, and tracks tie-break rotation', () => {
  // GP 40-40 at 5-4 with THEM serving: US winning completes set 6-4 -> goldenPoint + breakPoint + setPoint!
  let gp = createMatch({ matchId: 'gp-clutch', config: { scoringMode: 'GP', initialServer: 0 }, nowMs: T0 });
  let t = T0;
  // Interleave to 4-4 (8 games -> US serves 9th game, holds to 5-4 -> THEM serves 10th game!)
  for (let g = 0; g < 4; g += 1) {
    ({ record: gp, t } = winGameToLove(gp, 'A', t));
    ({ record: gp, t } = winGameToLove(gp, 'B', t));
  }
  ({ record: gp, t } = winGameToLove(gp, 'A', t)); // 5-4, now server === 1 (THEM serving!)
  for (const c of ['A', 'A', 'A', 'B', 'B', 'B']) {
    t += 5_000;
    gp = addPoint(gp, c, t);
  }
  // At 5-4, 40-40 GP, THEM serving -> MY UE ('E') hits goldenPoint + breakPoint + setPoint
  t += 5_000;
  gp = addPoint(gp, 'E', t);
  gp = finishManual(gp, t + 5_000);

  const aGp = analyzeMatch(gp);
  assert.equal(aGp.clutch.clutchUeTotal, 1); // Counted ONCE despite 3 overlapping labels!
  assert.equal(aGp.clutch.byLabel.goldenPoint.myUePoints, 1);
  assert.equal(aGp.clutch.byLabel.breakPoint.myUePoints, 1);
  assert.equal(aGp.clutch.byLabel.setPoint.myUePoints, 1);

  // AD at 5-4 (US serving): 40-40 is NOT clutch; AD-40 is setPoint; 40-AD is breakPoint
  let ad = createMatch({ matchId: 'ad-clutch', config: { scoringMode: 'AD', initialServer: 1 }, nowMs: T0 });
  t = T0;
  for (let g = 0; g < 4; g += 1) {
    ({ record: ad, t } = winGameToLove(ad, 'A', t));
    ({ record: ad, t } = winGameToLove(ad, 'B', t));
  }
  ({ record: ad, t } = winGameToLove(ad, 'A', t)); // 5-4, now server === 0 (US serving!)
  for (const c of ['A', 'A', 'A', 'B', 'B', 'B']) {
    t += 5_000;
    ad = addPoint(ad, c, t);
  }
  // 40-40 AD: play E -> goes to 40-AD (not clutch yet)
  t += 5_000;
  ad = addPoint(ad, 'E', t);
  // 40-AD (breakPoint for THEM): play A -> back to 40-40
  t += 5_000;
  ad = addPoint(ad, 'A', t);
  // 40-40 -> play A -> AD-40 (setPoint for US)
  t += 5_000;
  ad = addPoint(ad, 'A', t);
  // AD-40 (setPoint): play E -> back to 40-40 (1 clutch UE on setPoint!)
  t += 5_000;
  ad = addPoint(ad, 'E', t);
  ad = finishManual(ad, t + 5_000);

  const aAd = analyzeMatch(ad);
  assert.equal(aAd.clutch.clutchUeTotal, 1);
  assert.equal(aAd.clutch.byLabel.setPoint.myUePoints, 1);
  assert.equal(aAd.clutch.byLabel.breakPoint.myUePoints, 0);
  // 9 earlier break games (40-0) + 1 at 40-AD = 10 total break points
  assert.equal(aAd.clutch.byLabel.breakPoint.totalPoints, 10);
  assert.deepEqual(aAd.timeline.at(-4).clutchLabels, []); // 40-40 in AD is not clutch
  assert.deepEqual(aAd.timeline.at(-3).clutchLabels, ['breakPoint']); // 40-AD is breakPoint
  assert.deepEqual(aAd.timeline.at(-2).clutchLabels, []); // back to 40-40
  assert.deepEqual(aAd.timeline.at(-1).clutchLabels, ['setPoint']); // AD-40 at 5-4 is setPoint
  assert.equal(aAd.clutch.byLabel.goldenPoint.totalPoints, 0);
});

test('ordinary service hold rate counts set-closing hold and 6-6 game, excludes tie-break and incomplete game', () => {
  let m = createMatch({ matchId: 'hold-tb', config: { scoringMode: 'AD', initialServer: 0 }, nowMs: T0 });
  let t = T0;
  // 12 ordinary games to 6-6: US serves games 1,3,5,7,9,11 (6 service games); US holds 5, gets broken 1
  for (let pair = 0; pair < 5; pair += 1) {
    ({ record: m, t } = winGameToLove(m, 'A', t)); // US holds
    ({ record: m, t } = winGameToLove(m, 'B', t)); // THEM holds
  }
  ({ record: m, t } = winGameToLove(m, 'B', t)); // US broken (5-6)
  ({ record: m, t } = winGameToLove(m, 'A', t)); // US breaks back -> 6-6 TB!

  // Tie-break to 6-6 (not setPoint), then 7-6 (setPoint), then 8-6 wins set 7-6 (US serves TB pts 1,4,5,8,9,12,13)
  for (let i = 0; i < 6; i += 1) {
    t += 5_000;
    m = addPoint(m, 'A', t);
    t += 5_000;
    m = addPoint(m, 'E', t);
  }
  // At 6-6 TB: play A -> 7-6 (now setPoint!), then play A -> 8-6 wins set 7-6
  t += 5_000;
  m = addPoint(m, 'A', t);
  t += 5_000;
  m = addPoint(m, 'A', t);

  // Set 2: THEM opens (received first TB point), play 1 incomplete game (30-15) and Finish Now
  t += 5_000;
  m = addPoint(m, 'A', t);
  t += 5_000;
  m = addPoint(m, 'A', t);
  t += 5_000;
  m = addPoint(m, 'B', t);
  m = finishManual(m, t + 5_000);

  const a = analyzeMatch(m);
  // US served 6 completed ordinary service games in Set 1 (won 5, lost 1); TB & incomplete Set 2 game excluded!
  assert.equal(a.serviceHold.completedOrdinaryServiceGames, 6);
  assert.equal(a.serviceHold.ordinaryServiceGamesWon, 5);
  assert.equal(a.serviceHold.holdRate, 5 / 6);

  // TB 6-5 is setPoint #1, 6-6 is tieBreak only, TB 7-6 is setPoint #2
  assert.equal(a.clutch.byLabel.tieBreak.totalPoints, 14);
  assert.equal(a.clutch.byLabel.tieBreak.myUePoints, 6);
  assert.equal(a.clutch.byLabel.setPoint.totalPoints, 2);
  const tbRows = a.timeline.filter((r) => r.inTieBreak);
  assert.deepEqual(tbRows[11].clutchLabels, ['tieBreak', 'setPoint']); // 6-5 TB
  assert.deepEqual(tbRows[12].clutchLabels, ['tieBreak']); // 6-6 TB
  assert.deepEqual(tbRows[13].clutchLabels, ['tieBreak', 'setPoint']); // 7-6 TB
  // TB serve rotation check: US served 6 E-eligible slots? In 12 alternating A,E pairs, E landed on indices 1,3,5,7,9,11
  // TB servers by 0-based index: 0:A, 1:B, 2:B, 3:A, 4:A, 5:B, 6:B, 7:A, 8:A, 9:B, 10:B, 11:A -> E at 3,7,11 while US serving (3) and 1,5,9 while THEM serving (3)!
  assert.equal(a.serveReturn.serving.myUePoints, 3);
  assert.equal(a.serveReturn.returning.myUePoints, 3);
});

test('UE clusters merge runs with <=1 intervening rally and keep disjoint runs separate', () => {
  let m = createMatch({ matchId: 'clusters', config: { scoringMode: 'AD', initialServer: 0 }, nowMs: T0 });
  let t = T0;
  // Pattern: E A E B E | A B | E E  -> Cluster 1 (pts 1..5, 3 UEs, span 5), Cluster 2 (pts 8..9, 2 UEs, span 2)
  for (const code of ['E', 'A', 'E', 'B', 'E', 'A', 'B', 'E', 'E']) {
    t += 5_000;
    m = addPoint(m, code, t);
  }
  m = finishManual(m, t + 5_000);

  const a = analyzeMatch(m);
  assert.equal(a.clusters.length, 2);
  assert.equal(a.clusters[0].startPointNumber, 1);
  assert.equal(a.clusters[0].endPointNumber, 5);
  assert.equal(a.clusters[0].spanPoints, 5);
  assert.equal(a.clusters[0].ueCount, 3);
  assert.equal(a.clusters[1].startPointNumber, 8);
  assert.equal(a.clusters[1].endPointNumber, 9);
  assert.equal(a.clusters[1].spanPoints, 2);
  assert.equal(a.clusters[1].ueCount, 2);
});

test('15-minute half-open windows include empty gap, clamp backward time, exclude invalid Date (1e20), and sort distant outliers without OOM', () => {
  let m = createMatch({ matchId: 'windows', config: { scoringMode: 'AD', initialServer: 0 }, nowMs: T0 });
  // Bucket 0 boundary (899,999 ms)
  m = addPoint(m, 'E', T0 + WINDOW_DURATION_MS - 1);
  // Backward clock skew -> clamped to bucket 0 while preserving event order
  m = addPoint(m, 'A', T0 - 5_000);
  // Skip bucket 1 (15-30m empty!) -> Bucket 2 exact boundary (1,800,000 ms)
  m = addPoint(m, 'B', T0 + 2 * WINDOW_DURATION_MS);
  // Valid distant outlier above LAST_DENSE_BUCKET_INDEX (e.g. bucket 100)
  m = addPoint(m, 'E', T0 + (LAST_DENSE_BUCKET_INDEX + 36) * WINDOW_DURATION_MS);
  // Unusable Date timestamp (finite 1e20) -> excluded into unbucketedCount without throwing!
  m = addPoint(m, 'E', 1e20);
  m = finishManual(m, T0 + 2 * WINDOW_DURATION_MS + 10_000);

  const a = analyzeMatch(m);
  assert.equal(a.unbucketedCount, 1);
  assert.deepEqual(
    a.windows15m.map((w) => w.bucketIndex),
    [0, 1, 2, LAST_DENSE_BUCKET_INDEX + 36]
  );
  // Bucket 0: 1 E + 1 A -> 1 lost, 2 total, 100% UE of lost
  assert.equal(a.windows15m[0].myUePoints, 1);
  assert.equal(a.windows15m[0].totalPoints, 2);
  assert.equal(a.windows15m[0].uePctOfPointsLost, 1);
  // Bucket 1: empty intermediate window
  assert.equal(a.windows15m[1].label, '15-30m');
  assert.equal(a.windows15m[1].totalPoints, 0);
  assert.equal(a.windows15m[1].uePctOfPointsLost, null);
  // Bucket 2: 1 B -> 0% UE of lost
  assert.equal(a.windows15m[2].pointsLost, 1);
  assert.equal(a.windows15m[2].uePctOfPointsLost, 0);
  // Outlier bucket 100
  assert.equal(a.windows15m[3].myUePoints, 1);
});
