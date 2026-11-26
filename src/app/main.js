import { createKeepAliveAudioBlobUrl } from './wavGenerator.js';
import {
  createAppController,
  createGuardedStorage,
  formatDiagTime,
  formatDuration,
  formatUePercent,
} from './appController.js';
import {
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
} from './uiHelpers.js';

const SW_UPDATE_THROTTLE_MS = 15 * 60 * 1000;
const SW_UPDATE_TIMEOUT_MS = 8000;

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function iconSvg(name) {
  if (name === 'guide') {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.7 2.7 0 0 1 5 .9c0 1.8-2.5 2.2-2.5 3.9"/><circle cx="12" cy="17.5" r="0.6" fill="currentColor"/></svg>';
  }
  if (name === 'history') {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>';
  }
  if (name === 'back') {
    return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>';
  }
  if (name === 'band') {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="4" width="10" height="16" rx="4"/><path d="M10 2h4"/><path d="M10 22h4"/></svg>';
  }
  if (name === 'phone') {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>';
  }
  if (name === 'music') {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  }
  if (name === 'lock') {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  }
  if (name === 'arrow') {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
  }
  if (name === 'download') {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  }
  if (name === 'prev') {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>';
  }
  if (name === 'pause') {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';
  }
  if (name === 'next') {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>';
  }
  return '';
}

function formatScoringModeName(mode) {
  return mode === 'GP' ? 'Golden Point' : 'Advantage';
}

function buildScoreboardRowAriaLabel(teamName, cols, teamIndex, showPoints, pointsHeader, pointsVal, isServing) {
  const parts = [teamName];
  if (isServing) parts.push('serving');
  for (const c of cols) {
    const val = teamIndex === 0 ? c.us : c.them;
    const opp = teamIndex === 0 ? c.them : c.us;
    if (c.tbUs !== null && c.tbThem !== null) {
      const myTb = teamIndex === 0 ? c.tbUs : c.tbThem;
      const oppTb = teamIndex === 0 ? c.tbThem : c.tbUs;
      const tbVerb = val > opp ? 'won' : 'lost';
      parts.push(`${c.label}: ${val}, ${tbVerb} tie-break ${myTb} to ${oppTb}`);
    } else {
      parts.push(`${c.label}: ${val}`);
    }
  }
  if (showPoints) {
    parts.push(`${pointsHeader === 'TB' ? 'Tie-break points' : 'Points'}: ${pointsVal}`);
  }
  return parts.join(', ');
}

function renderScoreboardGrid(state) {
  const board = buildScoreboardColumns(state);
  const gridCls = board.showPoints ? 'sb-grid sb-grid-pts' : 'sb-grid';
  const styleAttr = `style="--set-cols:${board.cols.length};"`;
  const usServing = board.activeServer === 0;
  const themServing = board.activeServer === 1;

  const usAria = buildScoreboardRowAriaLabel(
    'US',
    board.cols,
    0,
    board.showPoints,
    board.pointsHeader,
    board.points[0],
    usServing
  );
  const themAria = buildScoreboardRowAriaLabel(
    'THEM',
    board.cols,
    1,
    board.showPoints,
    board.pointsHeader,
    board.points[1],
    themServing
  );

  const renderSetCell = (col, idx, teamIdx) => {
    const val = teamIdx === 0 ? col.us : col.them;
    const sup = teamIdx === 0 ? col.usSup : col.themSup;
    const isActiveCol = idx === board.cols.length - 1;
    const cls = isActiveCol ? 'sb-set-val sb-set-val-active' : 'sb-set-val';
    return `<span class="${cls}" aria-hidden="true">${val}${sup !== null ? `<sup class="tb-sup">${sup}</sup>` : ''}</span>`;
  };

  return `
    <div class="scoreboard" role="region" aria-label="Scoreboard">
      <div class="${gridCls} sb-head" ${styleAttr} aria-hidden="true">
        <span>Team</span>
        ${board.cols.map((c) => `<span class="sb-col-head">${escapeHtml(c.label)}</span>`).join('')}
        ${board.showPoints ? `<span class="sb-pts-head">${escapeHtml(board.pointsHeader)}</span>` : ''}
      </div>

      <div class="${gridCls} sb-row sb-row-us ${usServing ? 'sb-row-serving' : ''}" ${styleAttr} role="group" aria-label="${escapeHtml(usAria)}">
        <div class="sb-team" aria-hidden="true">
          <span class="team-swatch swatch-us"></span>
          <span class="sb-team-name">US</span>
          <span class="serve-dot" ${usServing ? '' : 'hidden'}></span>
        </div>
        ${board.cols.map((c, i) => renderSetCell(c, i, 0)).join('')}
        ${board.showPoints ? `<span class="sb-pts-val" aria-hidden="true">${escapeHtml(board.points[0])}</span>` : ''}
      </div>

      <div class="${gridCls} sb-row ${themServing ? 'sb-row-serving' : ''}" ${styleAttr} role="group" aria-label="${escapeHtml(themAria)}">
        <div class="sb-team" aria-hidden="true">
          <span class="team-swatch swatch-them"></span>
          <span class="sb-team-name">THEM</span>
          <span class="serve-dot" ${themServing ? '' : 'hidden'}></span>
        </div>
        ${board.cols.map((c, i) => renderSetCell(c, i, 1)).join('')}
        ${board.showPoints ? `<span class="sb-pts-val" aria-hidden="true">${escapeHtml(board.points[1])}</span>` : ''}
      </div>
    </div>
  `;
}

function renderLiveBandFooter(vm) {
  const band = describeBandControls(vm);
  const rev = vm.record?.revision ?? vm.state?.revision ?? null;
  const revTag = rev !== null ? ` · #${rev}` : '';

  const isExpanded = band.phase === 'PROMPT' || band.phase === 'AWAITING_LIVE' || band.phase === 'WARMUP';
  if (isExpanded) {
    const cardCls =
      band.emphasis === 'resume'
        ? 'band-card band-card-resume'
        : band.emphasis === 'edit'
          ? 'band-card band-card-edit'
          : 'band-card';
    const isEditOverlay = band.phase === 'PROMPT' || band.phase === 'AWAITING_LIVE';
    const showCancel = band.phase === 'PROMPT' && vm.isWriter && vm.screen === 'LIVE';

    return `
      <div class="${cardCls}" data-testid="${isEditOverlay ? 'wrist-edit-banner' : 'band-controls-panel'}">
        <div class="strip-row">
          <strong>${escapeHtml(band.headline)}</strong>
          ${
            showCancel
              ? '<button class="btn btn-inline" data-action="cancel-wrist-edit">Cancel Edit</button>'
              : `<span class="section-label">Band 9 Active${escapeHtml(revTag)}</span>`
          }
        </div>
        ${
          band.showKeys
            ? `<div class="band-oled" aria-label="Band 9 Active display lines">
                 <div class="band-oled-line1">${escapeHtml(band.title || '—')}</div>
                 <div class="band-oled-line2">${escapeHtml(band.artist || '')}</div>
               </div>
               <div class="band-keys-grid">
                 ${band.keys
                   .map((k) => {
                     const cls = ['band-key-pill'];
                     if (k.highlight) cls.push('band-key-pill-highlight');
                     else if (k.tone === 'ue') cls.push('band-key-pill-ue');
                     if (k.disabled) cls.push('band-key-pill-disabled');
                     return `<div class="${cls.join(' ')}"><span class="band-key-sym">${escapeHtml(k.symbol)}</span><span class="band-key-lbl">${escapeHtml(k.label)}</span></div>`;
                   })
                   .join('')}
               </div>`
            : ''
        }
        <div class="muted">${escapeHtml(band.subcue)}</div>
      </div>
    `;
  }

  // Quiet 1-line Band status footer strictly driven by describeBandControls(vm)
  if (band.phase === 'LIVE' && band.showKeys) {
    return `
      <div class="band-footer" data-testid="band-controls-panel">
        <span class="band-footer-status">
          <span class="status-dot" aria-hidden="true"></span>
          <span>Band ready${escapeHtml(revTag)}</span>
        </span>
        <span class="band-footer-keys">${escapeHtml(band.compactKeysText)}</span>
      </div>
    `;
  }

  // Viewer or Disarmed / Interrupted / Unavailable: never display actionable keys
  return `
    <div class="band-footer" data-testid="band-controls-panel">
      <span class="band-footer-status">${escapeHtml(band.headline)}</span>
      <span class="band-footer-keys">${escapeHtml(band.compactKeysText)}${escapeHtml(revTag)}</span>
    </div>
  `;
}

function renderLiveEditChipHtml(vm) {
  const band = describeBandControls(vm);
  if (band.phase === 'PROMPT') {
    return '<span class="live-edit-chip">EDIT · arrows paused on Band</span>';
  }
  if (band.phase === 'AWAITING_LIVE') {
    return '<span class="live-edit-chip">Press || on Band to resume arrows</span>';
  }
  return '<span class="live-edit-chip live-edit-chip-quiet" aria-hidden="true"></span>';
}

function renderReadOnlyBanner(vm) {
  if (vm.isWriter || vm.screen === 'LOADING') return '';
  const heading =
    vm.lockStatus === 'BUSY'
      ? 'Another tab is scoring this match'
      : vm.lockStatus === 'UNAVAILABLE'
        ? 'Viewing only — editing unavailable here'
        : 'Viewing only';

  return `
    <div class="strip strip-warn" data-testid="readonly-banner">
      <div class="strip-row">
        <div>
          <strong>${escapeHtml(heading)}</strong>
          <div class="muted">${escapeHtml(vm.readOnlyReason)}</div>
        </div>
        <button class="btn btn-inline btn-primary" data-action="takeover-writer">Take over</button>
      </div>
      ${vm.takeoverNotice ? `<div class="muted">${escapeHtml(vm.takeoverNotice)}</div>` : ''}
    </div>
  `;
}

function renderWristRecoveryBanner(vm) {
  if (!vm.isWriter || vm.screen !== 'LIVE') return '';
  const status = vm.wrist.status;
  if (status === 'ARMED') return '';

  if (status === 'UNAVAILABLE') {
    return `
      <div class="strip" data-testid="wrist-banner">
        <strong>Band controls unavailable in this browser</strong>
        <div class="muted">You can score directly on the phone.</div>
      </div>
    `;
  }

  const isInterrupted = status === 'INTERRUPTED';
  const hasPendingEdit = Boolean(vm.editState && vm.editState.phase !== 'LIVE');
  const cls = isInterrupted ? 'strip strip-err' : 'strip strip-warn';
  const title = isInterrupted ? 'Band controls interrupted' : 'Band controls not linked';
  const sub = isInterrupted
    ? hasPendingEdit
      ? 'Audio focus was interrupted during Edit. Tap Re-link Band first — once linked, press || on your Band to resume arrow scoring.'
      : 'Another app or call took audio focus. Tap Re-link Band to restore wrist scoring.'
    : hasPendingEdit
      ? 'Tap Re-link Band first. Once linked, press || on your Band to resume arrow scoring.'
      : 'Tap Re-link Band to enable Band 9 Active Music Controls.';

  return `
    <div class="${cls}" data-testid="wrist-banner">
      <div class="strip-row">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <div class="muted">${escapeHtml(sub)}</div>
        </div>
        <button class="btn btn-inline btn-primary" data-action="relink-wrist">Re-link Band</button>
      </div>
      ${
        vm.wrist.lastLinkError
          ? `<div class="strip-row">
               <span class="muted">Link error: ${escapeHtml(vm.wrist.lastLinkError)}</span>
               <button class="btn btn-inline" data-action="toggle-guide" data-guide-opener="recovery">Open troubleshooting</button>
             </div>`
          : ''
      }
    </div>
  `;
}

function renderErrorBanners(vm) {
  const errors = [];
  if (vm.lastSaveError) errors.push(`Save failed (previous score preserved): ${vm.lastSaveError}`);
  if (vm.lastPublishError) {
    if (vm.screen === 'LIVE') {
      errors.push(`Band display update failed (score saved — tap Re-link Band): ${vm.lastPublishError}`);
    } else {
      errors.push(`Final score saved, but the band display did not update: ${vm.lastPublishError}`);
    }
  }
  if (vm.actionError) errors.push(vm.actionError);
  if (errors.length === 0) return '';

  return errors
    .map((msg) => `<div class="strip strip-err" role="alert">${escapeHtml(msg)}</div>`)
    .join('');
}

function renderSwUpdateStrip(swState) {
  if (!swState.ready) return '';
  return `
    <div class="strip strip-warn" data-testid="sw-update-banner">
      <div class="strip-row">
        <div>
          <strong>App update ready</strong>
          ${
            swState.notice
              ? `<div class="muted">${escapeHtml(swState.notice)}</div>`
              : '<div class="muted">Reloads into the new offline version. Match history stays saved.</div>'
          }
        </div>
        <button class="btn btn-inline btn-primary" data-action="apply-sw-update" ${swState.applying ? 'disabled' : ''}>
          ${swState.applying ? 'Updating…' : 'Update now'}
        </button>
      </div>
    </div>
  `;
}

function renderSetupRadioOption({ name, value, label, checked, disabled }) {
  const id = `setup-${name}-${value}`;
  return `
    <div class="radio-option">
      <input
        class="radio-input"
        type="radio"
        id="${escapeHtml(id)}"
        name="${escapeHtml(name)}"
        value="${escapeHtml(value)}"
        ${checked ? 'checked' : ''}
        ${disabled ? 'disabled' : ''}
      >
      <label class="radio-label" for="${escapeHtml(id)}">
        <span class="radio-check" aria-hidden="true">✓</span>
        <span>${escapeHtml(label)}</span>
      </label>
    </div>
  `;
}

function renderSetupScreen(vm, swState) {
  const isDisabled = !vm.isWriter;
  const serverVal = vm.setupInitialServer === 0 ? '0' : vm.setupInitialServer === 1 ? '1' : 'watch';
  const startDisabled = isDisabled || vm.archiveBlockedDraft;

  return `
    <section class="stack-lg" style="flex:1 1 auto;justify-content:space-between;" data-screen="SETUP">
      <div class="setup-scroll">
        <div>
          <h1 class="screen-heading">New Match</h1>
          <div class="muted" style="margin-top:0.25rem;">Best of 3 sets · 6–6 tie-break</div>
        </div>

        <fieldset class="radio-fieldset">
          <legend class="radio-legend">At 40–40</legend>
          <div class="radio-group">
            ${renderSetupRadioOption({
              name: 'scoring-mode',
              value: 'AD',
              label: 'Advantage',
              checked: vm.setupScoringMode === 'AD',
              disabled: isDisabled,
            })}
            ${renderSetupRadioOption({
              name: 'scoring-mode',
              value: 'GP',
              label: 'Golden point',
              checked: vm.setupScoringMode === 'GP',
              disabled: isDisabled,
            })}
          </div>
        </fieldset>

        <fieldset class="radio-fieldset">
          <legend class="radio-legend">Band || button</legend>
          <div class="radio-group">
            ${renderSetupRadioOption({
              name: 'wrist-mode',
              value: 'EDIT_MODE',
              label: 'Edit last point',
              checked: vm.wristCenterMode === 'EDIT_MODE',
              disabled: isDisabled,
            })}
            ${renderSetupRadioOption({
              name: 'wrist-mode',
              value: 'ONE_TAP_UE',
              label: 'Log my error',
              checked: vm.wristCenterMode === 'ONE_TAP_UE',
              disabled: isDisabled,
            })}
          </div>
          <p class="mode-hint">${escapeHtml(getCenterModeSummary(vm.wristCenterMode))}</p>
        </fieldset>

        <fieldset class="radio-fieldset">
          <legend class="radio-legend">First server</legend>
          <div class="radio-group radio-group-3">
            ${renderSetupRadioOption({
              name: 'initial-server',
              value: 'watch',
              label: 'Pick on Band',
              checked: serverVal === 'watch',
              disabled: isDisabled,
            })}
            ${renderSetupRadioOption({
              name: 'initial-server',
              value: '0',
              label: 'US',
              checked: serverVal === '0',
              disabled: isDisabled,
            })}
            ${renderSetupRadioOption({
              name: 'initial-server',
              value: '1',
              label: 'THEM',
              checked: serverVal === '1',
              disabled: isDisabled,
            })}
          </div>
        </fieldset>

        <button class="setup-guide-row" data-action="toggle-guide" data-guide-opener="setup-row">
          <span class="setup-guide-left">
            ${iconSvg('band')}
            <span>Start → Band Music → Lock phone</span>
          </span>
          <span class="setup-guide-cta">Guide ›</span>
        </button>

        ${
          vm.archiveBlockedDraft
            ? `<div class="confirm-box" data-testid="archive-blocked-box">
                 <div><strong>Previous match could not be archived to history.</strong> Export or retry saving before discarding it.</div>
                 <div class="row-2">
                   <button class="btn btn-primary" data-action="retry-archive">Retry Save</button>
                   <button class="btn" data-action="export-match" data-source="current" data-format="json">${iconSvg('download')}<span>JSON</span></button>
                 </div>
                 <button class="btn btn-full" data-action="export-match" data-source="current" data-format="csv">${iconSvg('download')}<span>Download CSV</span></button>
                 <button class="btn btn-danger btn-full" data-action="start-match-discard">Start New Match &amp; Discard Copy</button>
               </div>`
            : ''
        }

        ${
          vm.isReplacementSetup
            ? `<button class="btn btn-full" data-action="cancel-replacement">Back to Match Over</button>`
            : ''
        }

        <div data-sw-update-slot>${renderSwUpdateStrip(swState)}</div>
      </div>

      <div class="sticky-cta-bar">
        <button class="btn btn-primary btn-cta btn-full" data-action="start-match" ${startDisabled ? 'disabled' : ''}>
          Start Match &amp; Link Band
        </button>
      </div>
    </section>
  `;
}

function renderLoveAllOpenerSwitchHtml(vm) {
  const s = vm.state;
  const awaitingServer = s.status === 'ACTIVE' && s.needsInitialServer;
  const isLoveAllWithServer = !awaitingServer && vm.record && vm.record.events.length === 0;
  if (!isLoveAllWithServer || !vm.isWriter) return '';
  const altServer = s.server === 0 ? 1 : 0;
  const altServerLabel = altServer === 0 ? 'US' : 'THEM';
  return `<button class="btn btn-utility btn-full" data-action="confirm-opener" data-team="${altServer}">Wrong first server? Switch to ${altServerLabel}</button>`;
}

function renderLiveScreen(vm) {
  const s = vm.state;
  const disabled = vm.isWriter ? '' : 'disabled';
  const undoDisabled = vm.canUndo ? '' : 'disabled';
  const awaitingServer = s.status === 'ACTIVE' && s.needsInitialServer;

  return `
    <section class="screen-body screen-body-live" data-screen="LIVE" data-live-mounted="true" data-awaiting-server="${awaitingServer ? 'true' : 'false'}">
      <div class="stack-sm">
        <div data-scoreboard-slot>${renderScoreboardGrid(s)}</div>
        <div class="live-meta-bar">
          <span><span data-live-mode>${escapeHtml(formatScoringModeName(s.scoringMode))}</span> · <span data-duration-text>${escapeHtml(vm.durationText)}</span></span>
          <span class="ue-text" style="font-weight:700;" data-ues>My UEs: ${s.counts.myUePoints} (${escapeHtml(vm.uePctText)})</span>
        </div>
        <div data-edit-chip-slot>${renderLiveEditChipHtml(vm)}</div>
      </div>

      ${
        awaitingServer
          ? `<div class="card card-pad stack-md" data-testid="server-picker">
               <div>
                 <strong>Who serves first?</strong>
                 <div class="muted" style="margin-top:0.25rem;">Tap &lt; (US) or &gt; (THEM) on your Band after the warmup rally, or pick below. Neither adds a point.</div>
               </div>
               <div class="row-2">
                 <button class="btn btn-pad btn-pad-us" data-action="pick-initial-server" data-team="0" ${disabled}>
                   <span class="pad-kicker">First server</span>
                   <span class="pad-main-row"><span class="pad-team">US</span><span class="pad-plus">●</span></span>
                 </button>
                 <button class="btn btn-pad btn-pad-them" data-action="pick-initial-server" data-team="1" ${disabled}>
                   <span class="pad-kicker">First server</span>
                   <span class="pad-main-row"><span class="pad-team">THEM</span><span class="pad-plus">●</span></span>
                 </button>
               </div>
               <button class="btn btn-utility btn-full" data-action="toggle-menu" ${disabled}><span>Menu</span><span aria-hidden="true">▾</span></button>
             </div>`
          : `<div class="scoring-zone">
               <div class="scoring-cluster">
                 <div class="row-2">
                   <button class="btn btn-pad btn-pad-us" data-action="score" data-code="A" ${disabled}>
                     <span class="pad-kicker">Point</span>
                     <span class="pad-main-row"><span class="pad-team">US</span><span class="pad-plus">+1</span></span>
                   </button>
                   <button class="btn btn-pad btn-pad-them" data-action="score" data-code="B" ${disabled}>
                     <span class="pad-kicker">Point</span>
                     <span class="pad-main-row"><span class="pad-team">THEM</span><span class="pad-plus">+1</span></span>
                   </button>
                 </div>

                 <button class="btn btn-ue" data-action="score" data-code="E" ${disabled}>
                   <span class="btn-ue-title">MY UE</span>
                   <span class="btn-ue-sub">My error · +1 THEM</span>
                 </button>
               </div>

               <div data-loveall-slot>${renderLoveAllOpenerSwitchHtml(vm)}</div>

               <div class="row-2">
                 <button class="btn btn-utility" data-action="undo" ${undoDisabled}><span aria-hidden="true">↺</span><span>Undo</span></button>
                 <button class="btn btn-utility" data-action="toggle-menu" ${disabled}><span>Menu</span><span aria-hidden="true">▾</span></button>
               </div>
             </div>`
      }

      <div data-band-slot>${renderLiveBandFooter(vm)}</div>
    </section>
  `;
}

function updateLiveScreenInPlace(screenEl, vm) {
  const s = vm.state;

  const sbSlot = screenEl.querySelector('[data-scoreboard-slot]');
  if (sbSlot) {
    const nextSbHtml = renderScoreboardGrid(s);
    if (sbSlot.dataset.lastHtml !== nextSbHtml) {
      sbSlot.innerHTML = nextSbHtml;
      sbSlot.dataset.lastHtml = nextSbHtml;
    }
  }

  const modeEl = screenEl.querySelector('[data-live-mode]');
  if (modeEl) modeEl.textContent = formatScoringModeName(s.scoringMode);
  const durEl = screenEl.querySelector('[data-duration-text]');
  if (durEl) durEl.textContent = vm.durationText;
  const uesEl = screenEl.querySelector('[data-ues]');
  if (uesEl) uesEl.textContent = `My UEs: ${s.counts.myUePoints} (${vm.uePctText})`;

  const chipSlot = screenEl.querySelector('[data-edit-chip-slot]');
  if (chipSlot) {
    const nextChipHtml = renderLiveEditChipHtml(vm);
    if (chipSlot.dataset.lastHtml !== nextChipHtml) {
      chipSlot.innerHTML = nextChipHtml;
      chipSlot.dataset.lastHtml = nextChipHtml;
    }
  }

  for (const btn of screenEl.querySelectorAll(
    'button[data-action="score"], button[data-action="pick-initial-server"], button[data-action="toggle-menu"]'
  )) {
    btn.disabled = !vm.isWriter;
  }

  const undoBtn = screenEl.querySelector('button[data-action="undo"]');
  if (undoBtn) {
    const wasFocused = document.activeElement === undoBtn;
    undoBtn.disabled = !vm.canUndo;
    if (wasFocused && undoBtn.disabled) {
      screenEl.querySelector('button[data-action="score"][data-code="A"]')?.focus({ preventScroll: true });
    }
  }

  const loveAllSlot = screenEl.querySelector('[data-loveall-slot]');
  if (loveAllSlot) {
    const nextHtml = renderLoveAllOpenerSwitchHtml(vm);
    if (loveAllSlot.dataset.lastHtml !== nextHtml) {
      const hadFocus = loveAllSlot.contains(document.activeElement);
      loveAllSlot.innerHTML = nextHtml;
      loveAllSlot.dataset.lastHtml = nextHtml;
      if (hadFocus && !nextHtml) {
        screenEl.querySelector('button[data-action="score"][data-code="A"]')?.focus({ preventScroll: true });
      }
    }
  }

  const bandSlot = screenEl.querySelector('[data-band-slot]');
  if (bandSlot) {
    const nextBandHtml = renderLiveBandFooter(vm);
    if (bandSlot.dataset.lastHtml !== nextBandHtml) {
      bandSlot.innerHTML = nextBandHtml;
      bandSlot.dataset.lastHtml = nextBandHtml;
    }
  }
}

function renderMenuOpenerSlotHtml(vm) {
  const rawOpener = vm.record?.config?.initialServer;
  const hasOpener = rawOpener === 0 || rawOpener === 1;
  if (!hasOpener) return '';
  const altOpener = rawOpener === 0 ? 1 : 0;
  const curLabel = rawOpener === 0 ? 'US' : 'THEM';
  const altLabel = altOpener === 0 ? 'US' : 'THEM';

  if (vm.ui.confirmOpenerOpen) {
    return `<div class="confirm-box">
      <div>Switch first server from <strong>${curLabel}</strong> to <strong>${altLabel}</strong>? Scores, timestamps, and UE totals stay intact.</div>
      <div class="row-2">
        <button class="btn" data-action="cancel-opener">Cancel</button>
        <button class="btn btn-primary" data-action="confirm-opener" data-team="${altOpener}">Switch to ${altLabel}</button>
      </div>
    </div>`;
  }
  return `<button class="btn btn-full" data-action="open-opener">Correct first server (currently ${curLabel})</button>`;
}

function renderMenuFinishSlotHtml(vm) {
  if (vm.ui.confirmFinishOpen) {
    return `<div class="confirm-box">
      <div><strong>Finish match early?</strong> Saves current score and disarms band controls. You can still Resume later.</div>
      <div class="row-2">
        <button class="btn" data-action="cancel-finish">Cancel</button>
        <button class="btn btn-danger" data-action="confirm-finish">Confirm Finish</button>
      </div>
    </div>`;
  }
  return `<button class="btn btn-danger btn-full" data-action="open-finish">Finish Match Early</button>`;
}

function renderMenuDiagRowsHtml(vm) {
  if (vm.diagEntries.length === 0) {
    return '<div class="muted">No diagnostic entries yet.</div>';
  }
  return vm.diagEntries
    .map(
      (e) =>
        `<div>${escapeHtml(formatDiagTime(e.t))} · ${escapeHtml(e.action)} · ${escapeHtml(e.audioState)}${
          e.revision !== null ? ` · #${e.revision}` : ''
        }${e.detail ? ` · ${escapeHtml(e.detail)}` : ''}</div>`
    )
    .join('');
}

function renderMenuUpdateNoteHtml(swState) {
  if (!swState.ready) return '';
  return `<div class="strip strip-warn" data-testid="menu-update-note">
    <strong>Update ready after match</strong>
    <div class="muted">Finish the match to install the update safely without interrupting Band controls.</div>
  </div>`;
}

function renderMenuSheet(vm, swState) {
  if (!vm.ui.menuOpen || !vm.isWriter || vm.screen !== 'LIVE') return '';
  const editSel = vm.wristCenterMode === 'EDIT_MODE' ? 'btn-selected' : 'btn-choice';
  const oneTapSel = vm.wristCenterMode === 'ONE_TAP_UE' ? 'btn-selected' : 'btn-choice';

  return `
    <div class="sheet-backdrop" data-backdrop="menu">
      <section class="sheet" role="dialog" aria-modal="true" aria-label="Match Menu" data-testid="menu-panel">
        <div class="sheet-header">
          <h2>Match Menu</h2>
          <button class="btn btn-inline" data-action="close-menu" data-sheet-close="menu">Close</button>
        </div>

        <div class="sheet-body">
          <div class="stack-sm">
            <span class="section-label">Band middle button (||)</span>
            <div class="row-2">
              <button class="btn ${editSel}" data-action="set-wrist-mode" data-mode="EDIT_MODE" aria-pressed="${vm.wristCenterMode === 'EDIT_MODE'}">
                <span>Edit last point</span>
                <span class="btn-choice-sub">&lt; Undo / &gt; MY UE</span>
              </button>
              <button class="btn ${oneTapSel}" data-action="set-wrist-mode" data-mode="ONE_TAP_UE" aria-pressed="${vm.wristCenterMode === 'ONE_TAP_UE'}">
                <span>Log my error</span>
                <span class="btn-choice-sub">Direct MY UE</span>
              </button>
            </div>
            <p class="mode-hint" data-menu-mode-hint>${escapeHtml(getCenterModeSummary(vm.wristCenterMode))}</p>
          </div>

          <div class="row-2">
            ${
              vm.wrist.supported
                ? `<button class="btn" data-action="relink-wrist">Re-link Band</button>`
                : ''
            }
            <button class="btn" data-action="toggle-guide" data-guide-opener="menu">Band Guide</button>
          </div>

          <div data-menu-opener-slot>${renderMenuOpenerSlotHtml(vm)}</div>
          <div data-menu-finish-slot>${renderMenuFinishSlotHtml(vm)}</div>
          <div data-menu-update-slot>${renderMenuUpdateNoteHtml(swState)}</div>

          <details class="details-card">
            <summary>
              <span>Device &amp; Diagnostics</span>
              <span class="details-chevron" aria-hidden="true">▾</span>
            </summary>
            <div class="details-body">
              <button class="btn btn-full" data-action="step-down">Release control to another tab</button>
              <div class="strip-row">
                <span class="section-label">Diagnostic Log (recent)</span>
                <div style="display:flex;gap:0.375rem;">
                  <button class="btn btn-inline" data-action="copy-diag">Copy</button>
                  <button class="btn btn-inline" data-action="clear-diag">Clear</button>
                </div>
              </div>
              <div class="diag-list" data-menu-diag-slot>${renderMenuDiagRowsHtml(vm)}</div>
            </div>
          </details>
        </div>
      </section>
    </div>
  `;
}

function updateMenuSheetInPlace(sheetEl, vm, swState) {
  for (const btn of sheetEl.querySelectorAll('button[data-action="set-wrist-mode"]')) {
    const selected = btn.dataset.mode === vm.wristCenterMode;
    btn.classList.toggle('btn-selected', selected);
    btn.classList.toggle('btn-choice', !selected);
    btn.setAttribute('aria-pressed', String(selected));
  }

  const modeHint = sheetEl.querySelector('[data-menu-mode-hint]');
  if (modeHint) modeHint.textContent = getCenterModeSummary(vm.wristCenterMode);

  const openerSlot = sheetEl.querySelector('[data-menu-opener-slot]');
  if (openerSlot) {
    const nextHtml = renderMenuOpenerSlotHtml(vm);
    if (openerSlot.dataset.lastHtml !== nextHtml) {
      const hadFocus = openerSlot.contains(document.activeElement);
      openerSlot.innerHTML = nextHtml;
      openerSlot.dataset.lastHtml = nextHtml;
      if (hadFocus) {
        openerSlot.querySelector('button')?.focus({ preventScroll: true });
      }
    }
  }

  const finishSlot = sheetEl.querySelector('[data-menu-finish-slot]');
  if (finishSlot) {
    const nextHtml = renderMenuFinishSlotHtml(vm);
    if (finishSlot.dataset.lastHtml !== nextHtml) {
      const hadFocus = finishSlot.contains(document.activeElement);
      finishSlot.innerHTML = nextHtml;
      finishSlot.dataset.lastHtml = nextHtml;
      if (hadFocus) {
        finishSlot.querySelector('button')?.focus({ preventScroll: true });
      }
    }
  }

  const updateSlot = sheetEl.querySelector('[data-menu-update-slot]');
  if (updateSlot) {
    const nextHtml = renderMenuUpdateNoteHtml(swState);
    if (updateSlot.dataset.lastHtml !== nextHtml) {
      updateSlot.innerHTML = nextHtml;
      updateSlot.dataset.lastHtml = nextHtml;
    }
  }

  const diagSlot = sheetEl.querySelector('[data-menu-diag-slot]');
  if (diagSlot) {
    const nextHtml = renderMenuDiagRowsHtml(vm);
    if (diagSlot.dataset.lastHtml !== nextHtml) {
      diagSlot.innerHTML = nextHtml;
      diagSlot.dataset.lastHtml = nextHtml;
    }
  }
}

function renderGuideStatusNotice(vm) {
  if (vm.screen !== 'LIVE') return '';
  if (!vm.isWriter) {
    const band = describeBandControls(vm);
    return `
      <div class="strip strip-warn" data-testid="guide-status-banner">
        <strong>${escapeHtml(band.headline)}</strong>
        <div class="muted">${escapeHtml(band.subcue)}</div>
      </div>
    `;
  }
  if (vm.wrist.status !== 'ARMED') {
    const band = describeBandControls(vm);
    const canRelink = vm.wrist.supported && vm.wrist.status !== 'UNAVAILABLE';
    return `
      <div class="strip ${vm.wrist.status === 'INTERRUPTED' ? 'strip-err' : 'strip-warn'}" data-testid="guide-status-banner">
        <div class="strip-row">
          <div>
            <strong>${escapeHtml(band.headline)}</strong>
            <div class="muted">${escapeHtml(band.subcue)}</div>
          </div>
          ${
            canRelink
              ? '<button class="btn btn-inline btn-primary" data-action="relink-wrist">Re-link Band</button>'
              : ''
          }
        </div>
      </div>
    `;
  }
  return '';
}

function renderGuideSheet(vm) {
  if (!vm.ui.guideOpen) return '';
  const showWarmupStep =
    vm.screen === 'SETUP'
      ? vm.setupInitialServer === null
      : Boolean(vm.state?.status === 'ACTIVE' && vm.state?.needsInitialServer);
  const steps = getBandGuideSteps(vm.wristCenterMode, { showWarmupStep });

  const renderKeySchematic = (k, iconName) => {
    const toneCls = k.highlight
      ? 'guide-key-accent'
      : k.disabled
        ? 'guide-key-muted'
        : k.tone === 'us'
          ? 'guide-key-us'
          : k.tone === 'them'
            ? 'guide-key-them'
            : k.tone === 'ue'
              ? 'guide-key-ue'
              : 'guide-key-neutral';
    return `
      <div class="guide-key ${toneCls}">
        <span class="guide-key-circle" aria-hidden="true">${iconSvg(iconName)}</span>
        <span class="guide-key-caption">${escapeHtml(k.label)}</span>
      </div>
    `;
  };

  return `
    <div class="sheet-backdrop" data-backdrop="guide">
      <section class="sheet" role="dialog" aria-modal="true" aria-label="How to Use Band" data-testid="guide-panel">
        <div class="sheet-header">
          <h2>How to Use Band</h2>
          <button class="btn btn-inline" data-action="close-guide" data-sheet-close="guide">Close</button>
        </div>

        <div class="sheet-body">
          ${renderGuideStatusNotice(vm)}

          <div class="card card-pad stack-md">
            <span class="section-label">Before stepping on court</span>
            <div class="precourt-grid">
              <div class="precourt-step">
                <span class="precourt-icon" aria-hidden="true">${iconSvg('phone')}</span>
                <span class="precourt-lbl">1. Start</span>
              </div>
              <span class="precourt-arrow" aria-hidden="true">${iconSvg('arrow')}</span>
              <div class="precourt-step">
                <span class="precourt-icon" aria-hidden="true">${iconSvg('music')}</span>
                <span class="precourt-lbl">2. Music</span>
              </div>
              <span class="precourt-arrow" aria-hidden="true">${iconSvg('arrow')}</span>
              <div class="precourt-step">
                <span class="precourt-icon" aria-hidden="true">${iconSvg('lock')}</span>
                <span class="precourt-lbl">3. Lock</span>
              </div>
            </div>
          </div>

          ${steps
            .map(
              (s) => `
                <div class="guide-step-card">
                  <div class="guide-step-head">
                    <span class="guide-step-num tabular" aria-hidden="true">${s.step}</span>
                    <div>
                      <div class="guide-step-title">${escapeHtml(s.title)}</div>
                      <div class="muted" style="margin-top:0.2rem;">${escapeHtml(s.caption)}</div>
                    </div>
                  </div>
                  <div class="guide-oled">
                    <div class="guide-oled-screen">
                      <div class="band-oled-line1">${escapeHtml(s.bandTitle)}</div>
                      <div class="band-oled-line2">${escapeHtml(s.bandArtist)}</div>
                    </div>
                    ${
                      s.keys && s.keys.length === 3
                        ? `<div class="guide-keys">
                             ${renderKeySchematic(s.keys[0], 'prev')}
                             ${renderKeySchematic(s.keys[1], 'pause')}
                             ${renderKeySchematic(s.keys[2], 'next')}
                           </div>`
                        : ''
                    }
                  </div>
                </div>
              `
            )
            .join('')}

          <details class="details-card">
            <summary>
              <span>Band not showing PadelScore?</span>
              <span class="details-chevron" aria-hidden="true">▾</span>
            </summary>
            <div class="details-body">
              <div class="muted">1. Close Spotify, YouTube, or other media apps, then tap <strong>Re-link Band</strong>.</div>
              <div class="muted">2. Confirm <strong>Mi Fitness</strong> has Android Notification Access enabled and Chrome notifications are allowed.</div>
              <div class="muted">3. Start a Band Workout first, then swipe right to Music Controls before locking your phone.</div>
            </div>
          </details>

          <button class="btn btn-primary btn-full" data-action="close-guide">Got it</button>
        </div>
      </section>
    </div>
  `;
}

function renderUeTelemetryCard(counts, takeaway) {
  const share = computePointShare(counts);
  const uePctText = formatUePercent(share.uePctOfLost);
  const pctRatio = share.uePctOfLost === null ? 0 : Math.max(0, Math.min(1, share.uePctOfLost));
  const r = 27;
  const circ = 2 * Math.PI * r;
  const dashOffset = circ * (1 - pctRatio);

  return `
    <div class="card" data-testid="ue-telemetry-card">
      <div class="ue-card-top">
        <div class="ue-ring-wrap" aria-hidden="true">
          <svg class="ue-ring-svg" viewBox="0 0 68 68">
            <circle cx="34" cy="34" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="6"></circle>
            ${
              pctRatio > 0
                ? `<circle cx="34" cy="34" r="${r}" fill="none" stroke="var(--ue-pad)" stroke-width="6" stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${dashOffset.toFixed(1)}"></circle>`
                : ''
            }
          </svg>
          <span class="ue-ring-val">${escapeHtml(uePctText)}</span>
        </div>

        <div class="ue-card-copy">
          <span class="section-label">My Unforced Errors</span>
          <div class="ue-ratio-line">
            <span>${share.myUePoints}</span>
            <span class="ue-ratio-muted"> of ${share.pointsLost} points lost${share.uePctOfLost !== null ? `<span class="sr-only"> (${escapeHtml(uePctText)})</span>` : ''}</span>
          </div>
          <div class="muted">${escapeHtml(takeaway)}</div>
        </div>
      </div>

      <div class="ue-card-bottom">
        ${
          share.totalPoints > 0
            ? `<div class="share-bar" aria-hidden="true">
                 ${share.usPct > 0 ? `<div class="share-seg-us" style="width:${share.usPct}%"></div>` : ''}
                 ${share.themOtherPct > 0 ? `<div class="share-seg-them" style="width:${share.themOtherPct}%"></div>` : ''}
                 ${share.myUePct > 0 ? `<div class="share-seg-ue" style="width:${share.myUePct}%"></div>` : ''}
               </div>`
            : ''
        }
        <div class="share-totals">
          <div class="share-total-cell">
            <span class="share-total-lbl"><span class="share-dot swatch-us" aria-hidden="true"></span><span>US won</span></span>
            <span class="share-total-num">${share.usPoints}</span>
          </div>
          <div class="share-total-cell">
            <span class="share-total-lbl"><span class="share-dot swatch-them" aria-hidden="true"></span><span>THEM earned</span></span>
            <span class="share-total-num">${share.themOtherPoints}</span>
          </div>
          <div class="share-total-cell share-total-cell-right">
            <span class="share-total-lbl"><span class="share-dot" style="background:var(--ue-pad);" aria-hidden="true"></span><span>My UE</span></span>
            <span class="share-total-num ue-text">${share.myUePoints}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSetFlowCard(setFlow, stateKey, selection) {
  if (!setFlow || setFlow.isEmpty || setFlow.sets.length === 0) {
    return '';
  }

  const safeSetIdx = Math.min(Math.max(0, selection.setIdx), setFlow.sets.length - 1);
  const currentSet = setFlow.sets[safeSetIdx];
  const safeGameIdx = Math.min(Math.max(0, selection.gameIdx), Math.max(0, currentSet.games.length - 1));
  const selGame = currentSet.games[safeGameIdx];
  const hasOverflow = currentSet.games.length > 8;
  const scrollKeyLadder = `ladder:${stateKey}:s${safeSetIdx}`;
  const scrollKeyPbp = `pbp:${stateKey}:s${safeSetIdx}:g${safeGameIdx}`;

  const gameMetaRight = selGame.isTieBreak
    ? `${selGame.points.length} pts${selGame.ueCount > 0 ? ` · <strong class="ue-text">${selGame.ueCount} UE</strong>` : ''}`
    : `${selGame.server === 0 ? 'US served' : selGame.server === 1 ? 'THEM served' : ''}${
        selGame.ueCount > 0 ? `${selGame.server !== null ? ' · ' : ''}<strong class="ue-text">${selGame.ueCount} UE</strong>` : ''
      }`;

  const gameTitle = selGame.isTieBreak
    ? `Tie-Break (${selGame.tbScoreText || '0–0'})`
    : selGame.isIncomplete
      ? `Game ${selGame.label} (in progress)`
      : `Game ${selGame.label} · ${selGame.usGamesAfter}–${selGame.themGamesAfter}`;

  return `
    <div class="card" data-testid="setflow-card">
      <div class="setflow-head">
        <div style="display:flex;align-items:center;gap:0.375rem;">
          <span class="section-label">Set Flow</span>
          ${hasOverflow ? '<span class="muted" style="font-size:0.6875rem;">· Swipe →</span>' : ''}
        </div>
        ${
          setFlow.sets.length > 1
            ? `<div class="setflow-tabs" role="tablist" aria-label="Select set">
                 ${setFlow.sets
                   .map(
                     (sg, idx) => `
                       <button
                         class="setflow-tab ${idx === safeSetIdx ? 'setflow-tab-active' : ''}"
                         role="tab"
                         aria-selected="${idx === safeSetIdx}"
                         data-action="select-setflow-set"
                         data-state-key="${escapeHtml(stateKey)}"
                         data-set-idx="${idx}"
                       >S${sg.setNumber} (${escapeHtml(sg.scoreText)})</button>
                     `
                   )
                   .join('')}
               </div>`
            : `<span class="muted tabular" style="font-weight:700;">Set ${currentSet.setNumber} (${escapeHtml(currentSet.scoreText)})</span>`
        }
      </div>

      <div class="h-scroll" data-scroll-key="${escapeHtml(scrollKeyLadder)}" data-ladder-scroller="true">
        <div class="ladder-wrap">
          <div class="ladder-labels sticky-col" aria-hidden="true">
            <span class="ladder-lbl-cell ladder-lbl-game">Game</span>
            <span class="ladder-lbl-cell ladder-lbl-team"><span class="share-dot swatch-us"></span><span>US</span></span>
            <span class="ladder-lbl-cell ladder-lbl-team"><span class="share-dot swatch-them"></span><span>TH</span></span>
            <span class="ladder-lbl-cell ladder-lbl-ue">UE</span>
          </div>

          <div class="ladder-cols">
            ${currentSet.games
              .map((g, idx) => {
                const isSel = idx === safeGameIdx;
                const numCls = g.isTieBreak
                  ? 'ladder-cell ladder-cell-num ladder-cell-tb'
                  : g.isBreak
                    ? 'ladder-cell ladder-cell-num ladder-cell-brk'
                    : 'ladder-cell ladder-cell-num';
                const usCellCls = g.isIncomplete
                  ? 'ladder-cell ladder-cell-score ladder-cell-inc'
                  : g.winner === 0
                    ? 'ladder-cell ladder-cell-score ladder-cell-us-win'
                    : 'ladder-cell ladder-cell-score';
                const thCellCls = g.isIncomplete
                  ? 'ladder-cell ladder-cell-score ladder-cell-inc'
                  : g.winner === 1
                    ? 'ladder-cell ladder-cell-score ladder-cell-them-win'
                    : 'ladder-cell ladder-cell-score';
                const ueCls =
                  g.ueCount > 0 ? 'ladder-cell ladder-cell-ue ladder-cell-ue-nonzero' : 'ladder-cell ladder-cell-ue';
                const colAria = g.isTieBreak
                  ? `Tie-break, ${g.tbScoreText || ''}, ${g.ueCount} My UEs`
                  : g.isIncomplete
                    ? `Game ${g.label}, in progress, ${g.ueCount} My UEs`
                    : `Game ${g.label}, ${g.winner === 0 ? 'US' : 'THEM'} won to ${g.usGamesAfter}-${g.themGamesAfter}${g.isBreak ? ', break of serve' : ''}, ${g.ueCount} My UEs`;

                return `
                  <button
                    class="setflow-col-btn ${isSel ? 'setflow-col-btn-selected' : ''}"
                    data-action="select-setflow-game"
                    data-state-key="${escapeHtml(stateKey)}"
                    data-game-idx="${idx}"
                    aria-pressed="${isSel}"
                    aria-label="${escapeHtml(colAria)}"
                  >
                    <span class="${numCls}" aria-hidden="true">${escapeHtml(g.label)}</span>
                    <span class="${usCellCls}" aria-hidden="true">${g.isIncomplete ? '…' : g.winner === 0 ? g.usGamesAfter : '·'}</span>
                    <span class="${thCellCls}" aria-hidden="true">${g.isIncomplete ? '…' : g.winner === 1 ? g.themGamesAfter : '·'}</span>
                    <span class="${ueCls}" aria-hidden="true">${g.ueCount > 0 ? g.ueCount : '·'}</span>
                  </button>
                `;
              })
              .join('')}
          </div>
        </div>
      </div>

      <div class="pbp-well">
        <div class="pbp-head">
          <span class="pbp-head-title">
            <span>${escapeHtml(gameTitle)}</span>
            ${selGame.isBreak ? '<span class="break-badge">Break</span>' : ''}
          </span>
          <span class="muted" style="font-size:0.75rem;">${gameMetaRight}</span>
        </div>

        <div class="h-scroll" data-scroll-key="${escapeHtml(scrollKeyPbp)}">
          <div class="pbp-matrix-inner" style="--pt-cols:${selGame.points.length};">
            <div class="pbp-row">
              <div class="pbp-team-lbl sticky-col-well">
                <span class="share-dot swatch-us" aria-hidden="true"></span>
                <span>US</span>
                ${!selGame.isTieBreak && selGame.server === 0 ? '<span class="pbp-serve-dot" aria-hidden="true"></span>' : ''}
              </div>
              ${selGame.points
                .map((p) => {
                  const won = p.code === 'A';
                  return `<span class="pbp-pt ${won ? 'pbp-pt-us' : ''}">${escapeHtml(p.usLabel)}</span>`;
                })
                .join('')}
            </div>

            <div class="pbp-row">
              <div class="pbp-team-lbl sticky-col-well">
                <span class="share-dot swatch-them" aria-hidden="true"></span>
                <span>TH</span>
                ${!selGame.isTieBreak && selGame.server === 1 ? '<span class="pbp-serve-dot" aria-hidden="true"></span>' : ''}
              </div>
              ${selGame.points
                .map((p) => {
                  const cls = p.code === 'E' ? 'pbp-pt pbp-pt-ue' : p.code === 'B' ? 'pbp-pt pbp-pt-them' : 'pbp-pt';
                  return `<span class="${cls}">${escapeHtml(p.themLabel)}</span>`;
                })
                .join('')}
            </div>

            ${
              selGame.ueCount > 0
                ? `<div class="pbp-row">
                     <span class="pbp-ue-lbl sticky-col-well">UE</span>
                     ${selGame.points
                       .map((p) => (p.code === 'E' ? '<span class="pbp-ue-mark">UE</span>' : '<span></span>'))
                       .join('')}
                   </div>`
                : ''
            }
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderMoreStatsDetails({ analytics, scoringMode, exportSource, exportMatchId, stateKey, isOpen }) {
  const matchIdAttr = exportMatchId ? ` data-match-id="${escapeHtml(exportMatchId)}"` : '';
  const openAttr = isOpen ? ' open' : '';

  if (!analytics) {
    return `
      <details class="details-card" data-more-stats="${escapeHtml(stateKey)}"${openAttr}>
        <summary>
          <span>More stats &amp; Export</span>
          <span class="details-chevron" aria-hidden="true">▾</span>
        </summary>
        <div class="details-body">
          <div class="muted">Detailed analytics unavailable (—).</div>
          <div class="row-2">
            <button class="btn" data-action="export-match" data-source="${escapeHtml(exportSource)}"${matchIdAttr} data-format="csv">${iconSvg('download')}<span>CSV</span></button>
            <button class="btn" data-action="export-match" data-source="${escapeHtml(exportSource)}"${matchIdAttr} data-format="json">${iconSvg('download')}<span>JSON</span></button>
          </div>
        </div>
      </details>
    `;
  }

  const { clutch, serveReturn, serviceHold, clusters, windows15m, unbucketedCount } = analytics;
  const holdText =
    serviceHold.completedOrdinaryServiceGames > 0
      ? `${serviceHold.ordinaryServiceGamesWon}/${serviceHold.completedOrdinaryServiceGames} (${formatUePercent(serviceHold.holdRate)})`
      : '—';

  const pressureRows = [];
  if (scoringMode === 'GP' || clutch.byLabel.goldenPoint.totalPoints > 0) {
    pressureRows.push({ name: 'Golden Point', ...clutch.byLabel.goldenPoint });
  }
  if (clutch.byLabel.breakPoint.totalPoints > 0) {
    pressureRows.push({ name: 'Break Point', ...clutch.byLabel.breakPoint });
  }
  if (clutch.byLabel.setPoint.totalPoints > 0) {
    pressureRows.push({ name: 'Set Point', ...clutch.byLabel.setPoint });
  }
  if (clutch.byLabel.tieBreak.totalPoints > 0) {
    pressureRows.push({ name: 'Tie-Break', ...clutch.byLabel.tieBreak });
  }

  return `
    <details class="details-card" data-more-stats="${escapeHtml(stateKey)}" data-testid="analytics-panel"${openAttr}>
      <summary>
        <span>More stats &amp; Export</span>
        <span class="details-chevron" aria-hidden="true">▾</span>
      </summary>
      <div class="details-body">
        <div class="stat-list">
          <span class="section-label">Serve &amp; Return</span>
          <div class="stat-row">
            <span>Serving My UEs</span>
            <span><strong>${serveReturn.serving.myUePoints}</strong> <span class="muted">(${escapeHtml(formatUePercent(serveReturn.serving.uePctOfPointsLost))} of ${serveReturn.serving.pointsLost} lost)</span></span>
          </div>
          <div class="stat-row">
            <span>Returning My UEs</span>
            <span><strong>${serveReturn.returning.myUePoints}</strong> <span class="muted">(${escapeHtml(formatUePercent(serveReturn.returning.uePctOfPointsLost))} of ${serveReturn.returning.pointsLost} lost)</span></span>
          </div>
          <div class="stat-row">
            <span>Service Hold</span>
            <span><strong>${escapeHtml(holdText)}</strong></span>
          </div>
          <div class="stat-row">
            <span>Clutch My UEs</span>
            <span><strong>${clutch.clutchUeTotal}</strong> <span class="muted">(${escapeHtml(formatUePercent(clutch.clutchUePctOfPointsLost))} of ${clutch.clutchPointsLost} lost)</span></span>
          </div>
        </div>

        ${
          pressureRows.length > 0
            ? `<div class="stack-sm">
                 <span class="section-label">Pressure Moments</span>
                 <table class="analytics-table">
                   <thead>
                     <tr>
                       <th>Moment</th>
                       <th>UE</th>
                       <th>Lost</th>
                       <th>Pts</th>
                     </tr>
                   </thead>
                   <tbody>
                     ${pressureRows
                       .map(
                         (r) => `<tr>
                           <td>${escapeHtml(r.name)}</td>
                           <td class="${r.myUePoints > 0 ? 'ue-text' : ''}">${r.myUePoints}</td>
                           <td>${r.pointsLost}</td>
                           <td>${r.totalPoints}</td>
                         </tr>`
                       )
                       .join('')}
                   </tbody>
                 </table>
               </div>`
            : ''
        }

        ${
          clusters.length > 0
            ? `<div class="stack-sm">
                 <span class="section-label">Error Streaks (${clusters.length})</span>
                 ${clusters
                   .map(
                     (c, idx) =>
                       `<div class="cluster-item"><strong>Streak ${idx + 1}:</strong> ${c.ueCount} My UEs (pts #${c.startPointNumber}–#${c.endPointNumber}, S${c.setNumber} ${escapeHtml(c.startScoreText)})</div>`
                   )
                   .join('')}
               </div>`
            : ''
        }

        ${
          windows15m.length > 0
            ? `<div class="stack-sm">
                 <span class="section-label">15-Minute Elapsed Windows</span>
                 <table class="analytics-table">
                   <thead>
                     <tr>
                       <th>Window</th>
                       <th>UE</th>
                       <th>Lost</th>
                       <th>UE %</th>
                     </tr>
                   </thead>
                   <tbody>
                     ${windows15m
                       .map(
                         (w) => `<tr>
                           <td>${escapeHtml(w.label)}</td>
                           <td class="${w.myUePoints > 0 ? 'ue-text' : ''}">${w.myUePoints}</td>
                           <td>${w.pointsLost}</td>
                           <td>${escapeHtml(formatUePercent(w.uePctOfPointsLost))}</td>
                         </tr>`
                       )
                       .join('')}
                   </tbody>
                 </table>
                 ${
                   unbucketedCount > 0
                     ? `<div class="muted">${unbucketedCount} rally(s) excluded due to invalid timestamp.</div>`
                     : ''
                 }
               </div>`
            : ''
        }

        <div class="row-2">
          <button class="btn" data-action="export-match" data-source="${escapeHtml(exportSource)}"${matchIdAttr} data-format="csv">${iconSvg('download')}<span>CSV</span></button>
          <button class="btn" data-action="export-match" data-source="${escapeHtml(exportSource)}"${matchIdAttr} data-format="json">${iconSvg('download')}<span>JSON</span></button>
        </div>
      </div>
    </details>
  `;
}

function formatHistoryRowScoreText(item) {
  const parts = [];
  if (Array.isArray(item.setHistory) && item.setHistory.length > 0) {
    for (const s of item.setHistory) {
      parts.push(`${s.games[0]}–${s.games[1]}`);
    }
  }
  if (Array.isArray(item.partialGames)) {
    parts.push(`${item.partialGames[0]}–${item.partialGames[1]}`);
  }
  if (parts.length === 0) {
    return item.setsText.replace('-', '–');
  }
  return parts.join('  ');
}

function renderCorruptScreen(vm) {
  return `
    <section class="screen-body" data-screen="CORRUPT">
      <h1 class="screen-heading">Saved Match Needs Recovery</h1>
      <div class="strip strip-err">
        Saved match data failed validation and was <strong>not</strong> overwritten.
        <div class="muted">${escapeHtml(vm.corruptError || 'Invalid JSON')}</div>
      </div>
      <label class="muted" for="corrupt-raw-text">Raw saved payload (copy before clearing):</label>
      <textarea id="corrupt-raw-text" class="raw-box" readonly>${escapeHtml(vm.corruptRaw || '')}</textarea>
      <div class="stack-sm">
        <button class="btn btn-full" data-action="copy-corrupt">Copy Raw Data</button>
        ${
          vm.isWriter
            ? vm.ui.confirmClearCorruptOpen
              ? `<div class="confirm-box">
                   <div><strong>Permanently clear corrupt record?</strong> Copy the raw payload first if needed.</div>
                   <div class="row-2">
                     <button class="btn" data-action="cancel-clear-corrupt">Cancel</button>
                     <button class="btn btn-danger" data-action="confirm-clear-corrupt">Confirm Clear</button>
                   </div>
                 </div>`
              : `<button class="btn btn-danger btn-full" data-action="open-clear-corrupt">Clear &amp; Start Fresh</button>`
            : `<div class="muted">Tap Take over above to clear corrupt storage.</div>`
        }
      </div>
    </section>
  `;
}

function renderReadErrorScreen(vm) {
  return `
    <section class="screen-body" data-screen="READ_ERROR">
      <h1 class="screen-heading">Storage Read Error</h1>
      <div class="strip strip-err">
        Could not read saved match from browser storage.
        <div class="muted">${escapeHtml(vm.storageReadError || 'Unknown storage error')}</div>
      </div>
      ${
        vm.isWriter
          ? `<button class="btn btn-primary btn-full" data-action="retry-read">Retry Read</button>`
          : `<button class="btn btn-primary btn-full" data-action="takeover-writer">Take over</button>`
      }
    </section>
  `;
}

function renderLoadingScreen() {
  return `
    <section class="screen-body" data-screen="LOADING">
      <h1 class="screen-heading">Loading Match…</h1>
      <div class="muted">Checking saved score and match control lock.</div>
    </section>
  `;
}

function captureFocusDescriptor(container) {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;

  if (active.tagName === 'SUMMARY') {
    const details = active.closest('details[data-more-stats]');
    if (details) {
      return { kind: 'summary', moreStatsKey: details.dataset.moreStats };
    }
    return null;
  }
  if (active.tagName === 'INPUT' && active.type === 'radio') {
    return { kind: 'radio', name: active.name, value: active.value };
  }
  if (active.tagName === 'BUTTON' && active.dataset?.action) {
    const ds = active.dataset;
    return {
      kind: 'button',
      action: ds.action,
      code: ds.code ?? null,
      mode: ds.mode ?? null,
      team: ds.team ?? null,
      matchId: ds.matchId ?? null,
      source: ds.source ?? null,
      format: ds.format ?? null,
      setIdx: ds.setIdx ?? null,
      gameIdx: ds.gameIdx ?? null,
      guideOpener: ds.guideOpener ?? null,
    };
  }
  return null;
}

function restoreFocusDescriptor(container, desc) {
  if (!desc) return;
  if (desc.kind === 'summary') {
    for (const details of container.querySelectorAll('details[data-more-stats]')) {
      if (details.dataset.moreStats === desc.moreStatsKey) {
        details.querySelector(':scope > summary')?.focus({ preventScroll: true });
        return;
      }
    }
    return;
  }
  if (desc.kind === 'radio') {
    for (const input of container.querySelectorAll('input[type="radio"]')) {
      if (!input.disabled && input.name === desc.name && input.value === desc.value) {
        input.focus({ preventScroll: true });
        return;
      }
    }
    return;
  }
  for (const btn of container.querySelectorAll('button[data-action]')) {
    if (btn.disabled) continue;
    const ds = btn.dataset;
    if (
      ds.action === desc.action &&
      (desc.code === null || ds.code === desc.code) &&
      (desc.mode === null || ds.mode === desc.mode) &&
      (desc.team === null || ds.team === desc.team) &&
      (desc.matchId === null || ds.matchId === desc.matchId) &&
      (desc.source === null || ds.source === desc.source) &&
      (desc.format === null || ds.format === desc.format) &&
      (desc.setIdx === null || ds.setIdx === desc.setIdx) &&
      (desc.gameIdx === null || ds.gameIdx === desc.gameIdx) &&
      (desc.guideOpener === null || ds.guideOpener === desc.guideOpener)
    ) {
      btn.focus({ preventScroll: true });
      return;
    }
  }
}

function isInsideClosedDetails(el, stopAt) {
  let cur = el.parentElement;
  while (cur && cur !== stopAt) {
    if (cur.tagName === 'DETAILS' && !cur.open) {
      const isDirectSummary = el.tagName === 'SUMMARY' && el.parentElement === cur;
      if (!isDirectSummary) return true;
    }
    cur = cur.parentElement;
  }
  return false;
}

function getSheetFocusables(sheetEl) {
  return Array.from(
    sheetEl.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary, textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => {
    if (isInsideClosedDetails(el, sheetEl)) return false;
    return el.offsetParent !== null || el === document.activeElement;
  });
}

function scrollSelectedColumnIntoScroller(scroller) {
  if (!scroller) return;
  const selBtn = scroller.querySelector('.setflow-col-btn-selected');
  if (!selBtn) return;
  const stickyW = 56;
  const viewW = scroller.clientWidth;
  if (viewW <= 0) return;
  const targetLeft = selBtn.offsetLeft - stickyW - (viewW - stickyW - selBtn.offsetWidth) / 2;
  const maxScroll = Math.max(0, scroller.scrollWidth - viewW);
  scroller.scrollLeft = Math.max(0, Math.min(maxScroll, targetLeft));
}

function boot() {
  const root = document.getElementById('app');
  if (!root) return;

  root.innerHTML = `
    <div class="app-shell" data-region="shell">
      <div data-region="chrome"></div>
      <div data-region="screen"></div>
    </div>
    <div data-region="sheets"></div>
  `;
  const shellEl = root.querySelector('[data-region="shell"]');
  const chromeEl = root.querySelector('[data-region="chrome"]');
  const screenEl = root.querySelector('[data-region="screen"]');
  const sheetsEl = root.querySelector('[data-region="sheets"]');

  const wavUrl = createKeepAliveAudioBlobUrl();
  let copyFeedback = '';
  let prevScreen = null;
  let prevAwaitingServer = null;
  let prevArchiveBlocked = false;
  let prevMenuOpen = false;
  let prevGuideOpen = false;
  let pendingHistoryFocusAfterDelete = false;
  let lastOpenerSelector = null;
  let lastChromeHtml = '';
  let lastScreenHtml = '';
  let lastGuideHtml = '';

  // Persistent UI-only state keyed by matchId:revision (never reset on unrelated renders or export feedback)
  const setFlowCache = new Map();
  const setFlowSelection = new Map();
  const moreStatsOpenMap = new Map();
  const autoScrolledKeys = new Set();

  // Service Worker update state (multi-window-safe, never reloads mid-match)
  let swRegistration = null;
  let requestedUpdateWorker = null;
  let updateAttemptId = 0;
  let updateAttemptCleanup = null;
  let lastSwUpdateCheckMs = 0;
  const swState = {
    ready: false,
    applying: false,
    notice: null,
  };

  const storage = createGuardedStorage(() => window.localStorage);
  let locks = null;
  try {
    locks = navigator.locks ?? null;
  } catch {
    locks = null;
  }
  let mediaSession = null;
  try {
    mediaSession = navigator.mediaSession ?? null;
  } catch {
    mediaSession = null;
  }

  const controller = createAppController({
    storage,
    locks,
    mediaSession,
    createAudio: () => {
      const el = new Audio(wavUrl);
      el.preload = 'auto';
      el.loop = true;
      return el;
    },
    onUpdate: (vm) => render(vm),
    onDurationTick: (durationText) => {
      const durationEl = screenEl.querySelector('[data-duration-text]');
      if (durationEl && durationText !== null) {
        durationEl.textContent = durationText;
      }
    },
  });

  function getCachedSetFlow(stateKey, analytics) {
    if (!analytics) return null;
    if (setFlowCache.has(stateKey)) {
      return setFlowCache.get(stateKey);
    }
    const flow = buildSetFlowModel(analytics);
    if (setFlowCache.size > 20) {
      setFlowCache.clear();
    }
    setFlowCache.set(stateKey, flow);
    return flow;
  }

  function getSelectionForKey(stateKey, setFlow) {
    const existing = setFlowSelection.get(stateKey);
    if (existing) return existing;
    const defaultSetIdx = setFlow && setFlow.sets.length > 0 ? setFlow.sets.length - 1 : 0;
    const defaultGameIdx =
      setFlow && setFlow.sets[defaultSetIdx] ? setFlow.sets[defaultSetIdx].defaultGameIndex : 0;
    const initial = { setIdx: defaultSetIdx, gameIdx: defaultGameIdx };
    setFlowSelection.set(stateKey, initial);
    return initial;
  }

  function renderMatchOverScreen(vm, swStateVal) {
    const s = vm.state;
    const rec = vm.record;
    const isManual = s.status === 'FINISHED_MANUAL';
    const isWin = !isManual && s.winner === 0;
    const headline = isManual ? 'Ended Early' : isWin ? 'US Won' : 'THEM Won';
    const stateKey = `${rec?.matchId ?? 'current'}:${rec?.revision ?? s.revision}`;
    const setFlow = getCachedSetFlow(stateKey, vm.matchOverAnalytics);
    const selection = getSelectionForKey(stateKey, setFlow);
    const takeaway = buildMatchTakeaway(vm.matchOverAnalytics, setFlow);
    const moreOpen = Boolean(moreStatsOpenMap.get(stateKey));

    return `
      <section class="screen-body" data-screen="MATCH_OVER">
        <div class="stack-md">
          <div class="strip-row" style="align-items:baseline;">
            <h1 class="screen-heading">${escapeHtml(headline)}</h1>
            <span class="muted tabular">${escapeHtml(formatScoringModeName(s.scoringMode))} · ${escapeHtml(vm.durationText)}</span>
          </div>
          ${renderScoreboardGrid(s)}
        </div>

        ${
          vm.history.error
            ? `<div class="strip strip-warn" data-testid="history-error-banner">
                 <div>${escapeHtml(vm.history.error)}</div>
                 ${
                   vm.isWriter
                     ? `<button class="btn btn-inline btn-primary" data-action="retry-archive">Retry Save to History</button>`
                     : ''
                 }
               </div>`
            : ''
        }

        ${renderUeTelemetryCard(s.counts, takeaway)}

        <div data-setflow-slot="${escapeHtml(stateKey)}">
          ${renderSetFlowCard(setFlow, stateKey, selection)}
        </div>

        <div class="stack-sm">
          ${
            isManual && vm.canResume
              ? `<button class="btn btn-primary btn-full" data-action="resume">Resume Match</button>`
              : ''
          }
          ${
            vm.isWriter
              ? `<button class="btn ${isManual ? 'btn-utility' : 'btn-primary'} btn-full" data-action="new-match">New Match</button>`
              : ''
          }
          ${
            !isManual && vm.canUndo
              ? `<button class="btn btn-utility btn-full" data-action="undo"><span aria-hidden="true">↺</span><span>Undo last point</span></button>`
              : ''
          }
        </div>

        ${renderMoreStatsDetails({
          analytics: vm.matchOverAnalytics,
          scoringMode: s.scoringMode,
          exportSource: 'current',
          exportMatchId: null,
          stateKey,
          isOpen: moreOpen,
        })}

        <div data-sw-update-slot>${renderSwUpdateStrip(swStateVal)}</div>
      </section>
    `;
  }

  function renderHistoryScreen(vm, swStateVal) {
    const h = vm.history;
    const nowMs = Date.now();

    const statusNote =
      h.status === 'CORRUPT' || h.status === 'READ_ERROR'
        ? `<div class="strip strip-err">History storage is unreadable (${escapeHtml(h.status)}). Stored data was left intact.</div>`
        : h.corruptCount > 0
          ? `<div class="strip strip-warn">${h.corruptCount} unreadable history row(s) detected. Valid matches stay viewable and exportable; history edits are paused to preserve stored data.</div>`
          : '';

    const rows =
      h.items.length === 0
        ? '<div class="muted">No archived matches yet. Finished matches appear here automatically.</div>'
        : `<div class="history-list">
            ${h.items
              .map((item) => {
                const isManual = item.status === 'FINISHED_MANUAL';
                const isWin = !isManual && item.winner === 0;
                const verdict = isManual ? 'Ended Early' : isWin ? 'US Won' : 'THEM Won';
                const verdictCls = isManual ? '' : isWin ? 'us-text' : 'them-text';
                const localDate = formatLocalMatchDate(item.timestampMs, nowMs);
                const scoreDisplay = formatHistoryRowScoreText(item);
                const rowAria = `${verdict}, ${scoreDisplay}, ${localDate}, ${item.durationText}, ${item.myUePoints} My UEs (${item.uePctText}). Open match details.`;

                return `
                  <button
                    class="history-row"
                    data-action="inspect-history"
                    data-match-id="${escapeHtml(item.matchId)}"
                    data-history-id="${escapeHtml(item.matchId)}"
                    aria-label="${escapeHtml(rowAria)}"
                  >
                    <span class="history-left">
                      <span class="history-title-line">
                        <span class="history-verdict ${verdictCls}">${escapeHtml(verdict)}</span>
                        ${item.isCurrentlyOpenActive ? '<span class="history-tag">Current</span>' : ''}
                      </span>
                      <span class="history-meta">
                        <span>${escapeHtml(localDate)} · ${escapeHtml(item.durationText)} · </span>
                        <span class="ue-text" style="font-weight:700;">UE ${item.myUePoints} (${escapeHtml(item.uePctText)})</span>
                      </span>
                    </span>
                    <span class="history-right" aria-hidden="true">
                      <span class="history-scores">${escapeHtml(scoreDisplay)}</span>
                      <span class="history-chevron">›</span>
                    </span>
                  </button>
                `;
              })
              .join('')}
          </div>`;

    return `
      <section class="screen-body" data-screen="HISTORY">
        <h1 class="screen-heading" tabindex="-1" data-history-heading>Match History</h1>
        ${h.error ? `<div class="strip strip-err" role="alert">${escapeHtml(h.error)}</div>` : ''}
        ${statusNote}
        ${rows}
        <div data-sw-update-slot>${vm.baseScreen !== 'LIVE' ? renderSwUpdateStrip(swStateVal) : ''}</div>
      </section>
    `;
  }

  function renderHistoryDetailScreen(vm, swStateVal) {
    const h = vm.history;
    const rec = h.inspectedRecord;
    const ana = h.inspectedAnalytics;
    if (!rec) {
      return renderHistoryScreen(vm, swStateVal);
    }

    const confirmOpen = h.confirmDeleteMatchId === rec.matchId;
    const deleteBlock = h.inspectedCanDelete
      ? confirmOpen
        ? `<div class="confirm-box">
             <div><strong>Delete this match from history?</strong> Export first if you want a copy.</div>
             <div class="row-2">
               <button class="btn" data-action="cancel-delete-history">Cancel</button>
               <button class="btn btn-danger" data-action="confirm-delete-history" data-match-id="${escapeHtml(rec.matchId)}">Confirm Delete</button>
             </div>
           </div>`
        : `<button class="btn btn-danger btn-full" data-action="open-delete-history" data-match-id="${escapeHtml(rec.matchId)}">Delete from History</button>`
      : h.inspectedIsOpenActive
        ? '<div class="muted">Currently open on Result — start a New Match before deleting from history.</div>'
        : '';

    // Even if analytics ever fail to compute, keep Match Detail accessible so the match can still be deleted or exported
    if (!ana) {
      return `
        <section class="screen-body" data-screen="HISTORY_DETAIL">
          <h1 class="screen-heading">Match Detail</h1>
          ${h.error ? `<div class="strip strip-err" role="alert">${escapeHtml(h.error)}</div>` : ''}
          <div class="strip strip-warn">Analytics could not be calculated for this saved match.</div>
          ${deleteBlock}
          <div data-sw-update-slot>${vm.baseScreen !== 'LIVE' ? renderSwUpdateStrip(swStateVal) : ''}</div>
        </section>
      `;
    }

    const s = ana.summary;
    const isManual = s.status === 'FINISHED_MANUAL';
    const isWin = !isManual && s.winner === 0;
    const headline = isManual ? 'Ended Early' : isWin ? 'US Won' : 'THEM Won';
    const localDate = formatLocalMatchDate(h.inspectedTimestampMs, Date.now());
    const stateKey = `hist:${rec.matchId}:${rec.revision}`;
    const setFlow = getCachedSetFlow(stateKey, ana);
    const selection = getSelectionForKey(stateKey, setFlow);
    const takeaway = buildMatchTakeaway(ana, setFlow);
    const moreOpen = Boolean(moreStatsOpenMap.get(stateKey));

    return `
      <section class="screen-body" data-screen="HISTORY_DETAIL">
        ${h.error ? `<div class="strip strip-err" role="alert">${escapeHtml(h.error)}</div>` : ''}

        <div class="stack-md">
          <div class="strip-row" style="align-items:baseline;">
            <h1 class="screen-heading">${escapeHtml(headline)}</h1>
            <span class="muted tabular">${escapeHtml(localDate)} · ${escapeHtml(formatDuration(s.durationSec))}</span>
          </div>
          ${renderScoreboardGrid(s)}
        </div>

        ${renderUeTelemetryCard(s.counts, takeaway)}

        <div data-setflow-slot="${escapeHtml(stateKey)}">
          ${renderSetFlowCard(setFlow, stateKey, selection)}
        </div>

        ${renderMoreStatsDetails({
          analytics: ana,
          scoringMode: s.scoringMode,
          exportSource: 'history',
          exportMatchId: rec.matchId,
          stateKey,
          isOpen: moreOpen,
        })}

        ${deleteBlock}
        <div data-sw-update-slot>${vm.baseScreen !== 'LIVE' ? renderSwUpdateStrip(swStateVal) : ''}</div>
      </section>
    `;
  }

  function clearActiveUpdateAttempt() {
    updateAttemptId += 1;
    if (typeof updateAttemptCleanup === 'function') {
      const fn = updateAttemptCleanup;
      updateAttemptCleanup = null;
      fn();
    }
  }

  function patchSwUpdateSlots(vm = controller.getViewModel()) {
    const screenSlot = screenEl.querySelector('[data-sw-update-slot]');
    if (screenSlot) {
      const nextHtml =
        vm.baseScreen !== 'LIVE' && isSafeUpdateScreen(vm.screen) ? renderSwUpdateStrip(swState) : '';
      if (screenSlot.dataset.lastHtml !== nextHtml) {
        const slotFocus = captureFocusDescriptor(screenSlot);
        screenSlot.innerHTML = nextHtml;
        screenSlot.dataset.lastHtml = nextHtml;
        restoreFocusDescriptor(screenSlot, slotFocus);
      }
    }

    const menuSlot = sheetsEl.querySelector('[data-menu-update-slot]');
    if (menuSlot) {
      const nextHtml = renderMenuUpdateNoteHtml(swState);
      if (menuSlot.dataset.lastHtml !== nextHtml) {
        menuSlot.innerHTML = nextHtml;
        menuSlot.dataset.lastHtml = nextHtml;
      }
    }
  }

  function syncSwReadyFromRegistration(reg) {
    if (!reg || !('serviceWorker' in navigator)) return;
    const waiting = reg.waiting;
    const hasWaiting = Boolean(waiting && navigator.serviceWorker.controller);

    if (swState.applying && requestedUpdateWorker && requestedUpdateWorker !== waiting) {
      clearActiveUpdateAttempt();
      requestedUpdateWorker = null;
      swState.applying = false;
      swState.notice = hasWaiting ? 'A newer update arrived. Tap Update now to retry.' : null;
      swState.ready = hasWaiting;
      patchSwUpdateSlots();
      return;
    }

    if (hasWaiting !== swState.ready) {
      swState.ready = hasWaiting;
      if (!hasWaiting) {
        clearActiveUpdateAttempt();
        requestedUpdateWorker = null;
        swState.applying = false;
        swState.notice = null;
      }
      patchSwUpdateSlots();
    }
  }

  function watchInstallingWorker(worker, reg) {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' || worker.state === 'activated' || worker.state === 'redundant') {
        syncSwReadyFromRegistration(reg);
      }
    });
  }

  function applySwUpdate() {
    if (!swRegistration || swState.applying) return;
    const vm = controller.getViewModel();
    if (!isSafeUpdateScreen(vm.screen) || vm.baseScreen === 'LIVE') {
      return;
    }

    const waiting = swRegistration.waiting;
    if (!waiting || waiting.state === 'redundant') {
      swState.ready = false;
      swState.notice = null;
      patchSwUpdateSlots(vm);
      return;
    }

    clearActiveUpdateAttempt();
    const myAttemptId = updateAttemptId;
    requestedUpdateWorker = waiting;
    swState.applying = true;
    swState.notice = null;
    patchSwUpdateSlots(vm);

    const channel = new MessageChannel();
    let timerId = null;

    const failAttempt = (noticeMsg) => {
      if (myAttemptId !== updateAttemptId) return;
      clearActiveUpdateAttempt();
      requestedUpdateWorker = null;
      swState.applying = false;
      const latestWaiting = swRegistration?.waiting ?? null;
      swState.ready = Boolean(latestWaiting && navigator.serviceWorker.controller);
      swState.notice = swState.ready ? noticeMsg : null;
      patchSwUpdateSlots();
    };

    const onWaitingStateChange = () => {
      if (myAttemptId !== updateAttemptId) return;
      if (waiting.state === 'redundant') {
        failAttempt('Update worker was replaced before activating. Tap Update now to retry.');
      }
    };

    waiting.addEventListener('statechange', onWaitingStateChange);
    timerId = window.setTimeout(() => {
      failAttempt('Update timed out. Close other tabs or tap Update now to retry.');
    }, SW_UPDATE_TIMEOUT_MS);

    updateAttemptCleanup = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      waiting.removeEventListener('statechange', onWaitingStateChange);
      try {
        channel.port1.onmessage = null;
        channel.port1.close();
      } catch {
        // Ignore port close errors
      }
    };

    channel.port1.onmessage = (msgEvent) => {
      if (myAttemptId !== updateAttemptId) return;
      const res = msgEvent.data;
      if (!res || res.ok !== true) {
        failAttempt(
          res?.reason === 'other_window_open'
            ? 'Close other PadelScore tabs first, then tap Update again.'
            : 'Could not apply update yet. Close other tabs and try again.'
        );
      }
    };

    try {
      waiting.postMessage({ type: 'SKIP_WAITING' }, [channel.port2]);
    } catch {
      failAttempt('Could not contact update worker. Close and reopen the app to update.');
    }
  }

  function renderTopbarHtml(vm) {
    if (vm.screen === 'HISTORY') {
      const backAria =
        vm.baseScreen === 'LIVE'
          ? 'Back to live match'
          : vm.baseScreen === 'MATCH_OVER'
            ? 'Back to match result'
            : 'Back';
      return `
        <header class="topbar topbar-sub">
          <div class="topbar-left">
            <button class="icon-btn icon-btn-ink" data-action="close-history" aria-label="${escapeHtml(backAria)}">${iconSvg('back')}</button>
            <span class="sub-title">History (${vm.history.count})</span>
          </div>
          ${
            vm.baseScreen === 'LIVE'
              ? '<button class="icon-btn icon-btn-pill" data-action="close-history">← Match</button>'
              : ''
          }
        </header>
      `;
    }

    if (vm.screen === 'HISTORY_DETAIL') {
      return `
        <header class="topbar topbar-sub">
          <div class="topbar-left">
            <button class="icon-btn icon-btn-ink" data-action="back-history-list" aria-label="Back to match history">${iconSvg('back')}</button>
            <span class="sub-title">Match Detail</span>
          </div>
          ${
            vm.baseScreen === 'LIVE'
              ? '<button class="icon-btn icon-btn-pill" data-action="close-history" aria-label="Return to live match">← Match</button>'
              : ''
          }
        </header>
      `;
    }

    const showHistoryBtn = vm.screen !== 'LOADING';
    const isBandHealthyLive = vm.isWriter && vm.screen === 'LIVE' && vm.wrist.status === 'ARMED';
    const histCount = vm.history.count;
    const histAria = `Match history, ${histCount} ${histCount === 1 ? 'match' : 'matches'}`;

    return `
      <header class="topbar">
        <span class="brand-title">PADELSCORE</span>
        <div class="topbar-actions">
          ${
            isBandHealthyLive
              ? `<button class="icon-btn icon-btn-ink" data-action="toggle-guide" data-guide-opener="topbar" aria-label="Band controls ready. Open Band guide"><span class="status-dot" aria-hidden="true"></span>${iconSvg('band')}</button>`
              : vm.screen !== 'LOADING'
                ? `<button class="icon-btn" data-action="toggle-guide" data-guide-opener="topbar" aria-label="How to use Band">${iconSvg('guide')}</button>`
                : ''
          }
          ${
            showHistoryBtn
              ? `<button class="icon-btn" data-action="open-history" aria-label="${escapeHtml(histAria)}">
                   ${iconSvg('history')}
                   ${histCount > 0 ? `<span class="icon-badge" aria-hidden="true">${histCount}</span>` : ''}
                 </button>`
              : ''
          }
        </div>
      </header>
    `;
  }

  function captureHorizontalScrolls(container) {
    const map = new Map();
    for (const el of container.querySelectorAll('[data-scroll-key]')) {
      map.set(el.dataset.scrollKey, el.scrollLeft);
    }
    return map;
  }

  function restoreHorizontalScrolls(container, savedMap) {
    for (const el of container.querySelectorAll('[data-scroll-key]')) {
      const key = el.dataset.scrollKey;
      if (savedMap.has(key)) {
        el.scrollLeft = savedMap.get(key);
      } else if (el.dataset.ladderScroller === 'true' && !autoScrolledKeys.has(key)) {
        autoScrolledKeys.add(key);
        scrollSelectedColumnIntoScroller(el);
      }
    }
  }

  function buildScreenTemplate(vm) {
    if (vm.screen === 'LOADING') return renderLoadingScreen();
    if (vm.screen === 'READ_ERROR') return renderReadErrorScreen(vm);
    if (vm.screen === 'CORRUPT') return renderCorruptScreen(vm);
    if (vm.screen === 'HISTORY') return renderHistoryScreen(vm, swState);
    if (vm.screen === 'HISTORY_DETAIL') return renderHistoryDetailScreen(vm, swState);
    if (vm.screen === 'SETUP') return renderSetupScreen(vm, swState);
    if (vm.screen === 'LIVE') return renderLiveScreen(vm);
    return renderMatchOverScreen(vm, swState);
  }

  function patchSetFlowInPlace(stateKey, vm) {
    const slot = screenEl.querySelector(`[data-setflow-slot="${CSS.escape(stateKey)}"]`);
    if (!slot) return;
    const analytics = vm.screen === 'HISTORY_DETAIL' ? vm.history.inspectedAnalytics : vm.matchOverAnalytics;
    const setFlow = getCachedSetFlow(stateKey, analytics);
    const selection = getSelectionForKey(stateKey, setFlow);
    const savedScrolls = captureHorizontalScrolls(slot);
    const focusDesc = captureFocusDescriptor(slot);

    slot.innerHTML = renderSetFlowCard(setFlow, stateKey, selection);
    restoreHorizontalScrolls(slot, savedScrolls);
    restoreFocusDescriptor(slot, focusDesc);
    // Keep lastScreenHtml synchronized with exact template text (never browser-serialized innerHTML)
    lastScreenHtml = buildScreenTemplate(vm);
  }

  function renderChrome(vm) {
    const bannersHtml = `${renderReadOnlyBanner(vm)}${renderWristRecoveryBanner(vm)}${renderErrorBanners(vm)}${
      copyFeedback ? `<div class="strip strip-ok" role="status">${escapeHtml(copyFeedback)}</div>` : ''
    }`;

    const nextChromeHtml = `${renderTopbarHtml(vm)}<div class="chrome-banners">${bannersHtml}</div>`;

    if (nextChromeHtml !== lastChromeHtml) {
      const chromeFocus = captureFocusDescriptor(chromeEl);
      chromeEl.innerHTML = nextChromeHtml;
      lastChromeHtml = nextChromeHtml;
      restoreFocusDescriptor(chromeEl, chromeFocus);
    }
  }

  function render(vm) {
    renderChrome(vm);

    const awaitingServer = Boolean(
      vm.screen === 'LIVE' && vm.state?.status === 'ACTIVE' && vm.state?.needsInitialServer
    );
    const canPatchLiveInPlace =
      prevScreen === 'LIVE' &&
      vm.screen === 'LIVE' &&
      prevAwaitingServer === awaitingServer &&
      screenEl.querySelector('[data-live-mounted="true"]') !== null;

    if (canPatchLiveInPlace) {
      updateLiveScreenInPlace(screenEl, vm);
    } else {
      const body = buildScreenTemplate(vm);

      // P1 Fix: Skip full screen rebuild when screen HTML hasn't changed (e.g. CSV/JSON export feedback)
      if (body !== lastScreenHtml || vm.screen !== prevScreen) {
        const savedScrolls = captureHorizontalScrolls(screenEl);
        const screenFocus = captureFocusDescriptor(screenEl);
        screenEl.innerHTML = body;
        lastScreenHtml = body;
        restoreHorizontalScrolls(screenEl, savedScrolls);
        restoreFocusDescriptor(screenEl, screenFocus);
      }
    }

    // Move focus to recovery box if archive failure just blocked replacement Setup
    if (vm.archiveBlockedDraft && !prevArchiveBlocked) {
      screenEl.querySelector('[data-testid="archive-blocked-box"] button[data-action="retry-archive"]')?.focus();
    }
    prevArchiveBlocked = Boolean(vm.archiveBlockedDraft);

    // Move focus to History heading after deleting a match from Detail
    if (pendingHistoryFocusAfterDelete && vm.screen === 'HISTORY') {
      pendingHistoryFocusAfterDelete = false;
      screenEl.querySelector('[data-history-heading]')?.focus();
    }

    prevScreen = vm.screen;
    prevAwaitingServer = awaitingServer;

    const menuNow = Boolean(vm.ui.menuOpen && vm.isWriter && vm.screen === 'LIVE');
    const guideNow = Boolean(vm.ui.guideOpen);
    const sheetOpen = menuNow || guideNow;

    if (menuNow && prevMenuOpen && !guideNow && sheetsEl.querySelector('[data-testid="menu-panel"]')) {
      updateMenuSheetInPlace(sheetsEl.querySelector('[data-testid="menu-panel"]'), vm, swState);
    } else if (guideNow && prevGuideOpen && !menuNow && sheetsEl.querySelector('[data-testid="guide-panel"]')) {
      const nextGuideHtml = renderGuideSheet(vm);
      if (nextGuideHtml !== lastGuideHtml) {
        const guideFocus = captureFocusDescriptor(sheetsEl);
        sheetsEl.innerHTML = nextGuideHtml;
        lastGuideHtml = nextGuideHtml;
        restoreFocusDescriptor(sheetsEl, guideFocus);
      }
    } else {
      const nextGuideHtml = renderGuideSheet(vm);
      lastGuideHtml = nextGuideHtml;
      sheetsEl.innerHTML = `${renderMenuSheet(vm, swState)}${nextGuideHtml}`;
    }

    shellEl.inert = sheetOpen;
    if (sheetOpen) {
      shellEl.setAttribute('aria-hidden', 'true');
    } else {
      shellEl.removeAttribute('aria-hidden');
    }

    if (menuNow && !prevMenuOpen) {
      sheetsEl.querySelector('[data-sheet-close="menu"]')?.focus();
    } else if (guideNow && !prevGuideOpen) {
      sheetsEl.querySelector('[data-sheet-close="guide"]')?.focus();
    } else if ((!menuNow && prevMenuOpen) || (!guideNow && prevGuideOpen)) {
      if (lastOpenerSelector) {
        shellEl.querySelector(lastOpenerSelector)?.focus();
      }
    }
    prevMenuOpen = menuNow;
    prevGuideOpen = guideNow;
  }

  function triggerDownload(source, matchId, format) {
    const res = controller.getExportData({ source, matchId }, format);
    if (!res.ok) {
      copyFeedback = `Export failed: ${res.error?.message || 'Unable to generate file'}`;
      renderChrome(controller.getViewModel());
      return;
    }
    try {
      const blob = new Blob([res.content], { type: res.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Ignore revoke errors
        }
      }, 10_000);
      copyFeedback = `Download requested: ${res.filename}`;
    } catch {
      copyFeedback = 'Download failed on this browser.';
    }
    renderChrome(controller.getViewModel());
  }

  async function copyText(text, label) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        copyFeedback = `Copied ${label}.`;
      } else {
        copyFeedback = 'Clipboard unavailable — select text manually.';
      }
    } catch {
      copyFeedback = 'Copy failed — select text manually.';
    }
    renderChrome(controller.getViewModel());
  }

  // Persist open/closed state of More stats <details> across renders & keep template cache aligned
  root.addEventListener(
    'toggle',
    (event) => {
      const target = event.target;
      if (target && target.tagName === 'DETAILS' && target.dataset?.moreStats) {
        moreStatsOpenMap.set(target.dataset.moreStats, Boolean(target.open));
        const vm = controller.getViewModel();
        if (vm.screen === 'MATCH_OVER' || vm.screen === 'HISTORY_DETAIL') {
          lastScreenHtml = buildScreenTemplate(vm);
        }
      }
    },
    true
  );

  // Native Setup radio groups
  root.addEventListener('change', (event) => {
    const input = event.target;
    if (!input || input.tagName !== 'INPUT' || input.type !== 'radio' || input.disabled) return;
    copyFeedback = '';
    if (input.name === 'scoring-mode') {
      controller.setSetupScoringMode(input.value);
    } else if (input.name === 'wrist-mode') {
      controller.setWristCenterMode(input.value);
    } else if (input.name === 'initial-server') {
      const team = input.value === '0' ? 0 : input.value === '1' ? 1 : null;
      controller.setSetupInitialServer(team);
    }
  });

  root.addEventListener('click', (event) => {
    const backdrop = event.target.classList?.contains('sheet-backdrop') ? event.target : null;
    if (backdrop) {
      if (backdrop.dataset.backdrop === 'menu') controller.setMenuOpen(false);
      if (backdrop.dataset.backdrop === 'guide') controller.setGuideOpen(false);
      return;
    }

    const btn = event.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    copyFeedback = '';
    const action = btn.dataset.action;

    if (action === 'select-setflow-set') {
      const stateKey = btn.dataset.stateKey;
      const setIdx = Number(btn.dataset.setIdx);
      const vm = controller.getViewModel();
      const ana = vm.screen === 'HISTORY_DETAIL' ? vm.history.inspectedAnalytics : vm.matchOverAnalytics;
      const flow = getCachedSetFlow(stateKey, ana);
      if (flow && flow.sets[setIdx]) {
        setFlowSelection.set(stateKey, {
          setIdx,
          gameIdx: flow.sets[setIdx].defaultGameIndex,
        });
        patchSetFlowInPlace(stateKey, vm);
      }
      return;
    }

    if (action === 'select-setflow-game') {
      const stateKey = btn.dataset.stateKey;
      const gameIdx = Number(btn.dataset.gameIdx);
      const vm = controller.getViewModel();
      const ana = vm.screen === 'HISTORY_DETAIL' ? vm.history.inspectedAnalytics : vm.matchOverAnalytics;
      const flow = getCachedSetFlow(stateKey, ana);
      const cur = getSelectionForKey(stateKey, flow);
      setFlowSelection.set(stateKey, { setIdx: cur.setIdx, gameIdx });
      patchSetFlowInPlace(stateKey, vm);
      return;
    }

    if (action === 'set-scoring-mode') {
      controller.setSetupScoringMode(btn.dataset.mode);
    } else if (action === 'set-wrist-mode') {
      controller.setWristCenterMode(btn.dataset.mode);
    } else if (action === 'cancel-wrist-edit') {
      controller.cancelWristEdit();
    } else if (action === 'set-server') {
      const team = btn.dataset.team === '0' ? 0 : btn.dataset.team === '1' ? 1 : null;
      controller.setSetupInitialServer(team);
    } else if (action === 'pick-initial-server') {
      const team = btn.dataset.team === '0' ? 0 : btn.dataset.team === '1' ? 1 : null;
      if (team !== null) {
        controller.selectInitialServer(team);
      }
    } else if (action === 'start-match') {
      controller.startMatch({ linkWrist: true });
    } else if (action === 'start-match-discard') {
      controller.startMatch({ linkWrist: true, allowDiscardUnarchived: true });
    } else if (action === 'cancel-replacement') {
      controller.cancelReplacementSetup();
    } else if (action === 'retry-archive') {
      const res = controller.retryArchiveCurrentMatch();
      if (res && res.ok) {
        screenEl
          .querySelector('button[data-action="start-match"]:not([disabled]), button[data-action="new-match"]:not([disabled])')
          ?.focus({ preventScroll: true });
      }
    } else if (action === 'apply-sw-update') {
      applySwUpdate();
    } else if (action === 'open-history') {
      const vm = controller.getViewModel();
      if (vm.ui.guideOpen) controller.setGuideOpen(false);
      if (vm.ui.menuOpen) controller.setMenuOpen(false);
      controller.openHistory();
    } else if (action === 'close-history') {
      controller.closeHistory();
    } else if (action === 'inspect-history') {
      controller.inspectHistoryMatch(btn.dataset.matchId);
    } else if (action === 'back-history-list') {
      controller.backToHistoryList();
    } else if (action === 'open-delete-history') {
      controller.setConfirmDeleteMatchId(btn.dataset.matchId);
      screenEl.querySelector('button[data-action="cancel-delete-history"]')?.focus({ preventScroll: true });
    } else if (action === 'cancel-delete-history') {
      controller.setConfirmDeleteMatchId(null);
      screenEl.querySelector('button[data-action="open-delete-history"]')?.focus({ preventScroll: true });
    } else if (action === 'confirm-delete-history') {
      const res = controller.deleteHistoryMatch(btn.dataset.matchId);
      if (res && res.ok) {
        copyFeedback = 'Match deleted.';
        pendingHistoryFocusAfterDelete = true;
        render(controller.getViewModel());
      }
    } else if (action === 'export-match') {
      triggerDownload(
        btn.dataset.source || 'current',
        btn.dataset.matchId || null,
        btn.dataset.format || 'csv'
      );
    } else if (action === 'score') {
      controller.scorePoint(btn.dataset.code);
    } else if (action === 'undo') {
      controller.undo();
    } else if (action === 'relink-wrist') {
      const wasInGuide = controller.getViewModel().ui.guideOpen;
      controller.setMenuOpen(false);
      Promise.resolve(controller.relinkWrist()).finally(() => {
        if (wasInGuide) {
          sheetsEl.querySelector('[data-sheet-close="guide"]')?.focus({ preventScroll: true });
        } else if (!chromeEl.contains(document.activeElement) && !screenEl.contains(document.activeElement)) {
          screenEl
            .querySelector('button[data-action="score"][data-code="A"]:not([disabled]), button[data-action="pick-initial-server"]:not([disabled])')
            ?.focus({ preventScroll: true });
        }
      });
    } else if (action === 'toggle-menu') {
      const vm = controller.getViewModel();
      if (!vm.ui.menuOpen) lastOpenerSelector = 'button[data-action="toggle-menu"]:not([disabled])';
      controller.setMenuOpen(!vm.ui.menuOpen);
    } else if (action === 'close-menu') {
      controller.setMenuOpen(false);
    } else if (action === 'toggle-guide') {
      const vm = controller.getViewModel();
      if (!vm.ui.guideOpen) {
        const opener = btn.dataset.guideOpener;
        if (opener === 'setup-row') {
          lastOpenerSelector = 'button[data-guide-opener="setup-row"]:not([disabled])';
        } else if (opener === 'recovery') {
          lastOpenerSelector = 'button[data-guide-opener="recovery"]:not([disabled])';
        } else if (opener === 'menu') {
          lastOpenerSelector = 'button[data-action="toggle-menu"]:not([disabled])';
        } else {
          lastOpenerSelector = 'button[data-guide-opener="topbar"]:not([disabled])';
        }
      }
      controller.setGuideOpen(!vm.ui.guideOpen);
    } else if (action === 'close-guide') {
      controller.setGuideOpen(false);
    } else if (action === 'open-opener') {
      controller.setConfirmOpenerOpen(true);
    } else if (action === 'cancel-opener') {
      controller.setConfirmOpenerOpen(false);
    } else if (action === 'confirm-opener') {
      const team = btn.dataset.team === '0' ? 0 : btn.dataset.team === '1' ? 1 : null;
      if (team !== null) {
        controller.correctFirstServer(team);
      }
    } else if (action === 'open-finish') {
      controller.setConfirmFinishOpen(true);
    } else if (action === 'cancel-finish') {
      controller.setConfirmFinishOpen(false);
    } else if (action === 'confirm-finish') {
      controller.finishNow();
    } else if (action === 'resume') {
      controller.resume();
    } else if (action === 'new-match') {
      controller.openReplacementSetup();
    } else if (action === 'takeover-writer') {
      controller.takeOverWriter();
    } else if (action === 'step-down') {
      controller.stepDownToReadOnly();
    } else if (action === 'retry-read') {
      controller.retryRead();
    } else if (action === 'open-clear-corrupt') {
      controller.setConfirmClearCorruptOpen(true);
    } else if (action === 'cancel-clear-corrupt') {
      controller.setConfirmClearCorruptOpen(false);
    } else if (action === 'confirm-clear-corrupt') {
      controller.clearCorruptRecord();
    } else if (action === 'copy-corrupt') {
      const vm = controller.getViewModel();
      copyText(vm.corruptRaw || '', 'raw match payload');
    } else if (action === 'copy-diag') {
      const vm = controller.getViewModel();
      copyText(JSON.stringify(vm.diagEntries, null, 2), 'diagnostic log');
    } else if (action === 'clear-diag') {
      controller.clearDiagnosticLog();
    }
  });

  document.addEventListener('keydown', (event) => {
    const vm = controller.getViewModel();
    const activeSheet = sheetsEl.querySelector('.sheet');

    if (event.key === 'Escape') {
      if (vm.ui.guideOpen) {
        controller.setGuideOpen(false);
      } else if (vm.ui.menuOpen) {
        controller.setMenuOpen(false);
      }
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      const tab = document.activeElement?.closest?.('button[role="tab"][data-action="select-setflow-set"]');
      if (tab) {
        const list = tab.closest('[role="tablist"]');
        const tabs = list ? Array.from(list.querySelectorAll('button[role="tab"]')) : [];
        const curIdx = tabs.indexOf(tab);
        if (curIdx >= 0 && tabs.length > 1) {
          event.preventDefault();
          let nextIdx = curIdx;
          if (event.key === 'ArrowRight') nextIdx = (curIdx + 1) % tabs.length;
          else if (event.key === 'ArrowLeft') nextIdx = (curIdx - 1 + tabs.length) % tabs.length;
          else if (event.key === 'Home') nextIdx = 0;
          else if (event.key === 'End') nextIdx = tabs.length - 1;
          tabs[nextIdx].click();
          const refreshed = screenEl.querySelector(
            `button[role="tab"][data-state-key="${CSS.escape(tab.dataset.stateKey)}"][data-set-idx="${nextIdx}"]`
          );
          refreshed?.focus({ preventScroll: true });
        }
        return;
      }
    }

    if (event.key === 'Tab' && activeSheet) {
      const focusables = getSheetFocusables(activeSheet);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (event.shiftKey) {
        if (!activeSheet.contains(current) || current === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!activeSheet.contains(current) || current === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  window.addEventListener('storage', (e) => {
    controller.handleStorageEvent(e.key);
  });

  document.addEventListener('visibilitychange', () => {
    controller.handleVisibilityChange(document.visibilityState);
    if (document.visibilityState === 'visible' && swRegistration) {
      const nowMs = Date.now();
      if (nowMs - lastSwUpdateCheckMs >= SW_UPDATE_THROTTLE_MS) {
        lastSwUpdateCheckMs = nowMs;
        swRegistration.update().catch(() => {});
      }
    }
  });

  window.addEventListener('pagehide', () => {
    controller.handlePageHideOrFreeze('pagehide');
  });
  document.addEventListener('freeze', () => {
    controller.handlePageHideOrFreeze('freeze');
  });

  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      controller.handlePageShowOrResume();
    }
  });
  document.addEventListener('resume', () => {
    controller.handlePageShowOrResume();
  });

  window.setInterval(() => {
    if (document.visibilityState === 'visible') {
      controller.tickDisplay();
    }
  }, 1000);

  controller.init();

  // Register offline Service Worker with multi-window-safe user-triggered update discovery
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const vm = controller.getViewModel();
      const shouldReload =
        vm.baseScreen !== 'LIVE' &&
        shouldReloadOnControllerChange({
          requestedWorker: requestedUpdateWorker,
          newController: navigator.serviceWorker.controller,
          screen: vm.screen,
        });

      clearActiveUpdateAttempt();
      requestedUpdateWorker = null;
      swState.ready = false;
      swState.applying = false;
      swState.notice = null;

      if (shouldReload) {
        window.location.reload();
      } else {
        patchSwUpdateSlots(vm);
      }
    });

    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((reg) => {
        swRegistration = reg;
        lastSwUpdateCheckMs = Date.now();
        reg.addEventListener('updatefound', () => {
          watchInstallingWorker(reg.installing, reg);
        });
        if (reg.installing) {
          watchInstallingWorker(reg.installing, reg);
        }
        syncSwReadyFromRegistration(reg);
      })
      .catch(() => {});
  }
}

boot();
