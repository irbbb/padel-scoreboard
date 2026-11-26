import { createKeepAliveAudioBlobUrl } from './wavGenerator.js';
import {
  createAppController,
  createGuardedStorage,
  formatDiagTime,
  formatDuration,
  formatSetLine,
  formatUePercent,
} from './appController.js';
import {
  computePointShare,
  describeBandControls,
  getBandGuideSteps,
  getCenterModeSummary,
  isSafeUpdateScreen,
  renderMatchTapeSvg,
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

function renderBandKeysHtml(keys) {
  return `
    <div class="band-keys">
      ${keys
        .map((k) => {
          const classes = ['band-key'];
          if (k.highlight) classes.push('band-key-highlight');
          else if (k.tone === 'ue') classes.push('band-key-ue');
          if (k.disabled) classes.push('band-key-disabled');
          return `
            <div class="${classes.join(' ')}">
              <span class="band-key-symbol">${escapeHtml(k.symbol)}</span>
              <span class="band-key-label">${escapeHtml(k.label)}</span>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderBandPanel(vm, { label = 'Band 9 Active', compact = false } = {}) {
  const band = describeBandControls(vm);
  const boxCls =
    band.emphasis === 'resume'
      ? 'band-strip band-strip-resume'
      : band.emphasis === 'edit'
        ? 'band-strip band-strip-edit'
        : 'band-strip';
  const isEditOverlay = band.phase === 'PROMPT' || band.phase === 'AWAITING_LIVE';
  const showCancelEdit = band.phase === 'PROMPT' && vm.isWriter && vm.screen === 'LIVE';

  return `
    <div class="${boxCls}" data-testid="${isEditOverlay ? 'wrist-edit-banner' : 'band-controls-panel'}">
      <div class="band-header-row">
        <span class="band-cue-title">${escapeHtml(band.headline)}</span>
        ${
          showCancelEdit
            ? '<button class="btn btn-inline" data-action="cancel-wrist-edit">Cancel Edit</button>'
            : `<span class="section-label">${escapeHtml(label)}</span>`
        }
      </div>
      ${
        band.showKeys
          ? `<div class="band-screen" aria-label="Band 9 Active display lines">
               <div class="band-screen-title">${escapeHtml(band.title || '—')}</div>
               <div class="band-screen-artist">${escapeHtml(band.artist || '')}</div>
             </div>
             ${renderBandKeysHtml(band.keys)}`
          : ''
      }
      ${compact ? '' : `<div class="muted">${escapeHtml(band.subcue)}</div>`}
    </div>
  `;
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
               <button class="btn btn-inline" data-action="toggle-guide">Open troubleshooting</button>
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

  return `
    <section class="court-section" data-screen="SETUP">
      <div class="setup-header">
        <h1>${vm.isReplacementSetup ? 'New Match' : 'Court Setup'}</h1>
        <span class="muted">Best of 3 · 6-6 TB</span>
      </div>

      <fieldset class="radio-fieldset">
        <legend class="radio-legend">40–40 deuce rule</legend>
        <div class="radio-group">
          ${renderSetupRadioOption({
            name: 'scoring-mode',
            value: 'AD',
            label: 'Advantage (AD)',
            checked: vm.setupScoringMode === 'AD',
            disabled: isDisabled,
          })}
          ${renderSetupRadioOption({
            name: 'scoring-mode',
            value: 'GP',
            label: 'Golden Point (GP)',
            checked: vm.setupScoringMode === 'GP',
            disabled: isDisabled,
          })}
        </div>
      </fieldset>

      <fieldset class="radio-fieldset">
        <legend class="radio-legend">Band middle button (||)</legend>
        <div class="radio-group">
          ${renderSetupRadioOption({
            name: 'wrist-mode',
            value: 'EDIT_MODE',
            label: 'Edit point',
            checked: vm.wristCenterMode === 'EDIT_MODE',
            disabled: isDisabled,
          })}
          ${renderSetupRadioOption({
            name: 'wrist-mode',
            value: 'ONE_TAP_UE',
            label: '1-Tap My Error',
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

      ${renderBandPanel(vm, { label: 'Band preview', compact: true })}

      <div class="controls-stack">
        <button class="btn btn-primary btn-cta" data-action="start-match" ${isDisabled ? 'disabled' : ''}>
          Start Match &amp; Link Band
        </button>

        <div class="flow-cue" aria-label="How to start">
          <span><strong>1</strong> Start match</span>
          <span><strong>2</strong> Check PadelScore in Band Music</span>
          <span><strong>3</strong> Lock phone</span>
        </div>

        ${
          vm.archiveBlockedDraft
            ? `<div class="confirm-box" data-testid="archive-blocked-box">
                 <div><strong>Previous match could not be archived to history.</strong> Export or retry saving before discarding it.</div>
                 <div class="controls-row">
                   <button class="btn btn-primary" data-action="retry-archive">Retry Save</button>
                   <button class="btn" data-action="export-match" data-source="current" data-format="json">Download JSON</button>
                 </div>
                 <button class="btn" data-action="export-match" data-source="current" data-format="csv">Download CSV</button>
                 <button class="btn btn-danger" data-action="start-match-discard">Start New Match &amp; Discard Copy</button>
               </div>`
            : ''
        }
        ${
          vm.isReplacementSetup
            ? `<button class="btn" data-action="cancel-replacement">Back to Match Over</button>`
            : ''
        }
        <div data-sw-update-slot>${renderSwUpdateStrip(swState)}</div>
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
  return `<button class="btn" data-action="confirm-opener" data-team="${altServer}">Wrong first server? Switch to ${altServerLabel}</button>`;
}

function getLiveBandPanelLabel(vm) {
  if (!vm.isWriter) return 'Viewing only';
  if (vm.wrist.status === 'ARMED') return 'Band controls ready';
  return 'Band status';
}

function renderLiveScreen(vm) {
  const s = vm.state;
  const disabled = vm.isWriter ? '' : 'disabled';
  const undoDisabled = vm.canUndo ? '' : 'disabled';
  const awaitingServer = s.status === 'ACTIVE' && s.needsInitialServer;
  const usServing = s.server === 0;
  const themServing = s.server === 1;
  const gamesText = s.inTieBreak ? 'TB 6-6' : `${s.games[0]} - ${s.games[1]}`;
  const setsMeta = vm.setLines.length ? ` · ${vm.setLines.join(', ')}` : '';

  return `
    <section class="controls-stack" data-screen="LIVE" data-live-mounted="true" data-awaiting-server="${awaitingServer ? 'true' : 'false'}">
      <div class="court-board">
        <div class="court-meta">
          <span data-live-meta-left>BO3 · ${escapeHtml(s.scoringMode)}${escapeHtml(setsMeta)}</span>
          <span><span data-duration-text>${escapeHtml(vm.durationText)}</span> · <span data-live-rev>#${s.revision}</span></span>
        </div>

        <div class="court-halves">
          <div class="court-half ${usServing ? 'court-half-serving' : ''}" data-half="us">
            <div class="half-header">
              <span class="team-tag">US</span>
              <span class="serve-badge" data-serve-badge="us" ${usServing ? '' : 'hidden'}><span class="serve-ball" aria-hidden="true"></span>Serving</span>
            </div>
            <div class="big-points" data-points="us">${escapeHtml(s.pointsLabel[0])}</div>
          </div>

          <div class="court-half ${themServing ? 'court-half-serving' : ''}" data-half="them">
            <div class="half-header">
              <span class="team-tag">THEM</span>
              <span class="serve-badge" data-serve-badge="them" ${themServing ? '' : 'hidden'}><span class="serve-ball" aria-hidden="true"></span>Serving</span>
            </div>
            <div class="big-points" data-points="them">${escapeHtml(s.pointsLabel[1])}</div>
          </div>
        </div>

        <div class="court-baseline">
          <div class="baseline-cell">
            <span class="section-label">Sets</span>
            <span class="baseline-val" data-sets>${s.sets[0]} - ${s.sets[1]}</span>
          </div>
          <div class="baseline-cell">
            <span class="section-label" data-games-label>${s.inTieBreak ? 'Tie-break' : 'Games'}</span>
            <span class="baseline-val" data-games>${escapeHtml(gamesText)}</span>
          </div>
          <div class="baseline-cell">
            <span class="section-label">My UEs</span>
            <span class="baseline-val baseline-val-ue" data-ues>${s.counts.myUePoints} (${escapeHtml(vm.uePctText)})</span>
          </div>
        </div>
      </div>

      ${
        awaitingServer
          ? `<div class="court-section" data-testid="server-picker">
               <div>
                 <strong>Who serves first?</strong>
                 <div class="muted">Tap &lt; (US) or &gt; (THEM) on your Band after the warmup rally, or choose below. Neither awards a point.</div>
               </div>
               <div class="controls-row">
                 <button class="btn btn-pad" data-action="pick-initial-server" data-team="0" ${disabled}>US SERVES</button>
                 <button class="btn btn-pad btn-pad-them" data-action="pick-initial-server" data-team="1" ${disabled}>THEM SERVES</button>
               </div>
               <button class="btn btn-row-label" data-action="toggle-menu" ${disabled}><span>Match Menu</span><span aria-hidden="true">▾</span></button>
             </div>`
          : `<div class="controls-stack">
               <div class="controls-row">
                 <button class="btn btn-pad" data-action="score" data-code="A" ${disabled}><span>US</span><span class="pad-plus">+1</span></button>
                 <button class="btn btn-pad btn-pad-them" data-action="score" data-code="B" ${disabled}><span>THEM</span><span class="pad-plus">+1</span></button>
               </div>

               <button class="btn btn-ue" data-action="score" data-code="E" ${disabled}>
                 <span>MY UE</span>
                 <span class="btn-sub">My unforced error · +1 THEM</span>
               </button>

               <div data-loveall-slot>${renderLoveAllOpenerSwitchHtml(vm)}</div>

               <div class="controls-row">
                 <button class="btn btn-row-label" data-action="undo" ${undoDisabled}><span aria-hidden="true">↺</span><span>Undo</span></button>
                 <button class="btn btn-row-label" data-action="toggle-menu" ${disabled}><span>Match Menu</span><span aria-hidden="true">▾</span></button>
               </div>
             </div>`
      }

      <div data-band-slot>
        ${renderBandPanel(vm, { label: getLiveBandPanelLabel(vm) })}
      </div>
    </section>
  `;
}

function updateLiveScreenInPlace(screenEl, vm) {
  const s = vm.state;
  const usServing = s.server === 0;
  const themServing = s.server === 1;
  const gamesText = s.inTieBreak ? 'TB 6-6' : `${s.games[0]} - ${s.games[1]}`;
  const setsMeta = vm.setLines.length ? ` · ${vm.setLines.join(', ')}` : '';

  const metaLeft = screenEl.querySelector('[data-live-meta-left]');
  if (metaLeft) metaLeft.textContent = `BO3 · ${s.scoringMode}${setsMeta}`;
  const durEl = screenEl.querySelector('[data-duration-text]');
  if (durEl) durEl.textContent = vm.durationText;
  const revEl = screenEl.querySelector('[data-live-rev]');
  if (revEl) revEl.textContent = `#${s.revision}`;

  const usHalf = screenEl.querySelector('[data-half="us"]');
  if (usHalf) usHalf.classList.toggle('court-half-serving', usServing);
  const themHalf = screenEl.querySelector('[data-half="them"]');
  if (themHalf) themHalf.classList.toggle('court-half-serving', themServing);

  const usBadge = screenEl.querySelector('[data-serve-badge="us"]');
  if (usBadge) usBadge.hidden = !usServing;
  const themBadge = screenEl.querySelector('[data-serve-badge="them"]');
  if (themBadge) themBadge.hidden = !themServing;

  const usPts = screenEl.querySelector('[data-points="us"]');
  if (usPts) usPts.textContent = s.pointsLabel[0];
  const themPts = screenEl.querySelector('[data-points="them"]');
  if (themPts) themPts.textContent = s.pointsLabel[1];

  const setsEl = screenEl.querySelector('[data-sets]');
  if (setsEl) setsEl.textContent = `${s.sets[0]} - ${s.sets[1]}`;
  const gamesLbl = screenEl.querySelector('[data-games-label]');
  if (gamesLbl) gamesLbl.textContent = s.inTieBreak ? 'Tie-break' : 'Games';
  const gamesEl = screenEl.querySelector('[data-games]');
  if (gamesEl) gamesEl.textContent = gamesText;
  const uesEl = screenEl.querySelector('[data-ues]');
  if (uesEl) uesEl.textContent = `${s.counts.myUePoints} (${vm.uePctText})`;

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
    const nextBandHtml = renderBandPanel(vm, { label: getLiveBandPanelLabel(vm) });
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
      <div class="controls-row">
        <button class="btn" data-action="cancel-opener">Cancel</button>
        <button class="btn btn-primary" data-action="confirm-opener" data-team="${altOpener}">Switch to ${altLabel}</button>
      </div>
    </div>`;
  }
  return `<button class="btn" data-action="open-opener">Correct first server (currently ${curLabel})</button>`;
}

function renderMenuFinishSlotHtml(vm) {
  if (vm.ui.confirmFinishOpen) {
    return `<div class="confirm-box">
      <div><strong>Finish match early?</strong> Saves current score and disarms band controls. You can still Resume later.</div>
      <div class="controls-row">
        <button class="btn" data-action="cancel-finish">Cancel</button>
        <button class="btn btn-danger" data-action="confirm-finish">Confirm Finish</button>
      </div>
    </div>`;
  }
  return `<button class="btn btn-danger" data-action="open-finish">Finish Match Early</button>`;
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
          <div class="setup-group">
            <span class="section-label">Band middle button (||)</span>
            <div class="controls-row">
              <button class="btn ${editSel}" data-action="set-wrist-mode" data-mode="EDIT_MODE" aria-pressed="${vm.wristCenterMode === 'EDIT_MODE'}">
                <span>Edit point</span>
                <span class="btn-sub">&lt; Undo / &gt; MY UE</span>
              </button>
              <button class="btn ${oneTapSel}" data-action="set-wrist-mode" data-mode="ONE_TAP_UE" aria-pressed="${vm.wristCenterMode === 'ONE_TAP_UE'}">
                <span>1-Tap My Error</span>
                <span class="btn-sub">Direct MY UE</span>
              </button>
            </div>
            <p class="mode-hint" data-menu-mode-hint>${escapeHtml(getCenterModeSummary(vm.wristCenterMode))}</p>
          </div>

          <div class="controls-row">
            ${
              vm.wrist.supported
                ? `<button class="btn" data-action="relink-wrist">Re-link Band</button>`
                : ''
            }
            <button class="btn" data-action="toggle-guide">Band Quick Guide</button>
          </div>

          <div data-menu-opener-slot>${renderMenuOpenerSlotHtml(vm)}</div>
          <div data-menu-finish-slot>${renderMenuFinishSlotHtml(vm)}</div>
          <div data-menu-update-slot>${renderMenuUpdateNoteHtml(swState)}</div>

          <details class="advanced-details">
            <summary>
              <span>Device &amp; Diagnostics</span>
              <span aria-hidden="true">▾</span>
            </summary>
            <div class="advanced-content">
              <button class="btn" data-action="step-down">Release control to another tab</button>
              <div class="strip-row">
                <span class="section-label">Diagnostic Log (recent)</span>
                <div style="display:flex;gap:6px;">
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

function renderGuideSheet(vm) {
  if (!vm.ui.guideOpen) return '';
  const showWarmupStep =
    vm.screen === 'SETUP'
      ? vm.setupInitialServer === null
      : Boolean(vm.state?.status === 'ACTIVE' && vm.state?.needsInitialServer);
  const steps = getBandGuideSteps(vm.wristCenterMode, { showWarmupStep });
  const modeLabel = vm.wristCenterMode === 'EDIT_MODE' ? 'Edit point (default)' : '1-Tap My Error';

  return `
    <div class="sheet-backdrop" data-backdrop="guide">
      <section class="sheet" role="dialog" aria-modal="true" aria-label="Band 9 Active Quick Guide" data-testid="guide-panel">
        <div class="sheet-header">
          <h2>Band 9 Active Guide</h2>
          <button class="btn btn-inline" data-action="close-guide" data-sheet-close="guide">Close</button>
        </div>

        <div class="sheet-body">
          <div class="muted">Active middle button: <strong>${escapeHtml(modeLabel)}</strong>. Start a native Band Workout, then swipe to Music Controls.</div>

          ${steps
            .map(
              (s) => `
                <div class="guide-step">
                  <div class="guide-step-head">
                    <span class="guide-num">${s.step}</span>
                    <span>${escapeHtml(s.title)}</span>
                  </div>
                  <div class="guide-band-sample">
                    <div>${escapeHtml(s.bandTitle)}</div>
                    <div>${escapeHtml(s.bandArtist)}</div>
                  </div>
                  <div class="muted">${escapeHtml(s.caption)}</div>
                </div>
              `
            )
            .join('')}

          <div class="guide-step">
            <div class="guide-step-head"><span>If Band does not respond</span></div>
            <div class="muted">1. Close Spotify, YouTube, or other media apps, then tap <strong>Re-link Band</strong>.</div>
            <div class="muted">2. Confirm <strong>Mi Fitness</strong> has Android Notification Access enabled and Chrome notifications are allowed.</div>
            <div class="muted">3. Check Band Music Controls shows PadelScore before locking your phone.</div>
          </div>

          <button class="btn btn-primary" data-action="close-guide">Got it</button>
        </div>
      </section>
    </div>
  `;
}

function formatPartialScoreLine(s) {
  const isManual = s.status === 'FINISHED_MANUAL';
  const hasPartial =
    isManual &&
    (s.games[0] > 0 || s.games[1] > 0 || s.points[0] > 0 || s.points[1] > 0 || s.inTieBreak);
  if (!hasPartial) return '';
  return `Stopped at Games ${s.games[0]}-${s.games[1]}${s.inTieBreak ? ' (Tie-break)' : ''}, Points ${s.pointsLabel[0]}-${s.pointsLabel[1]}`;
}

function renderPointShareBlock(counts) {
  const share = computePointShare(counts);
  const ueLostText = formatUePercent(share.uePctOfLost);

  return `
    <div class="controls-stack">
      <div class="strip-row">
        <span class="section-label">Point breakdown (${share.totalPoints} played)</span>
        <span class="ue-label-text">My UEs: ${escapeHtml(ueLostText)} of ${share.pointsLost} lost</span>
      </div>
      ${
        share.totalPoints > 0
          ? `<div class="share-bar" aria-hidden="true">
               <div class="share-seg-us" style="width:${share.usPct}%"></div>
               <div class="share-seg-them" style="width:${share.themOtherPct}%"></div>
               <div class="share-seg-ue" style="width:${share.myUePct}%"></div>
             </div>`
          : ''
      }
      <div class="share-inline">
        <div class="share-metric">
          <span class="section-label">US points</span>
          <span class="share-metric-val">${share.usPoints}</span>
        </div>
        <div class="share-metric">
          <span class="section-label">Other THEM</span>
          <span class="share-metric-val">${share.themOtherPoints}</span>
        </div>
        <div class="share-metric">
          <span class="section-label">My UEs</span>
          <span class="share-metric-val ue-label-text">${share.myUePoints}</span>
        </div>
      </div>
    </div>
  `;
}

function renderAnalyticsPanel(analytics, scoringMode, exportSource, exportMatchId = null) {
  const matchIdAttr = exportMatchId ? ` data-match-id="${escapeHtml(exportMatchId)}"` : '';

  if (!analytics) {
    return `
      <div class="analytics-section" data-testid="analytics-panel">
        <div class="muted">Detailed analytics unavailable (—).</div>
        <div class="controls-row">
          <button class="btn" data-action="export-match" data-source="${escapeHtml(exportSource)}"${matchIdAttr} data-format="csv">Download CSV</button>
          <button class="btn" data-action="export-match" data-source="${escapeHtml(exportSource)}"${matchIdAttr} data-format="json">Download JSON</button>
        </div>
      </div>
    `;
  }

  const { clutch, serveReturn, serviceHold, clusters, windows15m, unbucketedCount } = analytics;
  const holdText =
    serviceHold.completedOrdinaryServiceGames > 0
      ? `${serviceHold.ordinaryServiceGamesWon}/${serviceHold.completedOrdinaryServiceGames} (${formatUePercent(serviceHold.holdRate)})`
      : '—';

  const showGoldenRow = scoringMode === 'GP' || clutch.byLabel.goldenPoint.totalPoints > 0;

  const clusterRows =
    clusters.length === 0
      ? '<div class="muted">No UE clusters (2+ unforced errors within 3 consecutive points).</div>'
      : clusters
          .map(
            (c, idx) =>
              `<div class="cluster-item"><strong>Cluster ${idx + 1}:</strong> ${c.ueCount} My UEs across points #${c.startPointNumber}–#${c.endPointNumber} (Set ${c.setNumber} · ${escapeHtml(c.startScoreText)})</div>`
          )
          .join('');

  const windowRows =
    windows15m.length === 0
      ? '<div class="muted">No timed rallies recorded.</div>'
      : `<table class="analytics-table">
           <thead>
             <tr>
               <th>Elapsed</th>
               <th>My UEs</th>
               <th>Lost</th>
               <th>Pts</th>
               <th>UE %</th>
             </tr>
           </thead>
           <tbody>
             ${windows15m
               .map(
                 (w) => `<tr>
                   <td>${escapeHtml(w.label)}</td>
                   <td>${w.myUePoints}</td>
                   <td>${w.pointsLost}</td>
                   <td>${w.totalPoints}</td>
                   <td>${escapeHtml(formatUePercent(w.uePctOfPointsLost))}</td>
                 </tr>`
               )
               .join('')}
           </tbody>
         </table>`;

  return `
    <div class="analytics-section" data-testid="analytics-panel">
      <div class="tape-block">
        <span class="section-label">Match Rally Tape</span>
        ${renderMatchTapeSvg(analytics)}
        <div class="tape-legend">
          <span class="legend-item"><span class="legend-swatch legend-us"></span>Above: US</span>
          <span class="legend-item"><span class="legend-swatch legend-them"></span>Below: Other THEM</span>
          <span class="legend-item"><span class="legend-swatch legend-ue"></span>Diamond spike: My UE</span>
        </div>
      </div>

      <div class="insight-list">
        <div class="insight-row">
          <span class="section-label">Clutch My UEs</span>
          <span class="insight-val">${clutch.clutchUeTotal}</span>
          <span class="muted">${escapeHtml(formatUePercent(clutch.clutchUePctOfPointsLost))} of ${clutch.clutchPointsLost} lost</span>
        </div>
        <div class="insight-row">
          <span class="section-label">Service Hold</span>
          <span class="insight-val insight-val-compact">${escapeHtml(holdText)}</span>
          <span class="muted">Completed non-TB games</span>
        </div>
        <div class="insight-row">
          <span class="section-label">Serving My UEs</span>
          <span class="insight-val">${serveReturn.serving.myUePoints}</span>
          <span class="muted">${escapeHtml(formatUePercent(serveReturn.serving.uePctOfPointsLost))} of ${serveReturn.serving.pointsLost} lost</span>
        </div>
        <div class="insight-row">
          <span class="section-label">Returning My UEs</span>
          <span class="insight-val">${serveReturn.returning.myUePoints}</span>
          <span class="muted">${escapeHtml(formatUePercent(serveReturn.returning.uePctOfPointsLost))} of ${serveReturn.returning.pointsLost} lost</span>
        </div>
      </div>

      <table class="analytics-table">
        <thead>
          <tr>
            <th>Pressure Moment</th>
            <th>My UEs</th>
            <th>Lost</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${
            showGoldenRow
              ? `<tr>
                   <td>Golden Point (40-40)</td>
                   <td>${clutch.byLabel.goldenPoint.myUePoints}</td>
                   <td>${clutch.byLabel.goldenPoint.pointsLost}</td>
                   <td>${clutch.byLabel.goldenPoint.totalPoints}</td>
                 </tr>`
              : ''
          }
          <tr>
            <td>Break Point</td>
            <td>${clutch.byLabel.breakPoint.myUePoints}</td>
            <td>${clutch.byLabel.breakPoint.pointsLost}</td>
            <td>${clutch.byLabel.breakPoint.totalPoints}</td>
          </tr>
          <tr>
            <td>Set Point</td>
            <td>${clutch.byLabel.setPoint.myUePoints}</td>
            <td>${clutch.byLabel.setPoint.pointsLost}</td>
            <td>${clutch.byLabel.setPoint.totalPoints}</td>
          </tr>
          <tr>
            <td>Tie-Break</td>
            <td>${clutch.byLabel.tieBreak.myUePoints}</td>
            <td>${clutch.byLabel.tieBreak.pointsLost}</td>
            <td>${clutch.byLabel.tieBreak.totalPoints}</td>
          </tr>
        </tbody>
      </table>

      <div class="setup-group">
        <span class="section-label">UE Clusters (${clusters.length})</span>
        <div class="controls-stack">${clusterRows}</div>
      </div>

      <details class="advanced-details">
        <summary>
          <span>15-Minute Elapsed Windows</span>
          <span aria-hidden="true">▾</span>
        </summary>
        <div class="advanced-content">
          ${windowRows}
          ${
            unbucketedCount > 0
              ? `<div class="muted">${unbucketedCount} rally(s) excluded due to invalid timestamp.</div>`
              : ''
          }
        </div>
      </details>

      <div class="controls-row">
        <button class="btn" data-action="export-match" data-source="${escapeHtml(exportSource)}"${matchIdAttr} data-format="csv">Download CSV</button>
        <button class="btn" data-action="export-match" data-source="${escapeHtml(exportSource)}"${matchIdAttr} data-format="json">Download JSON</button>
      </div>
    </div>
  `;
}

function renderMatchOverScreen(vm, swState) {
  const s = vm.state;
  const isManual = s.status === 'FINISHED_MANUAL';
  const isWin = !isManual && s.winner === 0;
  const headline = isManual ? 'Match Ended Early' : isWin ? 'US Won' : 'THEM Won';
  const partialLine = formatPartialScoreLine(s);

  return `
    <section class="court-section" data-screen="MATCH_OVER">
      <div class="verdict-head">
        <div class="strip-row">
          <span class="section-label">${isManual ? 'Ended early' : 'Final'} · ${escapeHtml(s.scoringMode)}</span>
          <span class="muted">${escapeHtml(vm.durationText)} · #${s.revision}</span>
        </div>
        <div class="verdict-title ${isWin ? 'verdict-win' : ''}">${escapeHtml(headline)}</div>
        <div class="verdict-sets">
          Sets ${s.sets[0]}-${s.sets[1]}${vm.setLines.length ? ` · ${escapeHtml(vm.setLines.join('  '))}` : ''}
        </div>
        ${partialLine ? `<div class="muted">${escapeHtml(partialLine)}</div>` : ''}
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

      ${renderPointShareBlock(s.counts)}

      <div class="controls-stack">
        ${
          !isManual && vm.canUndo
            ? `<button class="btn btn-row-label" data-action="undo"><span aria-hidden="true">↺</span><span>Undo last point</span></button>`
            : ''
        }
        ${
          isManual && vm.canResume
            ? `<button class="btn btn-primary" data-action="resume">Resume match</button>`
            : ''
        }
        ${
          vm.isWriter
            ? `<button class="btn ${isManual ? '' : 'btn-primary'}" data-action="new-match">New Match</button>`
            : ''
        }
      </div>

      ${renderAnalyticsPanel(vm.matchOverAnalytics, s.scoringMode, 'current')}
      <div data-sw-update-slot>${renderSwUpdateStrip(swState)}</div>
    </section>
  `;
}

function renderHistoryScreen(vm, swState) {
  const h = vm.history;
  const backLabel =
    vm.baseScreen === 'LIVE'
      ? 'Back to Match'
      : vm.baseScreen === 'MATCH_OVER'
        ? 'Back to Result'
        : 'Back';

  const statusNote =
    h.status === 'CORRUPT' || h.status === 'READ_ERROR'
      ? `<div class="strip strip-err">History storage is unreadable (${escapeHtml(h.status)}). Stored data was left intact.</div>`
      : h.corruptCount > 0
        ? `<div class="strip strip-warn">${h.corruptCount} unreadable history row(s) detected. Valid matches stay viewable and exportable; history edits are paused to preserve stored data.</div>`
        : '';

  const rows =
    h.items.length === 0
      ? '<div class="muted">No archived matches yet. Finished matches appear here automatically.</div>'
      : h.items
          .map((item) => {
            const isManual = item.status === 'FINISHED_MANUAL';
            const isWin = !isManual && item.winner === 0;
            const badge = isManual ? 'Ended early' : isWin ? 'US Won' : 'THEM Won';
            const rowCls = isManual
              ? 'history-item'
              : isWin
                ? 'history-item history-item-win'
                : 'history-item history-item-loss';
            const confirmOpen = h.confirmDeleteMatchId === item.matchId;

            return `
              <div class="${rowCls}" data-history-id="${escapeHtml(item.matchId)}">
                <div class="strip-row">
                  <strong>${badge} · ${escapeHtml(item.setsText)} (${escapeHtml(item.scoringMode)})</strong>
                  <span class="muted">${escapeHtml(item.durationText)}</span>
                </div>
                <div class="muted">
                  ${escapeHtml(item.dateText)} · <span class="ue-label-text">My UEs: ${item.myUePoints} (${escapeHtml(item.uePctText)})</span>
                  ${item.setLines.length ? ` · ${escapeHtml(item.setLines.join(', '))}` : ''}
                </div>
                ${
                  confirmOpen
                    ? `<div class="confirm-box">
                         <div><strong>Delete this match from history?</strong> Export first if you want a copy.</div>
                         <div class="controls-row">
                           <button class="btn" data-action="cancel-delete-history">Cancel</button>
                           <button class="btn btn-danger" data-action="confirm-delete-history" data-match-id="${escapeHtml(item.matchId)}">Confirm Delete</button>
                         </div>
                       </div>`
                    : `<div class="controls-row">
                         <button class="btn btn-primary" data-action="inspect-history" data-match-id="${escapeHtml(item.matchId)}">Inspect</button>
                         ${
                           item.canDelete
                             ? `<button class="btn btn-danger" data-action="open-delete-history" data-match-id="${escapeHtml(item.matchId)}">Delete</button>`
                             : `<button class="btn" disabled>${item.isCurrentlyOpenActive ? 'Open on Result' : 'Viewing Only'}</button>`
                         }
                       </div>`
                }
              </div>
            `;
          })
          .join('');

  return `
    <section class="court-section" data-screen="HISTORY">
      <div class="strip-row">
        <h1>Match History (${h.count})</h1>
        <button class="btn btn-inline" data-action="close-history">${escapeHtml(backLabel)}</button>
      </div>
      ${h.error ? `<div class="strip strip-err">${escapeHtml(h.error)}</div>` : ''}
      ${statusNote}
      <div class="controls-stack">${rows}</div>
      <div data-sw-update-slot>${vm.baseScreen !== 'LIVE' ? renderSwUpdateStrip(swState) : ''}</div>
    </section>
  `;
}

function renderHistoryDetailScreen(vm, swState) {
  const h = vm.history;
  const rec = h.inspectedRecord;
  const ana = h.inspectedAnalytics;
  if (!rec || !ana) {
    return renderHistoryScreen(vm, swState);
  }
  const s = ana.summary;
  const isManual = s.status === 'FINISHED_MANUAL';
  const isWin = !isManual && s.winner === 0;
  const headline = isManual ? 'Ended Early' : isWin ? 'US Won' : 'THEM Won';
  const setLines = s.setHistory.map(formatSetLine);
  const partialLine = formatPartialScoreLine(s);
  const confirmOpen = h.confirmDeleteMatchId === rec.matchId;

  return `
    <section class="court-section" data-screen="HISTORY_DETAIL">
      <div class="strip-row">
        <button class="btn btn-inline" data-action="back-history-list">← All Matches</button>
        <button class="btn btn-inline" data-action="close-history">${vm.baseScreen === 'LIVE' ? 'Back to Match' : 'Close'}</button>
      </div>
      ${h.error ? `<div class="strip strip-err" role="alert">${escapeHtml(h.error)}</div>` : ''}

      <div class="verdict-head">
        <div class="strip-row">
          <span class="section-label">${escapeHtml(h.inspectedDateText)} · ${escapeHtml(s.scoringMode)}</span>
          <span class="muted">${escapeHtml(formatDuration(s.durationSec))} · #${s.revision}</span>
        </div>
        <div class="verdict-title ${isWin ? 'verdict-win' : ''}">${escapeHtml(headline)}</div>
        <div class="verdict-sets">
          Sets ${s.sets[0]}-${s.sets[1]}${setLines.length ? ` · ${escapeHtml(setLines.join('  '))}` : ''}
        </div>
        ${partialLine ? `<div class="muted">${escapeHtml(partialLine)}</div>` : ''}
      </div>

      ${renderPointShareBlock(s.counts)}
      ${renderAnalyticsPanel(ana, s.scoringMode, 'history', rec.matchId)}

      ${
        h.inspectedCanDelete
          ? confirmOpen
            ? `<div class="confirm-box">
                 <div><strong>Delete this match from history?</strong> Export first if you want a copy.</div>
                 <div class="controls-row">
                   <button class="btn" data-action="cancel-delete-history">Cancel</button>
                   <button class="btn btn-danger" data-action="confirm-delete-history" data-match-id="${escapeHtml(rec.matchId)}">Confirm Delete</button>
                 </div>
               </div>`
            : `<button class="btn btn-danger" data-action="open-delete-history" data-match-id="${escapeHtml(rec.matchId)}">Delete from History</button>`
          : h.inspectedIsOpenActive
            ? `<div class="muted">Currently open on Match Over — start a New Match before deleting from history.</div>`
            : ''
      }
      <div data-sw-update-slot>${vm.baseScreen !== 'LIVE' ? renderSwUpdateStrip(swState) : ''}</div>
    </section>
  `;
}

function renderCorruptScreen(vm) {
  return `
    <section class="court-section" data-screen="CORRUPT">
      <h1>Saved Match Needs Recovery</h1>
      <div class="strip strip-err">
        Saved match data failed validation and was <strong>not</strong> overwritten.
        <div class="muted">${escapeHtml(vm.corruptError || 'Invalid JSON')}</div>
      </div>
      <label class="muted" for="corrupt-raw-text">Raw saved payload (copy before clearing):</label>
      <textarea id="corrupt-raw-text" class="raw-box" readonly>${escapeHtml(vm.corruptRaw || '')}</textarea>
      <div class="controls-stack">
        <button class="btn" data-action="copy-corrupt">Copy Raw Data</button>
        ${
          vm.isWriter
            ? vm.ui.confirmClearCorruptOpen
              ? `<div class="confirm-box">
                   <div><strong>Permanently clear corrupt record?</strong> Copy the raw payload first if needed.</div>
                   <div class="controls-row">
                     <button class="btn" data-action="cancel-clear-corrupt">Cancel</button>
                     <button class="btn btn-danger" data-action="confirm-clear-corrupt">Confirm Clear</button>
                   </div>
                 </div>`
              : `<button class="btn btn-danger" data-action="open-clear-corrupt">Clear &amp; Start Fresh</button>`
            : `<div class="muted">Tap Take over above to clear corrupt storage.</div>`
        }
      </div>
    </section>
  `;
}

function renderReadErrorScreen(vm) {
  return `
    <section class="court-section" data-screen="READ_ERROR">
      <h1>Storage Read Error</h1>
      <div class="strip strip-err">
        Could not read saved match from browser storage.
        <div class="muted">${escapeHtml(vm.storageReadError || 'Unknown storage error')}</div>
      </div>
      ${
        vm.isWriter
          ? `<button class="btn btn-primary" data-action="retry-read">Retry Read</button>`
          : `<button class="btn btn-primary" data-action="takeover-writer">Take over</button>`
      }
    </section>
  `;
}

function renderLoadingScreen() {
  return `
    <section class="court-section" data-screen="LOADING">
      <h1>Loading Match…</h1>
      <div class="muted">Checking saved score and match control lock.</div>
    </section>
  `;
}

function captureFocusDescriptor(container) {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;

  if (active.tagName === 'INPUT' && active.type === 'radio') {
    return {
      kind: 'radio',
      name: active.name,
      value: active.value,
    };
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
    };
  }
  return null;
}

function restoreFocusDescriptor(container, desc) {
  if (!desc) return;
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
      (desc.format === null || ds.format === desc.format)
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
      'button:not([disabled]), summary, textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => {
    if (isInsideClosedDetails(el, sheetEl)) return false;
    return el.offsetParent !== null || el === document.activeElement;
  });
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
  let prevMenuOpen = false;
  let prevGuideOpen = false;
  let lastOpenerAction = null;
  let lastChromeHtml = '';
  let lastGuideHtml = '';

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

  function clearActiveUpdateAttempt() {
    updateAttemptId += 1;
    if (typeof updateAttemptCleanup === 'function') {
      const fn = updateAttemptCleanup;
      updateAttemptCleanup = null;
      fn();
    }
  }

  function patchSwUpdateSlots(vm = controller.getViewModel()) {
    // Patch dedicated update slots in place so open <details>, scroll, and focus never reset
    const screenSlot = screenEl.querySelector('[data-sw-update-slot]');
    if (screenSlot) {
      const nextHtml =
        vm.baseScreen !== 'LIVE' && isSafeUpdateScreen(vm.screen)
          ? renderSwUpdateStrip(swState)
          : '';
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

    // If the worker we requested became redundant or disappeared while applying, release lock & allow retry
    if (swState.applying && requestedUpdateWorker && requestedUpdateWorker !== waiting) {
      clearActiveUpdateAttempt();
      requestedUpdateWorker = null;
      swState.applying = false;
      swState.notice = hasWaiting
        ? 'A newer update arrived. Tap Update now to retry.'
        : null;
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

  function render(vm) {
    const showHistoryBtn =
      vm.screen !== 'LOADING' && vm.screen !== 'HISTORY' && vm.screen !== 'HISTORY_DETAIL';
    const isBandHealthyLive =
      vm.isWriter && vm.screen === 'LIVE' && vm.wrist.status === 'ARMED';

    const nextChromeHtml = `
      <header class="topbar">
        <div class="brand">
          <span class="brand-ball" aria-hidden="true"></span>
          <span>PadelScore</span>
        </div>
        <div class="topbar-actions">
          ${
            isBandHealthyLive
              ? `<button class="nav-btn nav-btn-ready" data-action="toggle-guide" aria-label="Band controls ready. Open Band guide"><span class="status-dot" aria-hidden="true"></span><span>Band ready</span></button>`
              : vm.screen !== 'LOADING'
                ? `<button class="nav-btn" data-action="toggle-guide" aria-label="Band quick guide">? Guide</button>`
                : ''
          }
          ${
            showHistoryBtn
              ? `<button class="nav-btn" data-action="open-history">History (${vm.history.count})</button>`
              : ''
          }
        </div>
      </header>
      ${renderReadOnlyBanner(vm)}
      ${renderWristRecoveryBanner(vm)}
      ${renderErrorBanners(vm)}
      ${copyFeedback ? `<div class="strip strip-ok">${escapeHtml(copyFeedback)}</div>` : ''}
    `;

    if (nextChromeHtml !== lastChromeHtml) {
      const chromeFocus = captureFocusDescriptor(chromeEl);
      chromeEl.innerHTML = nextChromeHtml;
      lastChromeHtml = nextChromeHtml;
      restoreFocusDescriptor(chromeEl, chromeFocus);
    }

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
      const screenFocus = captureFocusDescriptor(screenEl);
      let body = '';
      if (vm.screen === 'LOADING') body = renderLoadingScreen();
      else if (vm.screen === 'READ_ERROR') body = renderReadErrorScreen(vm);
      else if (vm.screen === 'CORRUPT') body = renderCorruptScreen(vm);
      else if (vm.screen === 'HISTORY') body = renderHistoryScreen(vm, swState);
      else if (vm.screen === 'HISTORY_DETAIL') body = renderHistoryDetailScreen(vm, swState);
      else if (vm.screen === 'SETUP') body = renderSetupScreen(vm, swState);
      else if (vm.screen === 'LIVE') body = renderLiveScreen(vm);
      else body = renderMatchOverScreen(vm, swState);

      screenEl.innerHTML = body;
      restoreFocusDescriptor(screenEl, screenFocus);
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
      if (lastOpenerAction) {
        shellEl.querySelector(`button[data-action="${lastOpenerAction}"]:not([disabled])`)?.focus();
      }
    }
    prevMenuOpen = menuNow;
    prevGuideOpen = guideNow;
  }

  function triggerDownload(source, matchId, format) {
    const res = controller.getExportData({ source, matchId }, format);
    if (!res.ok) {
      copyFeedback = `Export failed: ${res.error?.message || 'Unable to generate file'}`;
      render(controller.getViewModel());
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
      copyFeedback = `Download failed on this browser.`;
    }
    render(controller.getViewModel());
  }

  async function copyText(text, label) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        copyFeedback = `Copied ${label}.`;
      } else {
        copyFeedback = `Clipboard unavailable — select text manually.`;
      }
    } catch {
      copyFeedback = `Copy failed — select text manually.`;
    }
    render(controller.getViewModel());
  }

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
      controller.retryArchiveCurrentMatch();
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
    } else if (action === 'cancel-delete-history') {
      controller.setConfirmDeleteMatchId(null);
    } else if (action === 'confirm-delete-history') {
      controller.deleteHistoryMatch(btn.dataset.matchId);
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
      controller.setMenuOpen(false);
      controller.relinkWrist();
    } else if (action === 'toggle-menu') {
      const vm = controller.getViewModel();
      if (!vm.ui.menuOpen) lastOpenerAction = 'toggle-menu';
      controller.setMenuOpen(!vm.ui.menuOpen);
    } else if (action === 'close-menu') {
      controller.setMenuOpen(false);
    } else if (action === 'toggle-guide') {
      const vm = controller.getViewModel();
      if (!vm.ui.guideOpen) lastOpenerAction = 'toggle-guide';
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
    // Throttled update check on foreground return for long-lived open tabs
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
