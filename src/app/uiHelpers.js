import { normalizeWristCenterMode, WRIST_CENTER_MODES } from '../core/wristEditMode.js';
import { formatWristDisplay } from '../core/wristDisplay.js';

export const TAPE_VIEWBOX_WIDTH = 360;
export const TAPE_VIEWBOX_HEIGHT = 82;
export const TAPE_MAX_INDIVIDUAL_POINTS = 72;
export const TAPE_BIN_COUNT = 60;

function escapeAttr(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

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
        title: preview.title,
        artist: preview.artist,
        emphasis: 'neutral',
        keys: Object.freeze([
          Object.freeze({ symbol: '<', label: 'US serves', tone: 'us', disabled: false, highlight: false }),
          Object.freeze({ symbol: '||', label: 'Inactive', tone: 'muted', disabled: true, highlight: false }),
          Object.freeze({ symbol: '>', label: 'THEM serves', tone: 'them', disabled: false, highlight: false }),
        ]),
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
      title: preview.title,
      artist: preview.artist,
      emphasis: 'neutral',
      keys: Object.freeze([
        Object.freeze({ symbol: '<', label: 'US +1', tone: 'us', disabled: false, highlight: false }),
        Object.freeze({
          symbol: '||',
          label: isEditMode ? 'Edit point' : 'My error · +1 THEM',
          tone: isEditMode ? 'neutral' : 'ue',
          disabled: false,
          highlight: false,
        }),
        Object.freeze({ symbol: '>', label: 'THEM +1', tone: 'them', disabled: false, highlight: false }),
      ]),
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
      title,
      artist,
      emphasis: 'resume',
      keys: Object.freeze([
        Object.freeze({ symbol: '<', label: 'Inactive', tone: 'muted', disabled: true, highlight: false }),
        Object.freeze({ symbol: '||', label: 'Resume scoring', tone: 'accent', disabled: false, highlight: true }),
        Object.freeze({ symbol: '>', label: 'Inactive', tone: 'muted', disabled: true, highlight: false }),
      ]),
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
      title,
      artist,
      emphasis: 'edit',
      keys: Object.freeze([
        Object.freeze({
          symbol: '<',
          label: canUndo ? 'Undo last point' : 'Undo unavailable',
          tone: canUndo ? 'us' : 'muted',
          disabled: !canUndo,
          highlight: false,
        }),
        Object.freeze({ symbol: '||', label: 'Keep Edit open', tone: 'neutral', disabled: false, highlight: false }),
        Object.freeze({ symbol: '>', label: 'My error · +1 THEM', tone: 'ue', disabled: false, highlight: false }),
      ]),
      afterWarmupNote: null,
    });
  }

  if (isActive && state.needsInitialServer) {
    return Object.freeze({
      phase: 'WARMUP',
      showKeys: true,
      headline: 'Who serves first?',
      subcue: '< selects US and > selects THEM. Neither awards a point.',
      title,
      artist,
      emphasis: 'warmup',
      keys: Object.freeze([
        Object.freeze({ symbol: '<', label: 'US serves', tone: 'us', disabled: false, highlight: false }),
        Object.freeze({ symbol: '||', label: 'Inactive', tone: 'muted', disabled: true, highlight: false }),
        Object.freeze({ symbol: '>', label: 'THEM serves', tone: 'them', disabled: false, highlight: false }),
      ]),
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
    title,
    artist,
    emphasis: 'live',
    keys: Object.freeze([
      Object.freeze({ symbol: '<', label: 'US +1', tone: 'us', disabled: false, highlight: false }),
      Object.freeze({
        symbol: '||',
        label: isEditMode ? 'Edit point' : 'My error · +1 THEM',
        tone: isEditMode ? 'neutral' : 'ue',
        disabled: false,
        highlight: false,
      }),
      Object.freeze({ symbol: '>', label: 'THEM +1', tone: 'them', disabled: false, highlight: false }),
    ]),
    afterWarmupNote: null,
  });
}

/**
 * Returns visual steps for the Band 9 Active Quick Guide sheet.
 * Shows the warmup server-picker step ONLY while the Band displays WHO SERVES? (or Setup is set to Pick on Band).
 * When a server is already fixed or selected, leads directly with live scoring keys so the player never awards an unintended point.
 */
export function getBandGuideSteps(wristCenterMode, { showWarmupStep = false } = {}) {
  const isEditMode = normalizeWristCenterMode(wristCenterMode) === WRIST_CENTER_MODES.EDIT_MODE;
  const rawSteps = [];

  if (showWarmupStep) {
    rawSteps.push({
      title: 'Pick first server (only while WHO SERVES? is shown)',
      bandTitle: 'WHO SERVES? #1',
      bandArtist: '< US   THEM >',
      caption: 'After the 4-touch warmup, tap < for US or > for THEM. No point is added.',
    });
  }

  if (isEditMode) {
    rawSteps.push(
      {
        title: 'Score normal rallies',
        bandTitle: '*30-15 2-1 #9',
        bandArtist: 'S0-0 UE:1',
        caption: 'As soon as the server is set (including 0-0), < awards US +1, > awards THEM +1, and || opens Edit point.',
      },
      {
        title: 'Choose Undo or My Error',
        bandTitle: 'EDIT #9',
        bandArtist: '<UNDO   UE>',
        caption: 'Inside Edit: tap < to Undo last point, or > to log My UE (+1 THEM). At 0 points, Undo is unavailable — cancel on phone if opened by mistake.',
      },
      {
        title: 'Press || to resume scoring',
        bandTitle: 'UE *30-30 #10',
        bandArtist: 'TAP || FOR LIVE',
        caption: 'Important: arrows (< and >) stay inactive after Undo or My UE so double-taps never mis-score. Press || before scoring the next rally.',
      }
    );
  } else {
    rawSteps.push(
      {
        title: 'Score & log My UE in 1 tap',
        bandTitle: '*30-15 2-1 #9',
        bandArtist: 'S0-0 UE:1',
        caption: 'As soon as the server is set (including 0-0), < awards US +1, > awards THEM +1, and || logs My UE (+1 THEM) immediately.',
      },
      {
        title: 'Undo on phone (or switch to Edit point)',
        bandTitle: '0-0 2-1 #10',
        bandArtist: 'S0-0 UE:1',
        caption: 'In 1-Tap My Error mode, Undo is on the phone screen. Switch to Edit point in Match Menu to undo from your wrist.',
      },
      {
        title: 'Check Band before locking phone',
        bandTitle: 'US SERVES #2',
        bandArtist: '0-0 0-0 S0-0',
        caption: 'Open Band Music Controls once to confirm PadelScore appears without pressing an arrow, then lock your phone.',
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
 * Pure geometry model for the post-match Rally Tape.
 * Uses analytics.timeline (derived from the authoritative scoring replay) so completed-set
 * dividers match real set boundaries (including tie-breaks inside their set and open unfinished sets).
 * Automatically aggregates dense matches (> 72 rallies) into fixed horizontal bins so 300+ rally
 * matches stay readable with zero colliding bars.
 */
export function buildMatchTapeData(analytics) {
  const timeline = Array.isArray(analytics?.timeline) ? analytics.timeline : [];
  const totalPoints = timeline.length;

  if (totalPoints === 0) {
    return Object.freeze({
      isEmpty: true,
      aggregated: false,
      totalPoints: 0,
      usPoints: 0,
      themOtherPoints: 0,
      myUePoints: 0,
      setDividers: Object.freeze([]),
      setLabels: Object.freeze([]),
      marks: Object.freeze([]),
    });
  }

  const padX = 12;
  const usableW = TAPE_VIEWBOX_WIDTH - padX * 2;
  const midY = 38;
  const maxBarH = 22;

  let usPoints = 0;
  let themOtherPoints = 0;
  let myUePoints = 0;

  const completedEndIndices = [];
  for (let i = 0; i < totalPoints; i += 1) {
    const row = timeline[i];
    if (row.code === 'A') usPoints += 1;
    else if (row.code === 'E') myUePoints += 1;
    else themOtherPoints += 1;

    const preSum = (row.preSets?.[0] ?? 0) + (row.preSets?.[1] ?? 0);
    const postSum = (row.postSets?.[0] ?? 0) + (row.postSets?.[1] ?? 0);
    if (postSum > preSum && i < totalPoints - 1) {
      completedEndIndices.push(i);
    }
  }

  const xForBoundary = (afterIdx) => {
    const ratio = (afterIdx + 1) / totalPoints;
    return round1(padX + ratio * usableW);
  };

  const setDividers = completedEndIndices.map((idx, k) =>
    Object.freeze({
      afterPointNumber: idx + 1,
      setCompleted: k + 1,
      x: xForBoundary(idx),
    })
  );

  const segmentBounds = [0, ...completedEndIndices.map((idx) => idx + 1), totalPoints];
  const setLabels = [];
  for (let s = 0; s < segmentBounds.length - 1; s += 1) {
    const start = segmentBounds[s];
    const end = segmentBounds[s + 1];
    if (end <= start) continue;
    const midRatio = ((start + end) / 2) / totalPoints;
    setLabels.push(
      Object.freeze({
        label: `S${s + 1}`,
        x: round1(padX + midRatio * usableW),
      })
    );
  }

  if (totalPoints <= TAPE_MAX_INDIVIDUAL_POINTS) {
    const step = usableW / totalPoints;
    const barW = round1(Math.max(2, Math.min(8, step * 0.62)));
    const marks = timeline.map((row, idx) => {
      const cx = totalPoints === 1 ? round1(TAPE_VIEWBOX_WIDTH / 2) : round1(padX + (idx + 0.5) * step);
      return Object.freeze({
        kind: row.code,
        pointNumber: row.pointNumber,
        cx,
        x: round1(cx - barW / 2),
        w: barW,
        midY,
        h: row.code === 'E' ? 21 : row.code === 'A' ? 16 : 13,
        ueCount: row.code === 'E' ? 1 : 0,
      });
    });

    return Object.freeze({
      isEmpty: false,
      aggregated: false,
      totalPoints,
      usPoints,
      themOtherPoints,
      myUePoints,
      setDividers: Object.freeze(setDividers),
      setLabels: Object.freeze(setLabels),
      marks: Object.freeze(marks),
    });
  }

  const binCount = TAPE_BIN_COUNT;
  const bins = Array.from({ length: binCount }, () => ({
    usCount: 0,
    themOtherCount: 0,
    ueCount: 0,
  }));

  for (let i = 0; i < totalPoints; i += 1) {
    const b = Math.min(binCount - 1, Math.floor((i * binCount) / totalPoints));
    const code = timeline[i].code;
    if (code === 'A') bins[b].usCount += 1;
    else if (code === 'E') bins[b].ueCount += 1;
    else bins[b].themOtherCount += 1;
  }

  let maxSide = 1;
  for (const bin of bins) {
    const down = bin.themOtherCount + bin.ueCount;
    if (bin.usCount > maxSide) maxSide = bin.usCount;
    if (down > maxSide) maxSide = down;
  }

  const binStep = usableW / binCount;
  const barW = round1(Math.max(2.5, binStep * 0.72));
  const marks = bins.map((bin, b) => {
    const cx = round1(padX + (b + 0.5) * binStep);
    const usH = bin.usCount > 0 ? round1(Math.max(3, (bin.usCount / maxSide) * maxBarH)) : 0;
    const themH = bin.themOtherCount > 0 ? round1(Math.max(3, (bin.themOtherCount / maxSide) * maxBarH)) : 0;
    const ueH = bin.ueCount > 0 ? round1(Math.max(5, (bin.ueCount / maxSide) * maxBarH)) : 0;
    return Object.freeze({
      kind: 'BIN',
      binIndex: b,
      cx,
      x: round1(cx - barW / 2),
      w: barW,
      midY,
      usCount: bin.usCount,
      themOtherCount: bin.themOtherCount,
      ueCount: bin.ueCount,
      usH,
      themH,
      ueH,
    });
  });

  return Object.freeze({
    isEmpty: false,
    aggregated: true,
    totalPoints,
    usPoints,
    themOtherPoints,
    myUePoints,
    setDividers: Object.freeze(setDividers),
    setLabels: Object.freeze(setLabels),
    marks: Object.freeze(marks),
  });
}

/**
 * Renders the Match Rally Tape as a self-contained accessible inline SVG string.
 * Uses distinct coral diamond-capped spikes for MY UE so coral never carries meaning by color alone.
 */
export function renderMatchTapeSvg(analytics) {
  const data = buildMatchTapeData(analytics);
  if (data.isEmpty) {
    return '<div class="tape-empty">No points recorded.</div>';
  }

  const midY = 38;
  const parts = [];

  parts.push(
    `<rect x="0" y="0" width="${TAPE_VIEWBOX_WIDTH}" height="${TAPE_VIEWBOX_HEIGHT}" fill="#081B38"/>`
  );
  parts.push(
    `<line x1="8" y1="${midY}" x2="${TAPE_VIEWBOX_WIDTH - 8}" y2="${midY}" stroke="rgba(244,247,251,0.45)" stroke-width="1.2"/>`
  );

  for (const d of data.setDividers) {
    parts.push(
      `<line x1="${d.x}" y1="14" x2="${d.x}" y2="${TAPE_VIEWBOX_HEIGHT - 8}" stroke="rgba(244,247,251,0.5)" stroke-width="1" stroke-dasharray="3 2"/>`
    );
  }
  for (const lbl of data.setLabels) {
    parts.push(
      `<text x="${lbl.x}" y="11" text-anchor="middle" fill="#9BB5D6" font-size="9" font-family="ui-monospace,monospace" font-weight="700">${escapeAttr(lbl.label)}</text>`
    );
  }

  if (!data.aggregated) {
    for (const m of data.marks) {
      if (m.kind === 'A') {
        const y = round1(midY - m.h);
        parts.push(`<rect x="${m.x}" y="${y}" width="${m.w}" height="${m.h}" fill="#F4F7FB"/>`);
      } else if (m.kind === 'B') {
        parts.push(`<rect x="${m.x}" y="${midY + 1}" width="${m.w}" height="${m.h}" fill="#4A74B0"/>`);
      } else {
        const tipY = round1(midY + m.h + 4);
        parts.push(
          `<rect x="${m.x}" y="${midY + 1}" width="${m.w}" height="${m.h}" fill="#FF5C4D"/>`
        );
        parts.push(
          `<polygon points="${m.cx},${tipY + 3.5} ${round1(m.cx + 3.2)},${tipY} ${m.cx},${tipY - 3.5} ${round1(m.cx - 3.2)},${tipY}" fill="#FF5C4D"/>`
        );
      }
    }
  } else {
    for (const m of data.marks) {
      if (m.usH > 0) {
        parts.push(
          `<rect x="${m.x}" y="${round1(midY - m.usH)}" width="${m.w}" height="${m.usH}" fill="#F4F7FB"/>`
        );
      }
      if (m.themH > 0) {
        parts.push(
          `<rect x="${m.x}" y="${midY + 1}" width="${m.w}" height="${m.themH}" fill="#4A74B0"/>`
        );
      }
      if (m.ueH > 0) {
        const ueStartY = round1(midY + 1 + m.themH);
        const clampedH = round1(Math.min(m.ueH, TAPE_VIEWBOX_HEIGHT - 12 - ueStartY));
        const finalH = Math.max(3, clampedH);
        const tipY = round1(ueStartY + finalH + 3);
        parts.push(
          `<rect x="${m.x}" y="${ueStartY}" width="${m.w}" height="${finalH}" fill="#FF5C4D"/>`
        );
        parts.push(
          `<polygon points="${m.cx},${tipY + 3} ${round1(m.cx + 2.6)},${tipY} ${m.cx},${tipY - 3} ${round1(m.cx - 2.6)},${tipY}" fill="#FF5C4D"/>`
        );
      }
    }
  }

  const ariaLabel = `Rally timeline: ${data.usPoints} US points, ${data.themOtherPoints} other THEM points, ${data.myUePoints} My unforced errors across ${data.totalPoints} total points${data.aggregated ? ' (grouped by match progression)' : ''}.`;

  return `<svg class="match-tape-svg" viewBox="0 0 ${TAPE_VIEWBOX_WIDTH} ${TAPE_VIEWBOX_HEIGHT}" role="img" aria-label="${escapeAttr(ariaLabel)}" preserveAspectRatio="none">${parts.join('')}</svg>`;
}
