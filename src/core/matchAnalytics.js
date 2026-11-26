import { formatPointLabel } from './format.js';
import { deriveMatchState, reducePoint, validateMatchRecord } from './scoreEngine.js';

export const WINDOW_DURATION_MS = 15 * 60 * 1000;
export const LAST_DENSE_BUCKET_INDEX = 64;

export function isValidDateMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Shared reducer-level check for whether a rally completed an ordinary (non-tie-break) game.
 * Reused identically for both pre-point break-point detection and ordinary service hold rate.
 */
export function didCompleteOrdinaryGame(preState, postState) {
  if (preState.inTieBreak) return false;
  return (
    postState.games[0] + postState.games[1] !== preState.games[0] + preState.games[1] ||
    postState.setHistory.length > preState.setHistory.length
  );
}

function createInitialReplayState(config) {
  return {
    sets: [0, 0],
    setHistory: [],
    games: [0, 0],
    points: [0, 0],
    inTieBreak: false,
    server: config.initialServer,
    tieBreakFirstServer: null,
    changeEndsAlert: false,
    winner: null,
    winningEventIndex: -1,
    ourPoints: 0,
    themOtherPoints: 0,
    myUePoints: 0,
    uesPerSet: [],
    uesWhileServing: 0,
    uesWhileReceiving: 0,
  };
}

function formatPrePointLabels(state) {
  if (state.inTieBreak) {
    return [String(state.points[0]), String(state.points[1])];
  }
  return [formatPointLabel(state.points[0]), formatPointLabel(state.points[1])];
}

function computeUePct(myUePoints, pointsLost) {
  return pointsLost > 0 ? myUePoints / pointsLost : null;
}

function buildUeClusters(timeline) {
  const eIndices = [];
  for (let i = 0; i < timeline.length; i += 1) {
    if (timeline[i].code === 'E') {
      eIndices.push(i);
    }
  }

  // A run of E events with at most one intervening rally between successive errors (idx[k] - idx[k-1] <= 2).
  // Proven identical to merging overlapping 3-point windows containing >= 2 E events, trimmed to [firstE .. lastE].
  const clusters = [];
  let i = 0;
  while (i < eIndices.length) {
    let j = i;
    while (j + 1 < eIndices.length && eIndices[j + 1] - eIndices[j] <= 2) {
      j += 1;
    }
    if (j > i) {
      const startIdx = eIndices[i];
      const endIdx = eIndices[j];
      const firstRow = timeline[startIdx];
      clusters.push(
        Object.freeze({
          startPointNumber: startIdx + 1,
          endPointNumber: endIdx + 1,
          spanPoints: endIdx - startIdx + 1,
          ueCount: j - i + 1,
          setNumber: firstRow.preSetNumber,
          startScoreText: `${firstRow.preGames[0]}-${firstRow.preGames[1]} ${firstRow.prePointsLabel[0]}-${firstRow.prePointsLabel[1]}`,
          startElapsedSec: firstRow.elapsedSec,
        })
      );
    }
    i = j + 1;
  }

  return Object.freeze(clusters);
}

function buildElapsedWindows(events, startTimeMs) {
  if (events.length === 0) {
    return { windows: Object.freeze([]), unbucketedCount: 0 };
  }

  const startValid = isValidDateMs(startTimeMs);
  const denseMap = new Map();
  const outlierMap = new Map();
  let maxDenseBucket = -1;
  let unbucketedCount = 0;

  for (const ev of events) {
    if (!startValid || !isValidDateMs(ev.t)) {
      unbucketedCount += 1;
      continue;
    }

    const elapsedMs = Math.max(0, ev.t - startTimeMs);
    // Half-open 15-minute intervals: [bucket * 900000, (bucket + 1) * 900000)
    const bucket = Math.floor(elapsedMs / WINDOW_DURATION_MS);
    const targetMap = bucket <= LAST_DENSE_BUCKET_INDEX ? denseMap : outlierMap;
    if (bucket <= LAST_DENSE_BUCKET_INDEX && bucket > maxDenseBucket) {
      maxDenseBucket = bucket;
    }

    let acc = targetMap.get(bucket);
    if (!acc) {
      acc = { myUePoints: 0, themOtherPoints: 0, ourPoints: 0 };
      targetMap.set(bucket, acc);
    }
    if (ev.code === 'A') acc.ourPoints += 1;
    else if (ev.code === 'B') acc.themOtherPoints += 1;
    else acc.myUePoints += 1;
  }

  const makeRow = (bucket, acc) => {
    const startMin = bucket * 15;
    const endMin = startMin + 15;
    const ourPoints = acc ? acc.ourPoints : 0;
    const themOtherPoints = acc ? acc.themOtherPoints : 0;
    const myUePoints = acc ? acc.myUePoints : 0;
    const pointsLost = themOtherPoints + myUePoints;
    const totalPoints = ourPoints + pointsLost;
    return Object.freeze({
      bucketIndex: bucket,
      startMin,
      endMin,
      label: `${startMin}-${endMin}m`,
      ourPoints,
      themOtherPoints,
      myUePoints,
      pointsLost,
      totalPoints,
      uePctOfPointsLost: computeUePct(myUePoints, pointsLost),
    });
  };

  const windows = [];
  if (maxDenseBucket >= 0) {
    for (let b = 0; b <= maxDenseBucket; b += 1) {
      windows.push(makeRow(b, denseMap.get(b) ?? null));
    }
  }

  const outlierKeys = [...outlierMap.keys()].sort((a, b) => a - b);
  for (const b of outlierKeys) {
    windows.push(makeRow(b, outlierMap.get(b)));
  }

  return { windows: Object.freeze(windows), unbucketedCount };
}

/**
 * Pure UE analytics engine for any validated match record.
 * Validates the record, derives summary totals, and runs a rally replay pass to compute
 * pre-point clutch UEs, serve/return splits, ordinary service hold rate, merged UE clusters,
 * 15-minute elapsed windows, and a decoded rally timeline for export.
 */
export function analyzeMatch(record, nowMs = record?.finishTimeMs ?? record?.startTimeMs ?? 0) {
  const frozenRecord = validateMatchRecord(record);
  const summary = deriveMatchState(frozenRecord, nowMs);
  const config = frozenRecord.config;

  let preState = createInitialReplayState(config);
  const timeline = [];

  const clutchLabelsOrder = ['goldenPoint', 'breakPoint', 'setPoint', 'tieBreak'];
  const clutchByLabel = {
    goldenPoint: { myUePoints: 0, pointsLost: 0, totalPoints: 0 },
    breakPoint: { myUePoints: 0, pointsLost: 0, totalPoints: 0 },
    setPoint: { myUePoints: 0, pointsLost: 0, totalPoints: 0 },
    tieBreak: { myUePoints: 0, pointsLost: 0, totalPoints: 0 },
  };
  let clutchUeTotal = 0;
  let clutchPointsLost = 0;
  let clutchTotalPoints = 0;

  const splitAcc = {
    serving: { ourPoints: 0, themOtherPoints: 0, myUePoints: 0 },
    returning: { ourPoints: 0, themOtherPoints: 0, myUePoints: 0 },
  };

  let ourCompletedServiceGames = 0;
  let ourServiceGamesWon = 0;

  const startValid = isValidDateMs(frozenRecord.startTimeMs);

  for (let i = 0; i < frozenRecord.events.length; i += 1) {
    const ev = frozenRecord.events[i];

    // Reduce actual event once, then simulate only the opposite winner for pre-point clutch checks
    const postState = reducePoint(preState, ev, i, config);
    const oppCode = ev.code === 'A' ? 'B' : 'A';
    const oppState = reducePoint(preState, { id: ev.id, t: ev.t, code: oppCode }, i, config);
    const afterUs = ev.code === 'A' ? postState : oppState;
    const afterThem = ev.code === 'A' ? oppState : postState;

    const labels = [];
    if (preState.inTieBreak) {
      labels.push('tieBreak');
    } else {
      if (config.scoringMode === 'GP' && preState.points[0] === 3 && preState.points[1] === 3) {
        labels.push('goldenPoint');
      }
      const afterReturner = preState.server === 0 ? afterThem : afterUs;
      if (didCompleteOrdinaryGame(preState, afterReturner)) {
        labels.push('breakPoint');
      }
    }

    if (
      afterUs.setHistory.length > preState.setHistory.length ||
      afterThem.setHistory.length > preState.setHistory.length
    ) {
      labels.push('setPoint');
    }

    const isPointLost = ev.code !== 'A';
    const isMyUe = ev.code === 'E';

    if (labels.length > 0) {
      clutchTotalPoints += 1;
      if (isPointLost) clutchPointsLost += 1;
      if (isMyUe) clutchUeTotal += 1;
      for (const lbl of labels) {
        clutchByLabel[lbl].totalPoints += 1;
        if (isPointLost) clutchByLabel[lbl].pointsLost += 1;
        if (isMyUe) clutchByLabel[lbl].myUePoints += 1;
      }
    }

    // Serve vs return attribution using actual pre-rally server (including tie-break rotation)
    const side = preState.server === 0 ? splitAcc.serving : splitAcc.returning;
    if (ev.code === 'A') side.ourPoints += 1;
    else if (ev.code === 'B') side.themOtherPoints += 1;
    else side.myUePoints += 1;

    // Ordinary service hold rate (excludes incomplete games and tie-breaks)
    if (preState.server === 0 && didCompleteOrdinaryGame(preState, postState)) {
      ourCompletedServiceGames += 1;
      if (ev.code === 'A') {
        ourServiceGamesWon += 1;
      }
    }

    const prePointsLabel = formatPrePointLabels(preState);
    const postPointsLabel = formatPrePointLabels(postState);
    const elapsedSec =
      startValid && isValidDateMs(ev.t) ? Math.max(0, Math.floor((ev.t - frozenRecord.startTimeMs) / 1000)) : null;

    timeline.push(
      Object.freeze({
        pointNumber: i + 1,
        eventId: ev.id,
        t: ev.t,
        elapsedSec,
        code: ev.code,
        pointWinner: ev.code === 'A' ? 'US' : 'THEM',
        isMyUe,
        preSetNumber: preState.setHistory.length + 1,
        preSets: Object.freeze([preState.sets[0], preState.sets[1]]),
        preGames: Object.freeze([preState.games[0], preState.games[1]]),
        prePointsLabel: Object.freeze([prePointsLabel[0], prePointsLabel[1]]),
        inTieBreak: preState.inTieBreak,
        preServer: preState.server,
        clutchLabels: Object.freeze(labels),
        postSets: Object.freeze([postState.sets[0], postState.sets[1]]),
        postGames: Object.freeze([postState.games[0], postState.games[1]]),
        postPointsLabel: Object.freeze([postPointsLabel[0], postPointsLabel[1]]),
      })
    );

    preState = postState;
  }

  const finalizeSplit = (acc) => {
    const pointsLost = acc.themOtherPoints + acc.myUePoints;
    const totalPoints = acc.ourPoints + pointsLost;
    return Object.freeze({
      ourPoints: acc.ourPoints,
      themOtherPoints: acc.themOtherPoints,
      myUePoints: acc.myUePoints,
      pointsLost,
      totalPoints,
      uePctOfPointsLost: computeUePct(acc.myUePoints, pointsLost),
    });
  };

  const frozenByLabel = {};
  for (const lbl of clutchLabelsOrder) {
    const c = clutchByLabel[lbl];
    frozenByLabel[lbl] = Object.freeze({
      myUePoints: c.myUePoints,
      pointsLost: c.pointsLost,
      totalPoints: c.totalPoints,
      uePctOfPointsLost: computeUePct(c.myUePoints, c.pointsLost),
    });
  }

  const clusters = buildUeClusters(timeline);
  const { windows, unbucketedCount } = buildElapsedWindows(frozenRecord.events, frozenRecord.startTimeMs);

  return Object.freeze({
    matchId: frozenRecord.matchId,
    revision: frozenRecord.revision,
    summary,
    clutch: Object.freeze({
      clutchUeTotal,
      clutchPointsLost,
      clutchTotalPoints,
      clutchUePctOfPointsLost: computeUePct(clutchUeTotal, clutchPointsLost),
      byLabel: Object.freeze(frozenByLabel),
    }),
    serveReturn: Object.freeze({
      serving: finalizeSplit(splitAcc.serving),
      returning: finalizeSplit(splitAcc.returning),
    }),
    serviceHold: Object.freeze({
      completedOrdinaryServiceGames: ourCompletedServiceGames,
      ordinaryServiceGamesWon: ourServiceGamesWon,
      holdRate: ourCompletedServiceGames > 0 ? ourServiceGamesWon / ourCompletedServiceGames : null,
    }),
    clusters,
    windows15m: windows,
    unbucketedCount,
    timeline: Object.freeze(timeline),
  });
}
