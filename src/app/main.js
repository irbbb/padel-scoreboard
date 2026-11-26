import { createKeepAliveAudioBlobUrl } from './wavGenerator.js';
import {
  createAppController,
  createGuardedStorage,
  formatDiagTime,
} from './appController.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderWristBanner(vm) {
  if (!vm.isWriter || vm.screen !== 'LIVE') return '';

  const status = vm.wrist.status;
  let cls = 'banner banner-warn';
  let label = 'Wrist Disarmed — tap Re-link Wrist';
  if (status === 'ARMED') {
    cls = 'banner banner-ok';
    label = 'Wrist Armed (Band 9 Active ready)';
  } else if (status === 'INTERRUPTED') {
    cls = 'banner banner-err';
    label = 'Wrist Interrupted — tap Re-link Wrist';
  } else if (status === 'UNAVAILABLE') {
    cls = 'banner';
    label = 'Wrist MediaSession unavailable in this browser';
  }

  return `
    <div class="${cls}" data-testid="wrist-banner">
      <div class="banner-row">
        <strong>${escapeHtml(label)}</strong>
        ${
          vm.wrist.supported
            ? `<button class="btn btn-sm btn-primary" data-action="relink-wrist">Re-link Wrist</button>`
            : ''
        }
      </div>
      ${
        vm.wrist.lastLinkError
          ? `<div class="muted">Link error: ${escapeHtml(vm.wrist.lastLinkError)}</div>`
          : ''
      }
    </div>
  `;
}

function renderReadOnlyBanner(vm) {
  if (vm.isWriter || vm.screen === 'LOADING') return '';
  return `
    <div class="banner banner-warn" data-testid="readonly-banner">
      <div class="banner-row">
        <strong>READ-ONLY MODE</strong>
        <button class="btn btn-sm" data-action="takeover-writer">Take Over Writer</button>
      </div>
      <div>${escapeHtml(vm.readOnlyReason)}</div>
      ${vm.takeoverNotice ? `<div class="muted">${escapeHtml(vm.takeoverNotice)}</div>` : ''}
    </div>
  `;
}

function renderErrorBanners(vm) {
  const errors = [];
  if (vm.lastSaveError) errors.push(`Save failed (previous score preserved): ${vm.lastSaveError}`);
  if (vm.lastPublishError) {
    if (vm.screen === 'LIVE') {
      errors.push(`Wrist publish failed (score saved — tap Re-link Wrist): ${vm.lastPublishError}`);
    } else {
      errors.push(`Final score was saved, but the band display failed to update: ${vm.lastPublishError}`);
    }
  }
  if (vm.actionError) errors.push(vm.actionError);
  if (errors.length === 0) return '';

  return errors
    .map((msg) => `<div class="banner banner-err" role="alert">${escapeHtml(msg)}</div>`)
    .join('');
}

function renderSetupScreen(vm) {
  const adSel = vm.setupScoringMode === 'AD' ? 'btn-selected' : '';
  const gpSel = vm.setupScoringMode === 'GP' ? 'btn-selected' : '';
  const watchSel = vm.setupInitialServer === null ? 'btn-selected' : '';
  const usSel = vm.setupInitialServer === 0 ? 'btn-selected' : '';
  const themSel = vm.setupInitialServer === 1 ? 'btn-selected' : '';
  const disabled = vm.isWriter ? '' : 'disabled';

  return `
    <section class="card" data-screen="SETUP">
      <h1>${vm.isReplacementSetup ? 'New Match' : 'Start Padel Match'}</h1>
      <div class="muted">
        Format: <strong>Best of 3 Sets · 6-6 Tie-break (to 7 by 2)</strong>
      </div>
      <div>
        <div class="muted" style="margin-bottom:8px;"><strong>Scoring at 40-40</strong></div>
        <div class="controls-row">
          <button class="btn ${adSel}" data-action="set-scoring-mode" data-mode="AD" ${disabled}>Advantage (AD)</button>
          <button class="btn ${gpSel}" data-action="set-scoring-mode" data-mode="GP" ${disabled}>Golden Point (GP)</button>
        </div>
      </div>
      <div>
        <div class="muted" style="margin-bottom:8px;"><strong>Who serves first?</strong></div>
        <div class="controls-stack">
          <button class="btn ${watchSel}" data-action="set-server" data-team="watch" ${disabled}>Pick on watch (after warmup point)</button>
          <div class="controls-row">
            <button class="btn ${usSel}" data-action="set-server" data-team="0" ${disabled}>US Serve</button>
            <button class="btn ${themSel}" data-action="set-server" data-team="1" ${disabled}>THEM Serve</button>
          </div>
        </div>
      </div>
      <div class="controls-stack">
        <button class="btn btn-primary" data-action="start-match" ${disabled}>
          Start Match &amp; Link Wrist
        </button>
        ${
          vm.isReplacementSetup
            ? `<button class="btn" data-action="cancel-replacement">Back to Match Over</button>`
            : ''
        }
      </div>
    </section>
  `;
}

function renderMenuPanel(vm) {
  if (!vm.ui.menuOpen || !vm.isWriter) return '';
  const rawOpener = vm.record?.config?.initialServer;
  const hasOpener = rawOpener === 0 || rawOpener === 1;
  const altOpener = rawOpener === 0 ? 1 : 0;
  const curLabel = rawOpener === 0 ? 'US' : 'THEM';
  const altLabel = altOpener === 0 ? 'US' : 'THEM';

  const diagRows =
    vm.diagEntries.length === 0
      ? '<div class="muted">No diagnostic entries yet.</div>'
      : vm.diagEntries
          .map(
            (e) =>
              `<div>${escapeHtml(formatDiagTime(e.t))} · ${escapeHtml(e.action)} · ${escapeHtml(e.audioState)}${
                e.revision !== null ? ` · #${e.revision}` : ''
              }${e.detail ? ` · ${escapeHtml(e.detail)}` : ''}</div>`
          )
          .join('');

  return `
    <section class="card" data-testid="menu-panel">
      <div class="banner-row">
        <h3>Match Menu</h3>
        <button class="btn btn-sm" data-action="close-menu">Close</button>
      </div>

      ${
        hasOpener
          ? vm.ui.confirmOpenerOpen
            ? `<div class="confirm-box">
                 <div>Switch first serving team from <strong>${curLabel}</strong> to <strong>${altLabel}</strong>? Scores, timestamps, and UE totals stay intact.</div>
                 <div class="controls-row">
                   <button class="btn btn-sm" data-action="cancel-opener">Cancel</button>
                   <button class="btn btn-sm btn-primary" data-action="confirm-opener" data-team="${altOpener}">Switch to ${altLabel}</button>
                 </div>
               </div>`
            : `<button class="btn" data-action="open-opener">Correct first serving team (currently ${curLabel})</button>`
          : ''
      }

      ${
        vm.ui.confirmFinishOpen
          ? `<div class="confirm-box">
               <div><strong>Finish match now?</strong> Saves partial score and disarms wrist controls. You can still Resume later.</div>
               <div class="controls-row">
                 <button class="btn btn-sm" data-action="cancel-finish">Cancel</button>
                 <button class="btn btn-sm btn-danger" data-action="confirm-finish">Confirm Finish Now</button>
               </div>
             </div>`
          : `<button class="btn btn-danger" data-action="open-finish">Finish Now</button>`
      }

      <button class="btn btn-sm" data-action="step-down">Release Writer Lock (Read-Only)</button>

      <div>
        <div class="banner-row" style="margin-bottom:6px;">
          <span class="muted"><strong>Diagnostic Log (recent)</strong></span>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm" data-action="copy-diag">Copy</button>
            <button class="btn btn-sm" data-action="clear-diag">Clear</button>
          </div>
        </div>
        <div class="diag-list">${diagRows}</div>
      </div>
    </section>
  `;
}

function renderLiveScreen(vm) {
  const s = vm.state;
  const disabled = vm.isWriter ? '' : 'disabled';
  const undoDisabled = vm.canUndo ? '' : 'disabled';
  const gamesText = s.inTieBreak ? 'TIE-BREAK (6-6)' : `${s.games[0]} - ${s.games[1]}`;
  const awaitingServer = s.status === 'ACTIVE' && s.needsInitialServer;
  const servingLabel = s.server === 0 ? 'US' : s.server === 1 ? 'THEM' : 'Awaiting server';
  const isLoveAllWithServer = !awaitingServer && vm.record && vm.record.events.length === 0;
  const altServer = s.server === 0 ? 1 : 0;
  const altServerLabel = altServer === 0 ? 'US' : 'THEM';

  return `
    <section class="card" data-screen="LIVE">
      <div class="score-header">
        <span>Sets ${s.sets[0]}-${s.sets[1]} · ${escapeHtml(s.scoringMode)} ${vm.setLines.length ? `(${escapeHtml(vm.setLines.join(', '))})` : ''}</span>
        <span><span data-duration-text>${escapeHtml(vm.durationText)}</span> · #${s.revision}</span>
      </div>

      <div class="scoreboard-grid">
        <div class="team-col">
          <div class="team-name">
            ${s.server === 0 ? '<span class="serve-dot" aria-label="Serving"></span>' : ''}
            <span>US</span>
          </div>
          <div class="big-points">${escapeHtml(s.pointsLabel[0])}</div>
        </div>
        <div class="points-sep">-</div>
        <div class="team-col">
          <div class="team-name">
            <span>THEM</span>
            ${s.server === 1 ? '<span class="serve-dot" aria-label="Serving"></span>' : ''}
          </div>
          <div class="big-points">${escapeHtml(s.pointsLabel[1])}</div>
        </div>
      </div>

      <div class="sub-scores">
        <div class="sub-score-item">
          <span class="sub-score-label">Games</span>
          <span>${escapeHtml(gamesText)}</span>
        </div>
        <div class="sub-score-item">
          <span class="sub-score-label">My UEs</span>
          <span>${s.counts.myUePoints} (${escapeHtml(vm.uePctText)})</span>
        </div>
        <div class="sub-score-item">
          <span class="sub-score-label">Serving</span>
          <span>${escapeHtml(servingLabel)}</span>
        </div>
      </div>

      ${
        vm.wristPreview
          ? `<div class="wrist-preview">
               <div class="wrist-preview-label">Band 9 Active Preview</div>
               <div class="wrist-line-title">${escapeHtml(vm.wristPreview.title)}</div>
               <div class="wrist-line-artist">${escapeHtml(vm.wristPreview.artist)}</div>
             </div>`
          : ''
      }

      ${
        awaitingServer
          ? `<div class="confirm-box" data-testid="server-picker">
               <div><strong>Warmup Point — Who serves first?</strong></div>
               <div class="muted">Tap <strong>&lt; (US)</strong> or <strong>&gt; (THEM)</strong> on your Band 9 Active after the 4-touch rally, or pick below.</div>
               <div class="controls-row">
                 <button class="btn btn-us" data-action="pick-initial-server" data-team="0" ${disabled}>US Serves</button>
                 <button class="btn btn-them" data-action="pick-initial-server" data-team="1" ${disabled}>THEM Serves</button>
               </div>
             </div>
             <button class="btn" data-action="toggle-menu" ${disabled}>Menu</button>`
          : `<div class="controls-row">
               <button class="btn btn-us" data-action="score" data-code="A" ${disabled}>US +1</button>
               <button class="btn btn-them" data-action="score" data-code="B" ${disabled}>THEM +1</button>
             </div>

             <button class="btn btn-ue" data-action="score" data-code="E" ${disabled}>
               MY UE (+1 Them · My Error)
             </button>

             ${
               isLoveAllWithServer && vm.isWriter
                 ? `<button class="btn btn-sm" data-action="confirm-opener" data-team="${altServer}">Change First Server (switch to ${altServerLabel})</button>`
                 : ''
             }

             <div class="controls-row">
               <button class="btn" data-action="undo" ${undoDisabled}>Undo</button>
               <button class="btn" data-action="toggle-menu" ${disabled}>Menu</button>
             </div>`
      }
    </section>

    ${renderMenuPanel(vm)}
  `;
}

function renderMatchOverScreen(vm) {
  const s = vm.state;
  const isManual = s.status === 'FINISHED_MANUAL';
  const headline = isManual
    ? 'Match Finished Manually'
    : s.winner === 0
      ? 'Match Won — US'
      : 'Match Won — THEM';
  const hasPartial = isManual && (s.games[0] > 0 || s.games[1] > 0 || s.points[0] > 0 || s.points[1] > 0 || s.inTieBreak);
  const partialLine = hasPartial
    ? `Partial set: Games ${s.games[0]}-${s.games[1]}${s.inTieBreak ? ' (TB)' : ''}, Points ${s.pointsLabel[0]}-${s.pointsLabel[1]}`
    : '';

  return `
    <section class="card" data-screen="MATCH_OVER">
      <div class="score-header">
        <span>${isManual ? 'FINISHED_MANUAL' : 'WON'} · ${escapeHtml(s.scoringMode)}</span>
        <span>${escapeHtml(vm.durationText)} · #${s.revision}</span>
      </div>
      <h1>${escapeHtml(headline)}</h1>
      <div>
        <strong>Sets:</strong> ${s.sets[0]}-${s.sets[1]}
        ${vm.setLines.length ? ` (${escapeHtml(vm.setLines.join(', '))})` : ''}
      </div>
      ${partialLine ? `<div class="muted">${escapeHtml(partialLine)}</div>` : ''}

      <div class="stat-grid">
        <div class="stat-box">
          <span class="sub-score-label">Us Won (A)</span>
          <span class="stat-value">${s.counts.ourPoints}</span>
        </div>
        <div class="stat-box">
          <span class="sub-score-label">Them Other (B)</span>
          <span class="stat-value">${s.counts.themOtherPoints}</span>
        </div>
        <div class="stat-box">
          <span class="sub-score-label">My UEs (E)</span>
          <span class="stat-value">${s.counts.myUePoints}</span>
        </div>
        <div class="stat-box">
          <span class="sub-score-label">My UEs / Pts Lost</span>
          <span class="stat-value">${escapeHtml(vm.uePctText)}</span>
        </div>
      </div>

      <div class="controls-stack">
        ${
          !isManual && vm.canUndo
            ? `<button class="btn" data-action="undo">Undo last point</button>`
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
    </section>
  `;
}

function renderCorruptScreen(vm) {
  return `
    <section class="card" data-screen="CORRUPT">
      <h1>Corrupt Saved Match</h1>
      <div class="banner banner-err">
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
                   <div><strong>Permanently clear corrupt record?</strong> Make sure you copied the raw payload if needed.</div>
                   <div class="controls-row">
                     <button class="btn btn-sm" data-action="cancel-clear-corrupt">Cancel</button>
                     <button class="btn btn-sm btn-danger" data-action="confirm-clear-corrupt">Confirm Clear</button>
                   </div>
                 </div>`
              : `<button class="btn btn-danger" data-action="open-clear-corrupt">Clear &amp; Start Fresh</button>`
            : `<div class="muted">Acquire writer lock to clear corrupt storage.</div>`
        }
      </div>
    </section>
  `;
}

function renderReadErrorScreen(vm) {
  return `
    <section class="card" data-screen="READ_ERROR">
      <h1>Storage Read Error</h1>
      <div class="banner banner-err">
        Could not read saved match from localStorage.
        <div class="muted">${escapeHtml(vm.storageReadError || 'Unknown storage error')}</div>
      </div>
      ${
        vm.isWriter
          ? `<button class="btn btn-primary" data-action="retry-read">Retry Read</button>`
          : `<button class="btn" data-action="takeover-writer">Take Over Writer</button>`
      }
    </section>
  `;
}

function renderLoadingScreen() {
  return `
    <section class="card" data-screen="LOADING">
      <h1>Loading Match…</h1>
      <div class="muted">Acquiring writer lock and checking saved state.</div>
    </section>
  `;
}

function boot() {
  const root = document.getElementById('app');
  if (!root) return;

  const wavUrl = createKeepAliveAudioBlobUrl();
  let copyFeedback = '';

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
      // Update duration text in place so active score buttons & focus are never replaced mid-press
      const durationEl = root.querySelector('[data-duration-text]');
      if (durationEl && durationText !== null) {
        durationEl.textContent = durationText;
      }
    },
  });

  function render(vm) {
    let body = '';
    if (vm.screen === 'LOADING') body = renderLoadingScreen();
    else if (vm.screen === 'READ_ERROR') body = renderReadErrorScreen(vm);
    else if (vm.screen === 'CORRUPT') body = renderCorruptScreen(vm);
    else if (vm.screen === 'SETUP') body = renderSetupScreen(vm);
    else if (vm.screen === 'LIVE') body = renderLiveScreen(vm);
    else body = renderMatchOverScreen(vm);

    root.innerHTML = `
      <header class="topbar">
        <div class="brand">PadelScore</div>
        <div class="pill">${vm.isWriter ? 'WRITER' : 'READ-ONLY'} · ${escapeHtml(vm.screen)}</div>
      </header>
      ${renderReadOnlyBanner(vm)}
      ${renderWristBanner(vm)}
      ${renderErrorBanners(vm)}
      ${copyFeedback ? `<div class="banner banner-ok">${escapeHtml(copyFeedback)}</div>` : ''}
      ${body}
    `;
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

  root.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    copyFeedback = '';
    const action = btn.dataset.action;

    if (action === 'set-scoring-mode') {
      controller.setSetupScoringMode(btn.dataset.mode);
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
    } else if (action === 'cancel-replacement') {
      controller.cancelReplacementSetup();
    } else if (action === 'score') {
      controller.scorePoint(btn.dataset.code);
    } else if (action === 'undo') {
      controller.undo();
    } else if (action === 'relink-wrist') {
      controller.relinkWrist();
    } else if (action === 'toggle-menu') {
      const vm = controller.getViewModel();
      controller.setMenuOpen(!vm.ui.menuOpen);
    } else if (action === 'close-menu') {
      controller.setMenuOpen(false);
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

  // Cross-tab read-only refresh on match key OR full storage clear (key === null)
  window.addEventListener('storage', (e) => {
    controller.handleStorageEvent(e.key);
  });

  // Screen lock keeps bridge ARMED; return refreshes displayed durationSec
  document.addEventListener('visibilitychange', () => {
    controller.handleVisibilityChange(document.visibilityState);
  });

  // Idempotent teardown on pagehide / Page Lifecycle freeze
  window.addEventListener('pagehide', () => {
    controller.handlePageHideOrFreeze('pagehide');
  });
  document.addEventListener('freeze', () => {
    controller.handlePageHideOrFreeze('freeze');
  });

  // BFCache restore / unfreeze: recheck lock & reread storage, starting disarmed
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      controller.handlePageShowOrResume();
    }
  });
  document.addEventListener('resume', () => {
    controller.handlePageShowOrResume();
  });

  // Live durationSec tick while visible (zero commits, zero revision bumps, zero wrist publishes)
  window.setInterval(() => {
    if (document.visibilityState === 'visible') {
      controller.tickDisplay();
    }
  }, 1000);

  controller.init();

  // Register offline Service Worker without forcing mid-match reloads
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }
}

boot();
