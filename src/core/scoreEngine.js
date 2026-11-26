import { formatPointLabel } from './format.js';

export const SCHEMA_VERSION = 1;
export const SUPPORTED_SCORING_MODES = Object.freeze(['AD', 'GP']);
export const SUPPORTED_P0_CONFIG = Object.freeze({
  scoringMode: 'AD',
  format: 'BO3',
  decidingSet: 'NORMAL',
});

const VALID_SCORING_MODES = new Set(SUPPORTED_SCORING_MODES);
const VALID_CODES = new Set(['A', 'B', 'E']);
const VALID_STATUSES = new Set(['ACTIVE', 'WON', 'FINISHED_MANUAL']);

function assertFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${name}: expected finite number`);
  }
}

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: expected positive safe integer`);
  }
}

function incrementSafeInteger(value, name) {
  assertPositiveSafeInteger(value, name);
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Counter overflow: ${name} reached Number.MAX_SAFE_INTEGER`);
  }
  return value + 1;
}

function assertTeamIndex(value, name) {
  if (value !== 0 && value !== 1) {
    throw new Error(`Invalid ${name}: expected 0 (Us) or 1 (Them)`);
  }
}

function assertInitialServer(value, name) {
  if (value !== 0 && value !== 1 && value !== null) {
    throw new Error(`Invalid ${name}: expected 0 (Us), 1 (Them), or null (pending)`);
  }
}

function validateConfig(config, { allowDefaults = false } = {}) {
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid config: expected object');
  }

  const scoringMode = allowDefaults
    ? (config.scoringMode ?? SUPPORTED_P0_CONFIG.scoringMode)
    : config.scoringMode;
  const format = allowDefaults
    ? (config.format ?? SUPPORTED_P0_CONFIG.format)
    : config.format;
  const decidingSet = allowDefaults
    ? (config.decidingSet ?? SUPPORTED_P0_CONFIG.decidingSet)
    : config.decidingSet;

  if (!VALID_SCORING_MODES.has(scoringMode)) {
    throw new Error(`Unsupported P0 scoringMode "${scoringMode}" (supported: "AD", "GP")`);
  }
  if (format !== SUPPORTED_P0_CONFIG.format) {
    throw new Error(`Unsupported P0 format "${format}" (only "BO3" is supported in P0)`);
  }
  if (decidingSet !== SUPPORTED_P0_CONFIG.decidingSet) {
    throw new Error(`Unsupported P0 decidingSet "${decidingSet}" (only "NORMAL" is supported in P0)`);
  }
  assertInitialServer(config.initialServer, 'config.initialServer');

  return Object.freeze({
    scoringMode,
    format,
    decidingSet,
    initialServer: config.initialServer,
  });
}

function freezeEvent(event) {
  return Object.freeze({
    id: event.id,
    t: event.t,
    code: event.code,
  });
}

function freezeRecord(record) {
  const frozenConfig = Object.freeze({
    scoringMode: record.config.scoringMode,
    format: record.config.format,
    decidingSet: record.config.decidingSet,
    initialServer: record.config.initialServer,
  });
  const frozenEvents = Object.freeze(record.events.map(freezeEvent));

  return Object.freeze({
    schemaVersion: record.schemaVersion,
    matchId: record.matchId,
    revision: record.revision,
    config: frozenConfig,
    startTimeMs: record.startTimeMs,
    finishTimeMs: record.finishTimeMs,
    status: record.status,
    nextEventId: record.nextEventId,
    events: frozenEvents,
  });
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

/**
 * Single pure point reducer shared by replay, addPoint, and import validation.
 * Attributes each event to the pre-point set and serving team before advancing score.
 */
export function reducePoint(state, event, eventIndex, config) {
  if (state.winner !== null) {
    throw new Error(
      `Invalid event log: event id=${event.id} at index ${eventIndex} occurs after match was already won at index ${state.winningEventIndex}`
    );
  }
  if (state.server !== 0 && state.server !== 1) {
    throw new Error(`Invalid state.server (${state.server}): first serving team must be chosen before scoring`);
  }
  if (!VALID_CODES.has(event.code)) {
    throw new Error(`Invalid event code "${event.code}" at index ${eventIndex}`);
  }

  const setsToWin = config.format === 'BO3' ? 2 : 1;
  const sets = [state.sets[0], state.sets[1]];
  const setHistory = state.setHistory.slice();
  let games = [state.games[0], state.games[1]];
  let points = [state.points[0], state.points[1]];
  let inTieBreak = state.inTieBreak;
  let server = state.server;
  let tieBreakFirstServer = state.tieBreakFirstServer;
  let changeEndsAlert = false;
  let winner = null;
  let winningEventIndex = -1;

  // Ensure uesPerSet has one entry for every set that has seen at least one point
  const setIdx = setHistory.length;
  const uesPerSet = state.uesPerSet.slice();
  while (uesPerSet.length <= setIdx) {
    uesPerSet.push(0);
  }

  // Pre-point attribution (uses serving team and set index of this rally)
  const preServer = server;
  let ourPoints = state.ourPoints;
  let themOtherPoints = state.themOtherPoints;
  let myUePoints = state.myUePoints;
  let uesWhileServing = state.uesWhileServing;
  let uesWhileReceiving = state.uesWhileReceiving;

  if (event.code === 'A') {
    ourPoints += 1;
  } else if (event.code === 'B') {
    themOtherPoints += 1;
  } else {
    myUePoints += 1;
    uesPerSet[setIdx] += 1;
    if (preServer === 0) {
      uesWhileServing += 1;
    } else {
      uesWhileReceiving += 1;
    }
  }

  const team = event.code === 'A' ? 0 : 1;
  const opp = team === 0 ? 1 : 0;

  if (inTieBreak) {
    points[team] += 1;
    const tbTotal = points[0] + points[1];

    // Alert every 6 tie-break points
    if (tbTotal > 0 && tbTotal % 6 === 0) {
      changeEndsAlert = true;
    }

    // Tie-break team service: A, B, B, A, A, ... (switches on odd point totals)
    if (tbTotal % 2 === 1) {
      server = server === 0 ? 1 : 0;
    }

    if (points[team] >= 7 && points[team] - points[opp] >= 2) {
      games[team] += 1; // 7-6 or 6-7
      setHistory.push({
        games: [games[0], games[1]],
        type: 'SET',
        tieBreakPoints: [points[0], points[1]],
      });
      sets[team] += 1;
      games = [0, 0];
      points = [0, 0];
      inTieBreak = false;
      // FIP Rule 1: team that received the first tie-break point serves first in the next set
      server = tieBreakFirstServer === 0 ? 1 : 0;
      tieBreakFirstServer = null;
      // 7-6 set ends after 13 games (odd) -> single change-ends alert if match continues
      changeEndsAlert = true;

      if (sets[team] >= setsToWin) {
        winner = team;
        winningEventIndex = eventIndex;
        changeEndsAlert = false;
      }
    }
  } else {
    // Ordinary game: Advantage (AD) or Golden Point (GP)
    const pTeam = points[team];
    const pOpp = points[opp];
    let wonGame = false;
    let resetToDeuce = false;

    if (config.scoringMode === 'GP') {
      wonGame = pTeam === 3 && pOpp <= 3;
    } else {
      // AD: 40-0/15/30 wins, AD-40 wins, trailing team winning at AD resets to 40-40 Deuce
      if ((pTeam === 3 && pOpp < 3) || (pTeam === 4 && pOpp === 3)) {
        wonGame = true;
      } else if (pTeam === 3 && pOpp === 4) {
        resetToDeuce = true;
      }
    }

    if (resetToDeuce) {
      points[opp] = 3;
    } else if (!wonGame) {
      points[team] += 1;
    } else {
      points = [0, 0];
      games[team] += 1;
      server = server === 0 ? 1 : 0;

      // Compute changeEndsAlert BEFORE resetting games on set win (FIP Rule 5):
      // 6-3 (9 games) -> alert; 6-4 (10) / 7-5 (12) / entering 6-6 TB (12) -> no alert
      const totalGames = games[0] + games[1];
      changeEndsAlert = totalGames % 2 === 1;

      if (games[team] >= 6 && games[team] - games[opp] >= 2) {
        setHistory.push({
          games: [games[0], games[1]],
          type: 'SET',
        });
        sets[team] += 1;
        games = [0, 0];

        if (sets[team] >= setsToWin) {
          winner = team;
          winningEventIndex = eventIndex;
          changeEndsAlert = false;
        }
      } else if (games[0] === 6 && games[1] === 6) {
        inTieBreak = true;
        tieBreakFirstServer = server;
        changeEndsAlert = false;
      }
    }
  }

  return {
    sets,
    setHistory,
    games,
    points,
    inTieBreak,
    server,
    tieBreakFirstServer,
    changeEndsAlert,
    winner,
    winningEventIndex,
    ourPoints,
    themOtherPoints,
    myUePoints,
    uesPerSet,
    uesWhileServing,
    uesWhileReceiving,
  };
}

function replayAndValidate(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('Invalid match record: expected object');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion: ${record.schemaVersion}`);
  }
  if (typeof record.matchId !== 'string' || record.matchId.trim().length === 0) {
    throw new Error('Invalid matchId: expected non-empty string');
  }
  assertPositiveSafeInteger(record.revision, 'revision');
  if (!VALID_STATUSES.has(record.status)) {
    throw new Error(`Invalid match status: "${record.status}"`);
  }
  assertFiniteNumber(record.startTimeMs, 'startTimeMs');
  if (record.finishTimeMs !== null) {
    assertFiniteNumber(record.finishTimeMs, 'finishTimeMs');
  }
  assertPositiveSafeInteger(record.nextEventId, 'nextEventId');
  if (!Array.isArray(record.events)) {
    throw new Error('Invalid events: expected array');
  }

  // Persisted/imported records must explicitly specify all config fields (no silent defaults)
  const config = validateConfig(record.config, { allowDefaults: false });
  if (config.initialServer === null && record.events.length > 0) {
    throw new Error('Invalid match record: initialServer cannot be null once points have been recorded');
  }

  let state = createInitialReplayState(config);
  let prevId = 0;

  for (let i = 0; i < record.events.length; i += 1) {
    const ev = record.events[i];
    if (!ev || typeof ev !== 'object') {
      throw new Error(`Invalid event at index ${i}`);
    }
    assertPositiveSafeInteger(ev.id, `events[${i}].id`);
    if (ev.id <= prevId) {
      throw new Error(`Event IDs must strictly increase (index ${i}: id=${ev.id}, prev=${prevId})`);
    }
    assertFiniteNumber(ev.t, `events[${i}].t`);
    prevId = ev.id;
    state = reducePoint(state, ev, i, config);
  }

  if (record.nextEventId <= prevId) {
    throw new Error(`nextEventId (${record.nextEventId}) must exceed highest event id (${prevId})`);
  }

  // Enforce strict consistency between replayed outcome and stored status / finishTimeMs
  if (record.status === 'WON') {
    if (state.winner === null) {
      throw new Error('Status mismatch: stored status is WON but replayed events have no winner');
    }
    if (record.finishTimeMs === null) {
      throw new Error('Status mismatch: WON match must have a finite finishTimeMs');
    }
    const winningEventTime = record.events[state.winningEventIndex].t;
    if (record.finishTimeMs !== winningEventTime) {
      throw new Error(
        `Status mismatch: WON finishTimeMs (${record.finishTimeMs}) must equal winning event timestamp (${winningEventTime})`
      );
    }
  } else if (record.status === 'ACTIVE') {
    if (state.winner !== null) {
      throw new Error('Status mismatch: stored status is ACTIVE but replayed events already won the match');
    }
    if (record.finishTimeMs !== null) {
      throw new Error('Status mismatch: ACTIVE match must have finishTimeMs === null');
    }
  } else if (record.status === 'FINISHED_MANUAL') {
    if (state.winner !== null) {
      throw new Error('Status mismatch: stored status is FINISHED_MANUAL but replayed events already won the match');
    }
    if (record.finishTimeMs === null) {
      throw new Error('Status mismatch: FINISHED_MANUAL match must have a finite finishTimeMs');
    }
  }

  return { config, state };
}

/**
 * Validates an imported or persisted match record and returns a deeply frozen copy.
 * Throws descriptive errors on corrupt logs, trailing events after win, missing rules, or status mismatches.
 */
export function validateMatchRecord(record) {
  replayAndValidate(record);
  return freezeRecord(record);
}

export function createMatch({ matchId, config, nowMs }) {
  if (typeof matchId !== 'string' || matchId.trim().length === 0) {
    throw new Error('Invalid matchId: expected non-empty string');
  }
  assertFiniteNumber(nowMs, 'nowMs');
  const frozenConfig = validateConfig(config, { allowDefaults: true });

  return freezeRecord({
    schemaVersion: SCHEMA_VERSION,
    matchId,
    revision: 1,
    config: frozenConfig,
    startTimeMs: nowMs,
    finishTimeMs: null,
    status: 'ACTIVE',
    nextEventId: 1,
    events: [],
  });
}

export function deriveMatchState(record, nowMs = record?.startTimeMs ?? 0) {
  assertFiniteNumber(nowMs, 'nowMs');
  const { state } = replayAndValidate(record);

  const theirPoints = state.themOtherPoints + state.myUePoints;
  const totalPoints = state.ourPoints + theirPoints;
  const myUePctOfPointsLost = theirPoints > 0 ? state.myUePoints / theirPoints : null;

  const endMs = record.finishTimeMs ?? nowMs;
  const durationSec = Math.max(0, Math.floor((endMs - record.startTimeMs) / 1000));

  const pointsLabel = state.inTieBreak
    ? [String(state.points[0]), String(state.points[1])]
    : [formatPointLabel(state.points[0]), formatPointLabel(state.points[1])];

  // Suppress changeEndsAlert whenever the match is finished (WON or FINISHED_MANUAL)
  const changeEndsAlert = record.status === 'ACTIVE' ? state.changeEndsAlert : false;

  return {
    matchId: record.matchId,
    revision: record.revision,
    scoringMode: record.config.scoringMode,
    needsInitialServer: record.config.initialServer === null,
    status: record.status,
    winner: record.status === 'WON' ? state.winner : null,
    sets: state.sets,
    setHistory: state.setHistory,
    games: state.games,
    points: state.points,
    pointsLabel,
    inTieBreak: state.inTieBreak,
    server: state.server,
    changeEndsAlert,
    counts: {
      ourPoints: state.ourPoints,
      themOtherPoints: state.themOtherPoints,
      myUePoints: state.myUePoints,
      theirPoints,
      totalPoints,
    },
    myUePctOfPointsLost,
    uesPerSet: state.uesPerSet,
    uesWhileServing: state.uesWhileServing,
    uesWhileReceiving: state.uesWhileReceiving,
    durationSec,
  };
}

export function addPoint(record, code, nowMs) {
  if (record.status !== 'ACTIVE') {
    throw new Error(`Cannot add point when match status is "${record.status}"`);
  }
  if (record.config?.initialServer === null) {
    throw new Error('Cannot add point before first serving team is selected');
  }
  if (!VALID_CODES.has(code)) {
    throw new Error(`Invalid event code "${code}": expected "A", "B", or "E"`);
  }
  assertFiniteNumber(nowMs, 'nowMs');

  const { config, state } = replayAndValidate(record);
  const nextRevision = incrementSafeInteger(record.revision, 'revision');
  const nextEventId = incrementSafeInteger(record.nextEventId, 'nextEventId');
  const newEvent = freezeEvent({ id: record.nextEventId, t: nowMs, code });
  const nextState = reducePoint(state, newEvent, record.events.length, config);

  const isWon = nextState.winner !== null;
  return freezeRecord({
    ...record,
    revision: nextRevision,
    nextEventId,
    status: isWon ? 'WON' : 'ACTIVE',
    finishTimeMs: isWon ? nowMs : null,
    events: [...record.events, newEvent],
  });
}

export function undoLastPoint(record) {
  replayAndValidate(record);
  if (record.status === 'FINISHED_MANUAL') {
    throw new Error('Cannot undo on a FINISHED_MANUAL match; call resumeMatch first');
  }
  if (record.events.length === 0) {
    return record;
  }

  return freezeRecord({
    ...record,
    revision: incrementSafeInteger(record.revision, 'revision'),
    status: 'ACTIVE',
    finishTimeMs: null,
    // nextEventId intentionally never rewinds so replaced rallies get fresh IDs
    events: record.events.slice(0, -1),
  });
}

export function correctInitialServer(record, newInitialServer) {
  replayAndValidate(record);
  // Check ACTIVE before equality so finished matches always throw even for unchanged opener
  if (record.status !== 'ACTIVE') {
    throw new Error(`Cannot correct initial server when match status is "${record.status}"`);
  }
  assertTeamIndex(newInitialServer, 'newInitialServer');

  if (record.config.initialServer === newInitialServer) {
    return record;
  }

  return freezeRecord({
    ...record,
    revision: incrementSafeInteger(record.revision, 'revision'),
    config: {
      ...record.config,
      initialServer: newInitialServer,
    },
  });
}

export function finishManual(record, nowMs) {
  replayAndValidate(record);
  if (record.status !== 'ACTIVE') {
    throw new Error(`Cannot manually finish match when status is "${record.status}"`);
  }
  assertFiniteNumber(nowMs, 'nowMs');

  return freezeRecord({
    ...record,
    revision: incrementSafeInteger(record.revision, 'revision'),
    status: 'FINISHED_MANUAL',
    finishTimeMs: nowMs,
  });
}

export function resumeMatch(record) {
  replayAndValidate(record);
  if (record.status !== 'FINISHED_MANUAL') {
    throw new Error(`Cannot resume match when status is "${record.status}" (expected "FINISHED_MANUAL")`);
  }

  return freezeRecord({
    ...record,
    revision: incrementSafeInteger(record.revision, 'revision'),
    status: 'ACTIVE',
    finishTimeMs: null,
  });
}
