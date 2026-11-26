import { normalizeWristCenterMode, WRIST_CENTER_MODES } from '../core/wristEditMode.js';
import { formatWristDisplay } from '../core/wristDisplay.js';

function round1(n) {
  return Math.round(n * 10) / 10;
}

function formatSetupPreview(initialServer, scoringMode) {
  const synthState = {
    matchId: 'setup-preview',
    status: 'ACTIVE',
    winner: null,
    scoringMode: scoringMode === 'GP' ? 'GP' : 'AD',
    sets: [0, 0],
    games: [0, 0],
    points: [0, 0],
    pointsLabel: ['0', '0'],
    inTieBreak: false,
    server: initialServer === 0 ? 0 : initialServer === 1 ? 1 : null,
    needsInitialServer: initialServer !== 0 && initialServer !== 1,
    changeEndsAlert: false,
    counts: { ourPoints: 0, themOtherPoints: 0, myUePoints: 0, totalPoints: 0 },
    myUePctOfPointsLost: null,
    revision: 1,
  };
  return formatWristDisplay(synthState);
}

/**
 * Shared Band 9 Active 3-button key layout used by both describeBandControls() and
 * getBandGuideSteps() so the Live Band footer, Edit banner, and Visual Guide never drift apart.
 */
export function buildBandKeysForPhase(phase, { wristCenterMode = WRIST_CENTER_MODES.EDIT_MODE, canUndo = true } = {}) {
  const isEditMode = normalizeWristCenterMode(wristCenterMode) === WRIST_CENTER_MODES.EDIT_MODE;

  if (phase === 'WARMUP') {
    return Object.freeze([
      Object.freeze({ symbol: '<', label: 'US serves', tone: 'us', disabled: false, highlight: false }),
      Object.freeze({ symbol: '||', label: 'Inactive', tone: 'muted', disabled: true, highlight: false }),
      Object.freeze({ symbol: '>', label: 'THEM serves', tone: 'them', disabled: false, highlight: false }),
    ]);
  }

  if (phase === 'PROMPT') {
    return Object.freeze([
      Object.freeze({
        symbol: '<',
        label: canUndo ? 'Undo last point' : 'Undo unavailable',
        tone: canUndo ? 'us' : 'muted',
        disabled: !canUndo,
        highlight: false,
      }),
      Object.freeze({ symbol: '||', label: 'Keep Edit open', tone: 'neutral', disabled: false, highlight: false }),
      Object.freeze({ symbol: '>', label: 'My error · +1 THEM', tone: 'ue', disabled: false, highlight: false }),
    ]);
  }

  if (phase === 'AWAITING_LIVE') {
    return Object.freeze([
      Object.freeze({ symbol: '<', label: 'Inactive', tone: 'muted', disabled: true, highlight: false }),
      Object.freeze({ symbol: '||', label: 'Resume scoring', tone: 'accent', disabled: false, highlight: true }),
      Object.freeze({ symbol: '>', label: 'Inactive', tone: 'muted', disabled: true, highlight: false }),
    ]);
  }

  // LIVE (or SETUP_LIVE)
  return Object.freeze([
    Object.freeze({ symbol: '<', label: 'US +1', tone: 'us', disabled: false, highlight: false }),
    Object.freeze({
      symbol: '||',
      label: isEditMode ? 'Edit point' : 'My error · +1 THEM',
      tone: isEditMode ? 'neutral' : 'ue',
      disabled: false,
      highlight: false,
    }),
    Object.freeze({ symbol: '>', label: 'THEM +1', tone: 'them', disabled: false, highlight: false }),
  ]);
}

/**
 * Derives the exact Band 9 Active readout and plain-language button cues directly from
 * the authoritative controller view-model (never inventing separate action legality).
 * Live key assignments are shown only on Setup preview or when the active writer is ARMED.
 */
export function describeBandControls(vm) {
  const mode = normalizeWristCenterMode(vm?.wristCenterMode);
  const isEditMode = mode === WRIST_CENTER_MODES.EDIT_MODE;

  if (vm?.screen === 'SETUP') {
    const pickOnWatch = vm.setupInitialServer === null;
    const preview = formatSetupPreview(vm.setupInitialServer, vm.setupScoringMode);

    if (pickOnWatch) {
      return Object.freeze({
        phase: 'SETUP_WARMUP',
        showKeys: true,
        headline: 'Starts with warmup server pick',
        subcue: 'On band: < selects US, > selects THEM (no point scored). Then normal scoring starts.',
        compactKeysText: '< US · > THEM',
        title: preview.title,
        artist: preview.artist,
        emphasis: 'neutral',
        keys: buildBandKeysForPhase('WARMUP', { wristCenterMode: mode }),
        afterWarmupNote: isEditMode
          ? 'During play: < US +1 · || Edit point (< Undo / > MY UE) · > THEM +1'
          : 'During play: < US +1 · || My error (+1 THEM) · > THEM +1',
      });
    }

    return Object.freeze({
      phase: 'SETUP_LIVE',
      showKeys: true,
      headline: 'Ready for direct live scoring',
      subcue: isEditMode
        ? '< gives US a point · > gives THEM a point · || opens Edit point (< Undo / > My error).'
        : '< gives US a point · > gives THEM a point · || logs My error (+1 THEM).',
      compactKeysText: isEditMode ? '< US · || Edit · > THEM' : '< US · || MY UE · > THEM',
      title: preview.title,
      artist: preview.artist,
      emphasis: 'neutral',
      keys: buildBandKeysForPhase('LIVE', { wristCenterMode: mode }),
      afterWarmupNote: null,
    });
  }

  // LIVE (or fallback) — keep the two tested wrist lines verbatim from vm.wristPreview
  const title = vm?.wristPreview?.title ?? '';
  const artist = vm?.wristPreview?.artist ?? '';
  const state = vm?.state ?? null;
  const record = vm?.record ?? null;
  const editState = vm?.editState ?? null;
  const isWriter = vm?.isWriter !== false;
  const wristStatus = vm?.wrist?.status ?? 'ARMED';

  // Read-only viewer cannot observe the writer's ephemeral edit overlay or execute wrist actions
  if (!isWriter) {
    return Object.freeze({
      phase: 'READ_ONLY',
      showKeys: false,
      headline: 'Band controls managed by scoring tab',
      subcue: 'This tab is viewing only. Check the scoring tab for live Band controls, or tap Take over above.',
      compactKeysText: 'Viewing only',
      title: '',
      artist: '',
      emphasis: 'neutral',
      keys: Object.freeze([]),
      afterWarmupNote: null,
    });
  }

  // Disarmed / Interrupted / Unavailable writer: never show actionable key assignments until ARMED
  if (wristStatus !== 'ARMED') {
    const hasPendingEditBarrier = Boolean(editState && editState.phase !== 'LIVE');
    if (wristStatus === 'UNAVAILABLE') {
      return Object.freeze({
        phase: 'UNAVAILABLE',
        showKeys: false,
        headline: 'Band controls unavailable in this browser',
        subcue: 'Score directly using the phone buttons above.',
        compactKeysText: 'Phone scoring only',
        title: '',
        artist: '',
        emphasis: 'neutral',
        keys: Object.freeze([]),
        afterWarmupNote: null,
      });
    }
    if (wristStatus === 'INTERRUPTED') {
      return Object.freeze({
        phase: 'INTERRUPTED',
        showKeys: false,
        headline: 'Re-link Band before using wrist controls',
        subcue: hasPendingEditBarrier
          ? 'Tap Re-link Band above first. Once linked, press || on your Band to resume arrow scoring.'
          : 'Tap Re-link Band above to restore Band 9 Active Music Controls.',
        compactKeysText: 'Interrupted · Re-link Band',
        title: '',
        artist: '',
        emphasis: 'neutral',
        keys: Object.freeze([]),
        afterWarmupNote: null,
      });
    }
    return Object.freeze({
      phase: 'DISARMED',
      showKeys: false,
      headline: 'Band controls not linked',
      subcue: hasPendingEditBarrier
        ? 'Tap Re-link Band above first. Once linked, press || on your Band to resume arrow scoring.'
        : 'Tap Re-link Band above to start Band 9 Active Music Controls.',
      compactKeysText: 'Not linked · Re-link Band',
      title: '',
      artist: '',
      emphasis: 'neutral',
      keys: Object.freeze([]),
      afterWarmupNote: null,
    });
  }

  const isActive = state?.status === 'ACTIVE' && record?.status === 'ACTIVE';
  const matchesEdit = Boolean(
    isActive &&
      editState &&
      editState.phase !== 'LIVE' &&
      editState.matchId === record.matchId &&
      editState.baseRevision === record.revision
  );

  if (matchesEdit && editState.phase === 'AWAITING_LIVE') {
    let subcue = `Edit closed (#${record.revision}). Arrows stay inactive until you press ||.`;
    if (editState.reason === 'UNDO') {
      subcue = `Last point undone (#${record.revision}). Arrows stay inactive until you press ||.`;
    } else if (editState.reason === 'UE') {
      subcue = `My error saved (+1 THEM, #${record.revision}). Arrows stay inactive until you press ||.`;
    }
    return Object.freeze({
      phase: 'AWAITING_LIVE',
      showKeys: true,
      headline: 'Press || to resume scoring',
      subcue,
      compactKeysText: 'Tap || on Band to resume',
      title,
      artist,
      emphasis: 'resume',
      keys: buildBandKeysForPhase('AWAITING_LIVE', { wristCenterMode: mode }),
      afterWarmupNote: null,
    });
  }

  if (matchesEdit && editState.phase === 'PROMPT') {
    const canUndo = Boolean(editState.canUndo && (record.events?.length ?? 0) > 0);
    return Object.freeze({
      phase: 'PROMPT',
      showKeys: true,
      headline: 'Choose a correction',
      subcue: canUndo
        ? '< undoes the last point · > logs your error (+1 THEM) · || keeps Edit open.'
        : 'Undo is unavailable at 0 points · > logs your error (+1 THEM) · || keeps Edit open.',
      compactKeysText: canUndo ? '< Undo · > MY UE' : '> MY UE',
      title,
      artist,
      emphasis: 'edit',
      keys: buildBandKeysForPhase('PROMPT', { wristCenterMode: mode, canUndo }),
      afterWarmupNote: null,
    });
  }

  if (isActive && state.needsInitialServer) {
    return Object.freeze({
      phase: 'WARMUP',
      showKeys: true,
      headline: 'Who serves first?',
      subcue: '< selects US and > selects THEM. Neither awards a point.',
      compactKeysText: '< US serves · > THEM serves',
      title,
      artist,
      emphasis: 'warmup',
      keys: buildBandKeysForPhase('WARMUP', { wristCenterMode: mode }),
      afterWarmupNote: null,
    });
  }

  return Object.freeze({
    phase: 'LIVE',
    showKeys: true,
    headline: 'Live scoring',
    subcue: isEditMode
      ? '< gives US a point · > gives THEM a point · || opens Edit point.'
      : '< gives US a point · > gives THEM a point · || logs My error (+1 THEM).',
    compactKeysText: isEditMode ? '< US · || Edit · > THEM' : '< US · || MY UE · > THEM',
    title,
    artist,
    emphasis: 'live',
    keys: buildBandKeysForPhase('LIVE', { wristCenterMode: mode }),
    afterWarmupNote: null,
  });
}

export const SAFE_UPDATE_SCREENS = Object.freeze(
  new Set(['SETUP', 'MATCH_OVER', 'HISTORY', 'HISTORY_DETAIL'])
);

export function getCenterModeSummary(wristCenterMode) {
  const mode = normalizeWristCenterMode(wristCenterMode);
  if (mode === WRIST_CENTER_MODES.ONE_TAP_UE) {
    return 'Press || to record my unforced error and give THEM a point.';
  }
  return 'Press || to choose Undo or My Error.';
}

export function isSafeUpdateScreen(screen) {
  return SAFE_UPDATE_SCREENS.has(screen);
}

export function shouldReloadOnControllerChange({ requestedWorker, newController, screen }) {
  if (!requestedWorker || !newController) return false;
  if (requestedWorker !== newController) return false;
  return isSafeUpdateScreen(screen);
}

/**
 * Returns visual steps for the Band 9 Active Quick Guide sheet.
 * Shows the warmup server-picker step ONLY while the Band displays WHO SERVES? (or Setup is set to Pick on Band).
 * Shares buildBandKeysForPhase() so guide schematics stay identical to live Band key legality.
 */
export function getBandGuideSteps(wristCenterMode, { showWarmupStep = false } = {}) {
  const mode = normalizeWristCenterMode(wristCenterMode);
  const isEditMode = mode === WRIST_CENTER_MODES.EDIT_MODE;
  const rawSteps = [];

  if (showWarmupStep) {
    rawSteps.push({
      title: 'Pick first server (only while WHO SERVES? is shown)',
      bandTitle: 'WHO SERVES? #1',
      bandArtist: '< US   THEM >',
      caption: 'After the 4-touch warmup, tap < for US or > for THEM. No point is added.',
      keys: buildBandKeysForPhase('WARMUP', { wristCenterMode: mode }),
    });
  }

  if (isEditMode) {
    rawSteps.push(
      {
        title: 'Score normal rallies',
        bandTitle: '*30-15 2-1 #9',
        bandArtist: 'S0-0 UE:1',
        caption: 'As soon as the server is set (including 0-0), < awards US +1, > awards THEM +1, and || opens Edit point.',
        keys: buildBandKeysForPhase('LIVE', { wristCenterMode: mode }),
      },
      {
        title: 'Choose Undo or My Error',
        bandTitle: 'EDIT #9',
        bandArtist: '<UNDO   UE>',
        caption: 'Inside Edit: tap < to Undo last point, or > to log My UE (+1 THEM). At 0 points, Undo is unavailable — cancel on phone if opened by mistake.',
        keys: buildBandKeysForPhase('PROMPT', { wristCenterMode: mode, canUndo: true }),
      },
      {
        title: 'Press || to resume scoring',
        bandTitle: 'UE *30-30 #10',
        bandArtist: 'TAP || FOR LIVE',
        caption: 'Important: arrows (< and >) stay inactive after Undo or My UE so double-taps never mis-score. Press || before scoring the next rally.',
        keys: buildBandKeysForPhase('AWAITING_LIVE', { wristCenterMode: mode }),
      }
    );
  } else {
    rawSteps.push(
      {
        title: 'Score & log My UE in 1 tap',
        bandTitle: '*30-15 2-1 #9',
        bandArtist: 'S0-0 UE:1',
        caption: 'As soon as the server is set (including 0-0), < awards US +1, > awards THEM +1, and || logs My UE (+1 THEM) immediately.',
        keys: buildBandKeysForPhase('LIVE', { wristCenterMode: mode }),
      },
      {
        title: 'Undo on phone (or switch to Edit point)',
        bandTitle: '0-0 2-1 #10',
        bandArtist: 'S0-0 UE:1',
        caption: 'In 1-Tap My Error mode, Undo is on the phone screen. Switch to Edit point in Match Menu to undo from your wrist.',
        keys: Object.freeze([]),
      },
      {
        title: 'Check Band before locking phone',
        bandTitle: 'US SERVES #2',
        bandArtist: '0-0 0-0 S0-0',
        caption: 'Open Band Music Controls once to confirm PadelScore appears without pressing an arrow, then lock your phone.',
        keys: Object.freeze([]),
      }
    );
  }

  return Object.freeze(
    rawSteps.map((s, idx) => Object.freeze({ step: idx + 1, ...s }))
  );
}

/**
 * Computes mutually exclusive point-share buckets from match counts.
 * Guards 0-point denominators cleanly.
 */
export function computePointShare(counts) {
  const usPoints = Math.max(0, Number(counts?.ourPoints) || 0);
  const themOtherPoints = Math.max(0, Number(counts?.themOtherPoints) || 0);
  const myUePoints = Math.max(0, Number(counts?.myUePoints) || 0);
  const totalPoints = usPoints + themOtherPoints + myUePoints;
  const pointsLost = themOtherPoints + myUePoints;

  if (totalPoints === 0) {
    return Object.freeze({
      totalPoints: 0,
      pointsLost: 0,
      usPoints: 0,
      themOtherPoints: 0,
      myUePoints: 0,
      usPct: 0,
      themOtherPct: 0,
      myUePct: 0,
      uePctOfLost: null,
    });
  }

  const usPct = (usPoints / totalPoints) * 100;
  const themOtherPct = (themOtherPoints / totalPoints) * 100;
  const myUePct = Math.max(0, 100 - usPct - themOtherPct);
  return Object.freeze({
    totalPoints,
    pointsLost,
    usPoints,
    themOtherPoints,
    myUePoints,
    usPct: round1(usPct),
    themOtherPct: round1(themOtherPct),
    myUePct: round1(myUePct),
    uePctOfLost: pointsLost > 0 ? myUePoints / pointsLost : null,
  });
}

/**
 * Builds TV padel scoreboard grid columns strictly from derived match state & status.
 * - ACTIVE: always includes completed sets + current set + PTS (or TB during tie-break) + activeServer.
 * - WON: completed sets only (never appends a bogus 0-0 next set), no serve dot.
 * - FINISHED_MANUAL: completed sets + partial set only if games/points/tie-break are non-zero
 *   (or a fallback S1 0-0 column when stopped with 0 points), no serve dot.
 */
export function buildScoreboardColumns(state) {
  const setHistory = Array.isArray(state?.setHistory) ? state.setHistory : [];
  const status = state?.status ?? 'ACTIVE';
  const games = Array.isArray(state?.games) ? state.games : [0, 0];
  const points = Array.isArray(state?.points) ? state.points : [0, 0];
  const pointsLabel = Array.isArray(state?.pointsLabel) ? state.pointsLabel : ['0', '0'];
  const inTieBreak = Boolean(state?.inTieBreak);

  const cols = setHistory.map((entry, idx) => {
    const us = Number(entry?.games?.[0]) || 0;
    const them = Number(entry?.games?.[1]) || 0;
    const hasTb = Array.isArray(entry?.tieBreakPoints) && entry.tieBreakPoints.length === 2;
    const tbUs = hasTb ? Number(entry.tieBreakPoints[0]) : null;
    const tbThem = hasTb ? Number(entry.tieBreakPoints[1]) : null;
    const usSup = hasTb && us < them ? tbUs : null;
    const themSup = hasTb && them < us ? tbThem : null;

    return Object.freeze({
      label: `S${idx + 1}`,
      us,
      them,
      usSup,
      themSup,
      tbUs,
      tbThem,
      isCurrent: false,
    });
  });

  let showPoints = false;
  let pointsHeader = inTieBreak ? 'TB' : 'PTS';

  if (status === 'ACTIVE') {
    cols.push(
      Object.freeze({
        label: `S${cols.length + 1}`,
        us: Number(games[0]) || 0,
        them: Number(games[1]) || 0,
        usSup: null,
        themSup: null,
        tbUs: null,
        tbThem: null,
        isCurrent: true,
      })
    );
    showPoints = true;
  } else if (status === 'FINISHED_MANUAL') {
    const hasPartialPoints = points[0] > 0 || points[1] > 0 || inTieBreak;
    const hasPartialSet = games[0] > 0 || games[1] > 0 || hasPartialPoints;
    if (hasPartialSet) {
      cols.push(
        Object.freeze({
          label: `S${cols.length + 1}`,
          us: Number(games[0]) || 0,
          them: Number(games[1]) || 0,
          usSup: null,
          themSup: null,
          tbUs: null,
          tbThem: null,
          isCurrent: true,
        })
      );
      showPoints = hasPartialPoints;
    } else if (cols.length === 0) {
      cols.push(
        Object.freeze({
          label: 'S1',
          us: 0,
          them: 0,
          usSup: null,
          themSup: null,
          tbUs: null,
          tbThem: null,
          isCurrent: true,
        })
      );
    }
  } else if (cols.length === 0) {
    cols.push(
      Object.freeze({
        label: 'S1',
        us: 0,
        them: 0,
        usSup: null,
        themSup: null,
        tbUs: null,
        tbThem: null,
        isCurrent: false,
      })
    );
  }

  const activeServer =
    status === 'ACTIVE' && (state?.server === 0 || state?.server === 1) ? state.server : null;

  return Object.freeze({
    cols: Object.freeze(cols),
    showPoints,
    pointsHeader,
    points: Object.freeze([String(pointsLabel[0] ?? '0'), String(pointsLabel[1] ?? '0')]),
    activeServer,
  });
}

/**
 * Pure Set Flow + Broadcast Point-by-Point model derived from analyzeMatch() output.
 * - Reads final set scores & tieBreakPoints directly from summary.setHistory (zero display-text parsing).
 * - Uses timeline strictly to group points into games, count UEs (unbounded integer), and render point labels.
 * - Labels Advantage deuce resets as 'D', Golden Point deciders as 'GP', and tie-breaks as plain numbers with server: null.
 * - Never emits empty incomplete games when stopped at an exact game or set boundary.
 */
export function buildSetFlowModel(analytics) {
  const timeline = Array.isArray(analytics?.timeline) ? analytics.timeline : [];
  const summary = analytics?.summary ?? null;
  if (timeline.length === 0 || !summary) {
    return Object.freeze({ isEmpty: true, sets: Object.freeze([]) });
  }

  const setHistory = Array.isArray(summary.setHistory) ? summary.setHistory : [];
  const setBuckets = new Map();

  for (const row of timeline) {
    const setNum = Number(row.preSetNumber) || 1;
    let bucket = setBuckets.get(setNum);
    if (!bucket) {
      bucket = [];
      setBuckets.set(setNum, bucket);
    }
    bucket.push(row);
  }

  const sortedSetNums = [...setBuckets.keys()].sort((a, b) => a - b);
  const sets = [];

  for (const setNum of sortedSetNums) {
    const rows = setBuckets.get(setNum);
    const setIdx = setNum - 1;
    const completedSet = setIdx < setHistory.length ? setHistory[setIdx] : null;

    const games = [];
    let currentGameRows = [];

    const flushGame = (gameRows, gameEnded, setEndedOnGame) => {
      if (gameRows.length === 0) return;
      const firstRow = gameRows[0];
      const lastRow = gameRows[gameRows.length - 1];
      const isTieBreak = Boolean(firstRow.inTieBreak);
      const isIncomplete = !gameEnded;
      const winner = gameEnded ? (lastRow.code === 'A' ? 0 : 1) : null;
      const server = isTieBreak ? null : firstRow.preServer === 0 ? 0 : firstRow.preServer === 1 ? 1 : null;
      const isBreak = Boolean(!isTieBreak && !isIncomplete && winner !== null && server !== null && winner !== server);

      let usGamesAfter = lastRow.postGames[0];
      let themGamesAfter = lastRow.postGames[1];
      if (setEndedOnGame && completedSet) {
        usGamesAfter = completedSet.games[0];
        themGamesAfter = completedSet.games[1];
      }

      let tbScoreText = null;
      if (isTieBreak) {
        if (setEndedOnGame && Array.isArray(completedSet?.tieBreakPoints)) {
          tbScoreText = `${completedSet.tieBreakPoints[0]}–${completedSet.tieBreakPoints[1]}`;
        } else if (isIncomplete) {
          tbScoreText = `${summary.points[0]}–${summary.points[1]}`;
        } else {
          tbScoreText = `${lastRow.postPointsLabel[0]}–${lastRow.postPointsLabel[1]}`;
        }
      }

      let ueCount = 0;
      const points = gameRows.map((r, pIdx) => {
        if (r.code === 'E') ueCount += 1;
        const isLastPointOfGame = pIdx === gameRows.length - 1;
        const endedHere = isLastPointOfGame && gameEnded;

        let usLabel = r.postPointsLabel[0];
        let themLabel = r.postPointsLabel[1];

        if (isTieBreak) {
          if (endedHere && setEndedOnGame && Array.isArray(completedSet?.tieBreakPoints)) {
            usLabel = String(completedSet.tieBreakPoints[0]);
            themLabel = String(completedSet.tieBreakPoints[1]);
          }
        } else if (endedHere) {
          const isGp = Array.isArray(r.clutchLabels) && r.clutchLabels.includes('goldenPoint');
          const winMark = isGp ? 'GP' : 'G';
          usLabel = r.code === 'A' ? winMark : '·';
          themLabel = r.code === 'A' ? '·' : winMark;
        } else {
          const wasAd = r.prePointsLabel[0] === 'AD' || r.prePointsLabel[1] === 'AD';
          const isDeuceReset = wasAd && r.postPointsLabel[0] === '40' && r.postPointsLabel[1] === '40';
          if (isDeuceReset) {
            usLabel = r.code === 'A' ? 'D' : '40';
            themLabel = r.code === 'A' ? '40' : 'D';
          }
        }

        return Object.freeze({
          pointNumber: r.pointNumber,
          code: r.code,
          usLabel,
          themLabel,
          isGameWin: endedHere,
        });
      });

      const gameIndex = games.length;
      games.push(
        Object.freeze({
          index: gameIndex,
          label: isTieBreak ? 'TB' : String(gameIndex + 1),
          isTieBreak,
          isIncomplete,
          server,
          winner,
          isBreak,
          usGamesAfter,
          themGamesAfter,
          tbScoreText,
          ueCount,
          points: Object.freeze(points),
        })
      );
    };

    for (const r of rows) {
      currentGameRows.push(r);
      const preSetsSum = (r.preSets?.[0] ?? 0) + (r.preSets?.[1] ?? 0);
      const postSetsSum = (r.postSets?.[0] ?? 0) + (r.postSets?.[1] ?? 0);
      const preGamesSum = (r.preGames?.[0] ?? 0) + (r.preGames?.[1] ?? 0);
      const postGamesSum = (r.postGames?.[0] ?? 0) + (r.postGames?.[1] ?? 0);

      const setEndedHere = postSetsSum > preSetsSum;
      const gameEndedHere = setEndedHere || postGamesSum > preGamesSum;

      if (gameEndedHere) {
        flushGame(currentGameRows, true, setEndedHere);
        currentGameRows = [];
      }
    }

    if (currentGameRows.length > 0) {
      flushGame(currentGameRows, false, false);
    }

    // Default selected game: highest UE count (tie-break: latest game; all 0 -> last game)
    let defaultGameIndex = Math.max(0, games.length - 1);
    let maxUe = 0;
    for (let i = 0; i < games.length; i += 1) {
      if (games[i].ueCount > 0 && games[i].ueCount >= maxUe) {
        maxUe = games[i].ueCount;
        defaultGameIndex = i;
      }
    }

    const finalUs = completedSet ? completedSet.games[0] : summary.games[0];
    const finalThem = completedSet ? completedSet.games[1] : summary.games[1];

    sets.push(
      Object.freeze({
        setNumber: setNum,
        scoreText: `${finalUs}–${finalThem}`,
        isIncomplete: !completedSet,
        defaultGameIndex,
        games: Object.freeze(games),
      })
    );
  }

  return Object.freeze({
    isEmpty: sets.length === 0,
    sets: Object.freeze(sets),
  });
}

/**
 * Deterministic 1-line match takeaway combining error spikes/clusters and service hold or serve/return skew.
 */
export function buildMatchTakeaway(analytics, setFlow = null) {
  const counts = analytics?.summary?.counts;
  if (!counts || counts.totalPoints === 0) {
    return 'No points recorded yet.';
  }
  const pointsLost = (counts.themOtherPoints || 0) + (counts.myUePoints || 0);
  if (pointsLost === 0) {
    return 'Flawless — zero points lost.';
  }
  if ((counts.myUePoints || 0) === 0) {
    return 'Zero unforced errors recorded.';
  }

  const flow = setFlow ?? buildSetFlowModel(analytics);
  const parts = [];

  // Fact 1: Heavy single error game (>=3 UEs) or cluster count
  let worstGame = null;
  for (const s of flow.sets) {
    for (const g of s.games) {
      if (g.ueCount >= 3 && (!worstGame || g.ueCount > worstGame.ueCount)) {
        worstGame = { setNumber: s.setNumber, label: g.label, ueCount: g.ueCount, isTieBreak: g.isTieBreak };
      }
    }
  }
  const clusterCount = analytics?.clusters?.length ?? 0;
  if (worstGame) {
    const gameRef = worstGame.isTieBreak ? `S${worstGame.setNumber} TB` : `S${worstGame.setNumber} G${worstGame.label}`;
    parts.push(`Heavy error game in ${gameRef} (${worstGame.ueCount} UEs)`);
  } else if (clusterCount > 0) {
    parts.push(`${clusterCount} error ${clusterCount === 1 ? 'streak' : 'streaks'}`);
  }

  // Fact 2: Ordinary service hold or serve/return UE skew
  const hold = analytics?.serviceHold;
  if (hold && hold.completedOrdinaryServiceGames > 0) {
    parts.push(`Held ${hold.ordinaryServiceGamesWon} of ${hold.completedOrdinaryServiceGames} serves`);
  } else {
    const srv = analytics?.serveReturn?.serving?.myUePoints ?? 0;
    const ret = analytics?.serveReturn?.returning?.myUePoints ?? 0;
    if (ret > srv) parts.push(`${ret} of ${counts.myUePoints} UEs while returning`);
    else if (srv > ret) parts.push(`${srv} of ${counts.myUePoints} UEs while serving`);
  }

  if (parts.length === 0) {
    return `${counts.myUePoints} My UEs across ${counts.totalPoints} rallies played.`;
  }
  return `${parts.join(' · ')}.`;
}

/**
 * DST-safe local human match date formatter computed at render time (never cached across midnight).
 * Uses local calendar day comparison via Date(y, m, d - 1) so daylight-saving shifts never misclassify Yesterday.
 */
export function formatLocalMatchDate(timestampMs, nowMs = Date.now()) {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) {
    return 'Undated';
  }
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) {
    return 'Undated';
  }
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());

  const pad2 = (n) => String(n).padStart(2, '0');
  const timeStr = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  const dY = d.getFullYear();
  const dM = d.getMonth();
  const dD = d.getDate();

  const nY = now.getFullYear();
  const nM = now.getMonth();
  const nD = now.getDate();

  if (dY === nY && dM === nM && dD === nD) {
    return `Today ${timeStr}`;
  }

  const yesterday = new Date(nY, nM, nD - 1);
  if (dY === yesterday.getFullYear() && dM === yesterday.getMonth() && dD === yesterday.getDate()) {
    return `Yesterday ${timeStr}`;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = MONTHS[dM] ?? String(dM + 1);
  if (dY === nY) {
    return `${monthName} ${dD} ${timeStr}`;
  }
  return `${monthName} ${dD}, ${dY} ${timeStr}`;
}
