function joinTokens(tokens) {
  return tokens.filter(Boolean).join(' ');
}

function assertBudget(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: expected positive integer`);
  }
}

function fitTokens(tokens, maxLen) {
  const kept = [];
  for (const tok of tokens) {
    if (!tok) continue;
    const candidate = kept.length === 0 ? tok : `${kept.join(' ')} ${tok}`;
    if (candidate.length <= maxLen) {
      kept.push(tok);
    }
  }
  return kept.join(' ');
}

function fitWithRequiredFirst(requiredToken, optionalTokens, maxLen) {
  if (requiredToken.length > maxLen) {
    return null;
  }
  const kept = [requiredToken];
  for (const tok of optionalTokens) {
    if (!tok) continue;
    const candidate = `${kept.join(' ')} ${tok}`;
    if (candidate.length <= maxLen) {
      kept.push(tok);
    }
  }
  return kept.join(' ');
}

function formatUePct(ratio) {
  if (ratio === null || ratio === undefined) return '—';
  if (ratio === 0) return '0%';
  const rounded = Math.round(ratio * 100);
  if (ratio > 0 && rounded === 0) return '<1%';
  return `${rounded}%`;
}

function buildCompactTbToken(points, server, includeServeMarker) {
  const diff = points[0] - points[1];
  const base =
    diff === 0 ? 'TB TIED' : diff > 0 ? `TB US +${diff}` : `TB THM +${Math.abs(diff)}`;
  if (!includeServeMarker) return base;
  return server === 0 ? `*${base}` : `${base}*`;
}

/**
 * Tries candidate layouts in priority order. Each candidate specifies:
 * - titleTokens (all must fit on title)
 * - revOnTitle (boolean: whether revTok is already inside titleTokens)
 * - artistRequiredToken (optional indivisible token required on artist)
 * - artistOptionalTokens (placed on artist; if !revOnTitle, revTok is REQUIRED first on artist)
 * Guarantees whole tokens (never slices numbers) and guarantees revTok is ALWAYS displayed.
 */
function resolveLayout(candidates, revTok, maxTitleLen, maxArtistLen) {
  for (const cand of candidates) {
    const title = joinTokens(cand.titleTokens);
    if (title.length === 0 || title.length > maxTitleLen) continue;

    const optional = cand.artistOptionalTokens ?? [];

    if (cand.revOnTitle) {
      if (cand.artistRequiredToken) {
        const artist = fitWithRequiredFirst(cand.artistRequiredToken, optional, maxArtistLen);
        if (artist !== null) {
          return { title, artist };
        }
        continue;
      }
      const artist = fitTokens(optional, maxArtistLen);
      return { title, artist };
    }

    const requiredArtist = cand.artistRequiredToken ? joinTokens([revTok, cand.artistRequiredToken]) : revTok;
    const artist = fitWithRequiredFirst(requiredArtist, optional, maxArtistLen);
    if (artist !== null) {
      return { title, artist };
    }
  }

  throw new Error(
    `Cannot format wrist display within maxTitleLen=${maxTitleLen}, maxArtistLen=${maxArtistLen} without dropping required score or revision token "${revTok}"`
  );
}

/**
 * Formats a 2-line wrist display ({ title, artist }) strictly from whole tokens.
 * Guarantees the whole revision token (#rev) is always rendered on either title or artist
 * (throws if neither line budget can hold the minimum truthful score + #rev).
 */
export function formatWristDisplay(
  state,
  { maxTitleLen = 20, maxArtistLen = 20, showSwap = false, editState = null } = {}
) {
  assertBudget(maxTitleLen, 'maxTitleLen');
  assertBudget(maxArtistLen, 'maxArtistLen');

  const revTok = `#${state.revision}`;
  const setsTok = `S${state.sets[0]}-${state.sets[1]}`;
  const ueTok = `UE:${state.counts.myUePoints}`;
  const swapTok = showSwap && state.changeEndsAlert ? 'SWP' : '';

  if (state.status === 'WON') {
    const outcome = state.winner === 0 ? 'WIN' : 'LOSS';
    const scoreTok = `${state.sets[0]}-${state.sets[1]}`;
    const pctTok = formatUePct(state.myUePctOfPointsLost);

    return resolveLayout(
      [
        { titleTokens: [outcome, scoreTok, revTok], revOnTitle: true, artistOptionalTokens: [ueTok, pctTok] },
        { titleTokens: [outcome, scoreTok], revOnTitle: false, artistOptionalTokens: [ueTok, pctTok] },
        { titleTokens: [outcome, revTok], revOnTitle: true, artistOptionalTokens: [scoreTok, ueTok, pctTok] },
      ],
      revTok,
      maxTitleLen,
      maxArtistLen
    );
  }

  if (state.status === 'FINISHED_MANUAL') {
    const ptsTok = `${state.pointsLabel[0]}-${state.pointsLabel[1]}`;
    const gamesTok = state.inTieBreak ? 'TB' : `${state.games[0]}-${state.games[1]}`;
    const hasLivePoints = state.points[0] > 0 || state.points[1] > 0 || state.inTieBreak;

    const candidates = [];
    if (hasLivePoints) {
      candidates.push({
        titleTokens: ['END', ptsTok, gamesTok, revTok],
        revOnTitle: true,
        artistOptionalTokens: [setsTok, ueTok],
      });
      candidates.push({
        titleTokens: ['END', ptsTok, gamesTok],
        revOnTitle: false,
        artistOptionalTokens: [setsTok, ueTok],
      });
      // Keep exact points on title and move TB / games token to artist when space permits
      candidates.push({
        titleTokens: ['END', ptsTok, revTok],
        revOnTitle: true,
        artistOptionalTokens: [gamesTok, setsTok, ueTok],
      });
      candidates.push({
        titleTokens: ['END', ptsTok],
        revOnTitle: false,
        artistOptionalTokens: [gamesTok, setsTok, ueTok],
      });
      // Preserve live point score on artist before falling back to games alone (e.g. END AD-40 at 8/20)
      candidates.push({
        titleTokens: ['END', gamesTok, revTok],
        revOnTitle: true,
        artistRequiredToken: ptsTok,
        artistOptionalTokens: [setsTok, ueTok],
      });
      candidates.push({
        titleTokens: ['END', gamesTok],
        revOnTitle: false,
        artistRequiredToken: ptsTok,
        artistOptionalTokens: [setsTok, ueTok],
      });
      candidates.push({
        titleTokens: ['END', revTok],
        revOnTitle: true,
        artistRequiredToken: ptsTok,
        artistOptionalTokens: [gamesTok, setsTok, ueTok],
      });
      candidates.push({
        titleTokens: ['END'],
        revOnTitle: false,
        artistRequiredToken: ptsTok,
        artistOptionalTokens: [gamesTok, setsTok, ueTok],
      });
    }

    if (state.inTieBreak) {
      const compactTb = buildCompactTbToken(state.points, state.server, false);
      candidates.push({
        titleTokens: ['END', compactTb, revTok],
        revOnTitle: true,
        artistOptionalTokens: [setsTok, ueTok],
      });
      candidates.push({
        titleTokens: ['END', compactTb],
        revOnTitle: false,
        artistOptionalTokens: [setsTok, ueTok],
      });
    }

    candidates.push({
      titleTokens: ['END', gamesTok, revTok],
      revOnTitle: true,
      artistOptionalTokens: [setsTok, ueTok],
    });
    candidates.push({
      titleTokens: ['END', gamesTok],
      revOnTitle: false,
      artistOptionalTokens: [setsTok, ueTok],
    });

    return resolveLayout(candidates, revTok, maxTitleLen, maxArtistLen);
  }

  // S4.2 Explicit EDIT #<rev> prompt & AWAITING_LIVE gate (only when revision-matched to ACTIVE state)
  const matchesEditOverlay = Boolean(
    editState &&
      editState.phase !== 'LIVE' &&
      editState.baseRevision === state.revision &&
      (!editState.matchId || !state.matchId || editState.matchId === state.matchId)
  );

  if (matchesEditOverlay && editState.phase === 'PROMPT') {
    const canUndo = editState.canUndo !== false && (state.counts?.totalPoints ?? 1) > 0;
    const promptCandidates = canUndo
      ? [
          { titleTokens: ['EDIT', revTok], revOnTitle: true, artistRequiredToken: '<UNDO   UE>' },
          { titleTokens: ['EDIT', revTok], revOnTitle: true, artistRequiredToken: '<UNDO UE>' },
          { titleTokens: ['EDIT'], revOnTitle: false, artistRequiredToken: '<UNDO UE>' },
          { titleTokens: ['<UNDO UE>', revTok], revOnTitle: true, artistOptionalTokens: ['EDIT'] },
          { titleTokens: ['<UNDO UE>'], revOnTitle: false, artistOptionalTokens: ['EDIT'] },
        ]
      : [
          { titleTokens: ['EDIT', revTok], revOnTitle: true, artistRequiredToken: 'NO UNDO UE>' },
          { titleTokens: ['EDIT'], revOnTitle: false, artistRequiredToken: 'NO UNDO UE>' },
          { titleTokens: ['NO UNDO'], revOnTitle: false, artistRequiredToken: 'UE>', artistOptionalTokens: ['EDIT'] },
          { titleTokens: ['NO UNDO UE>', revTok], revOnTitle: true, artistOptionalTokens: ['EDIT'] },
          { titleTokens: ['NO UNDO UE>'], revOnTitle: false, artistOptionalTokens: ['EDIT'] },
        ];

    return resolveLayout(promptCandidates, revTok, maxTitleLen, maxArtistLen);
  }

  if (matchesEditOverlay && editState.phase === 'AWAITING_LIVE') {
    if (editState.reason === 'UNDO' || editState.reason === 'UE') {
      const tag = editState.reason;
      const isLoveAll =
        !state.inTieBreak &&
        state.sets[0] === 0 &&
        state.sets[1] === 0 &&
        state.games[0] === 0 &&
        state.games[1] === 0 &&
        state.points[0] === 0 &&
        state.points[1] === 0 &&
        (state.counts?.totalPoints ?? 0) === 0;
      const srvUs = !isLoveAll && state.server === 0 ? '*' : '';
      const srvThem = !isLoveAll && state.server === 1 ? '*' : '';
      const ptsTok = `${srvUs}${state.pointsLabel[0]}-${state.pointsLabel[1]}${srvThem}`;

      return resolveLayout(
        [
          { titleTokens: [tag, ptsTok, revTok], revOnTitle: true, artistRequiredToken: 'TAP || FOR LIVE' },
          { titleTokens: [tag, ptsTok, revTok], revOnTitle: true, artistRequiredToken: '|| FOR LIVE' },
          { titleTokens: [tag, revTok], revOnTitle: true, artistRequiredToken: `${ptsTok} || TO LIVE` },
          { titleTokens: [tag, ptsTok], revOnTitle: false, artistRequiredToken: '|| LIVE' },
          { titleTokens: [tag, revTok], revOnTitle: true, artistRequiredToken: '|| TO LIVE' },
          { titleTokens: [tag, revTok], revOnTitle: true, artistRequiredToken: '|| LIVE' },
          { titleTokens: [tag], revOnTitle: false, artistRequiredToken: '|| LIVE', artistOptionalTokens: [ptsTok] },
          { titleTokens: [tag], revOnTitle: false, artistRequiredToken: '||', artistOptionalTokens: [ptsTok] },
        ],
        revTok,
        maxTitleLen,
        maxArtistLen
      );
    }

    // INVALIDATED (phone edit, Cancel, mode switch, or Re-link after interruption)
    return resolveLayout(
      [
        { titleTokens: ['EDIT OFF', revTok], revOnTitle: true, artistRequiredToken: 'TAP || FOR LIVE' },
        { titleTokens: ['EDIT OFF', revTok], revOnTitle: true, artistRequiredToken: '|| FOR LIVE' },
        { titleTokens: ['EDIT OFF', revTok], revOnTitle: true, artistRequiredToken: '|| LIVE' },
        { titleTokens: ['EDIT OFF'], revOnTitle: false, artistRequiredToken: '|| LIVE' },
        { titleTokens: ['EDIT OFF'], revOnTitle: false, artistRequiredToken: '||' },
      ],
      revTok,
      maxTitleLen,
      maxArtistLen
    );
  }

  // ACTIVE match awaiting first server selection from watch (after 4-touch warmup point)
  if (state.server === null) {
    return resolveLayout(
      [
        { titleTokens: ['WHO SERVES?', revTok], revOnTitle: true, artistRequiredToken: '< US   THEM >' },
        { titleTokens: ['SERVE?', revTok], revOnTitle: true, artistRequiredToken: '< US THEM >' },
        { titleTokens: ['SERVE?', revTok], revOnTitle: true, artistRequiredToken: '<US THEM>' },
        { titleTokens: ['<US THEM>', revTok], revOnTitle: true, artistOptionalTokens: ['SERVE?'] },
        { titleTokens: ['<US THEM>'], revOnTitle: false, artistOptionalTokens: ['SERVE?'] },
        { titleTokens: ['SERVE?'], revOnTitle: false, artistRequiredToken: '<US THEM>' },
      ],
      revTok,
      maxTitleLen,
      maxArtistLen
    );
  }

  // Love-all confirmation right after server selection (0 points played): unmistakably confirms who serves
  const isLoveAllStart =
    !state.inTieBreak &&
    state.sets[0] === 0 &&
    state.sets[1] === 0 &&
    state.games[0] === 0 &&
    state.games[1] === 0 &&
    state.points[0] === 0 &&
    state.points[1] === 0 &&
    (state.counts?.totalPoints ?? 0) === 0;

  if (isLoveAllStart) {
    const serveHeadline = state.server === 0 ? 'US SERVES' : 'THEM SERVES';
    const serveShort = state.server === 0 ? 'US SRV' : 'THM SRV';
    return resolveLayout(
      [
        { titleTokens: [serveHeadline, revTok], revOnTitle: true, artistOptionalTokens: ['0-0', '0-0', setsTok] },
        { titleTokens: [serveHeadline], revOnTitle: false, artistOptionalTokens: ['0-0', '0-0', setsTok] },
        { titleTokens: [serveShort, revTok], revOnTitle: true, artistOptionalTokens: ['0-0', setsTok] },
        { titleTokens: [serveShort], revOnTitle: false, artistOptionalTokens: ['0-0', setsTok] },
        { titleTokens: ['0-0', revTok], revOnTitle: true, artistRequiredToken: serveHeadline, artistOptionalTokens: [setsTok] },
        { titleTokens: ['0-0', revTok], revOnTitle: true, artistRequiredToken: serveShort, artistOptionalTokens: [setsTok] },
        { titleTokens: ['0-0'], revOnTitle: false, artistRequiredToken: serveHeadline, artistOptionalTokens: [setsTok] },
        { titleTokens: ['0-0'], revOnTitle: false, artistRequiredToken: serveShort, artistOptionalTokens: [setsTok] },
      ],
      revTok,
      maxTitleLen,
      maxArtistLen
    );
  }

  // ACTIVE match (always our-team-first order)
  const srvUs = state.server === 0 ? '*' : '';
  const srvThem = state.server === 1 ? '*' : '';
  const ptsTok = `${srvUs}${state.pointsLabel[0]}-${state.pointsLabel[1]}${srvThem}`;
  const gamesTok = state.inTieBreak ? 'TB' : `${state.games[0]}-${state.games[1]}`;

  const candidates = [
    {
      titleTokens: [ptsTok, gamesTok, revTok],
      revOnTitle: true,
      artistOptionalTokens: [setsTok, ueTok, swapTok],
    },
    {
      titleTokens: [ptsTok, gamesTok],
      revOnTitle: false,
      artistOptionalTokens: [setsTok, ueTok, swapTok],
    },
  ];

  if (state.inTieBreak) {
    const compactSrv = buildCompactTbToken(state.points, state.server, true);
    const compactPlain = buildCompactTbToken(state.points, state.server, false);
    candidates.push(
      { titleTokens: [compactSrv, revTok], revOnTitle: true, artistOptionalTokens: [setsTok, ueTok, swapTok] },
      { titleTokens: [compactSrv], revOnTitle: false, artistOptionalTokens: [setsTok, ueTok, swapTok] },
      { titleTokens: [compactPlain, revTok], revOnTitle: true, artistOptionalTokens: [setsTok, ueTok, swapTok] },
      { titleTokens: [compactPlain], revOnTitle: false, artistOptionalTokens: [setsTok, ueTok, swapTok] }
    );
  } else {
    // Ordinary game: preserve serving marker + point score; never mislabel as a tie-break!
    candidates.push(
      { titleTokens: [ptsTok, revTok], revOnTitle: true, artistOptionalTokens: [gamesTok, setsTok, ueTok, swapTok] },
      { titleTokens: [ptsTok], revOnTitle: false, artistOptionalTokens: [gamesTok, setsTok, ueTok, swapTok] }
    );
  }

  return resolveLayout(candidates, revTok, maxTitleLen, maxArtistLen);
}
