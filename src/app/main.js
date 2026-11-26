import { createKeepAliveAudioBlobUrl } from './wavGenerator.js';
import {
  createAppController,
  createGuardedStorage,
  formatDiagTime,
  formatDuration,
  formatSetLine,
  formatUePercent,
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
          vm.archiveBlockedDraft
            ? `<div class="confirm-box" data-testid="archive-blocked-box">
                 <div><strong>Previous match could not be archived to history.</strong> Export or retry saving before discarding it.</div>
                 <div class="controls-row">
                   <button class="btn btn-sm btn-primary" data-action="retry-archive">Retry Save to History</button>
                   <button class="btn btn-sm" data-action="export-match" data-source="current" data-format="json">Download JSON</button>
                 </div>
                 <button class="btn btn-sm" data-action="export-match" data-source="current" data-format="csv">Download CSV</button>
                 <button class="btn btn-sm btn-danger" data-action="start-match-discard">Start New Match &amp; Discard Copy</button>
               </div>`
            : ''
        }
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

function formatPartialScoreLine(s) {
  const isManual = s.status === 'FINISHED_MANUAL';
  const hasPartial =
    isManual &&
    (s.games[0] > 0 || s.games[1] > 0 || s.points[0] > 0 || s.points[1] > 0 || s.inTieBreak);
  if (!hasPartial) return '';
  return `Partial set: Games ${s.games[0]}-${s.games[1]}${s.inTieBreak ? ' (TB)' : ''}, Points ${s.pointsLabel[0]}-${s.pointsLabel[1]}`;
}

function renderAnalyticsPanel(analytics, exportSource, exportMatchId = null) {
  if (!analytics) return '';
  const { clutch, serveReturn, serviceHold, clusters, windows15m, unbucketedCount } = analytics;
  const holdText =
    serviceHold.completedOrdinaryServiceGames > 0
      ? `${serviceHold.ordinaryServiceGamesWon}/${serviceHold.completedOrdinaryServiceGames} (${formatUePercent(serviceHold.holdRate)})`
      : '—';
  const matchIdAttr = exportMatchId ? ` data-match-id="${escapeHtml(exportMatchId)}"` : '';

  const clusterRows =
    clusters.length === 0
      ? '<div class="muted">No UE clusters (2+ UEs within 3 consecutive points).</div>'
      : clusters
          .map(
            (c, idx) =>
              `<div class="cluster-item"><strong>Cluster ${idx + 1}:</strong> ${c.ueCount} UEs across pts #${c.startPointNumber}–#${c.endPointNumber} (span ${c.spanPoints}, Set ${c.setNumber} · ${escapeHtml(c.startScoreText)})</div>`
          )
          .join('');

  const windowRows =
    windows15m.length === 0
      ? '<div class="muted">No timed rallies recorded yet.</div>'
      : `<table class="analytics-table">
           <thead>
             <tr>
               <th>Window</th>
               <th>MY UE</th>
               <th>Lost</th>
               <th>Pts (n)</th>
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
      <h3>UE Analytics</h3>

      <div class="stat-grid">
        <div class="stat-box">
          <span class="sub-score-label">Clutch UEs (Unique)</span>
          <span class="stat-value">${clutch.clutchUeTotal}</span>
          <span class="muted">${escapeHtml(formatUePercent(clutch.clutchUePctOfPointsLost))} of ${clutch.clutchPointsLost} lost</span>
        </div>
        <div class="stat-box">
          <span class="sub-score-label">Ordinary Hold Rate</span>
          <span class="stat-value" style="font-size:19px;">${escapeHtml(holdText)}</span>
          <span class="muted">Excludes incomplete &amp; TB</span>
        </div>
        <div class="stat-box">
          <span class="sub-score-label">Serving UEs</span>
          <span class="stat-value">${serveReturn.serving.myUePoints}</span>
          <span class="muted">${escapeHtml(formatUePercent(serveReturn.serving.uePctOfPointsLost))} of ${serveReturn.serving.pointsLost} lost</span>
        </div>
        <div class="stat-box">
          <span class="sub-score-label">Returning UEs</span>
          <span class="stat-value">${serveReturn.returning.myUePoints}</span>
          <span class="muted">${escapeHtml(formatUePercent(serveReturn.returning.uePctOfPointsLost))} of ${serveReturn.returning.pointsLost} lost</span>
        </div>
      </div>

      <table class="analytics-table">
        <thead>
          <tr>
            <th>Clutch Type</th>
            <th>MY UE</th>
            <th>Lost</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Golden Point (40-40)</td>
            <td>${clutch.byLabel.goldenPoint.myUePoints}</td>
            <td>${clutch.byLabel.goldenPoint.pointsLost}</td>
            <td>${clutch.byLabel.goldenPoint.totalPoints}</td>
          </tr>
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

      <div>
        <div class="muted" style="margin-bottom:6px;"><strong>UE Clusters (${clusters.length})</strong></div>
        <div class="controls-stack">${clusterRows}</div>
      </div>

      <div>
        <div class="muted" style="margin-bottom:6px;"><strong>15-Minute Elapsed Windows</strong></div>
        ${windowRows}
        ${
          unbucketedCount > 0
            ? `<div class="muted" style="margin-top:4px;">${unbucketedCount} rally(s) excluded from time windows due to invalid timestamp.</div>`
            : ''
        }
      </div>

      <div class="controls-row">
        <button class="btn btn-sm" data-action="export-match" data-source="${escapeHtml(exportSource)}"${matchIdAttr} data-format="csv">Download CSV</button>
        <button class="btn btn-sm" data-action="export-match" data-source="${escapeHtml(exportSource)}"${matchIdAttr} data-format="json">Download JSON</button>
      </div>
    </div>
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
  const partialLine = formatPartialScoreLine(s);

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

      ${
        vm.history.error
          ? `<div class="banner banner-warn" data-testid="history-error-banner">
               <div>${escapeHtml(vm.history.error)}</div>
               ${
                 vm.isWriter
                   ? `<button class="btn btn-sm btn-primary" data-action="retry-archive">Retry Save to History</button>`
                   : ''
               }
             </div>`
          : ''
      }

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

      ${renderAnalyticsPanel(vm.matchOverAnalytics, 'current')}
    </section>
  `;
}

function renderHistoryScreen(vm) {
  const h = vm.history;
  const backLabel =
    vm.baseScreen === 'LIVE'
      ? 'Back to Live Match'
      : vm.baseScreen === 'MATCH_OVER'
        ? 'Back to Match Over'
        : 'Back';

  const statusNote =
    h.status === 'CORRUPT' || h.status === 'READ_ERROR'
      ? `<div class="banner banner-err">History storage is unreadable (${escapeHtml(h.status)}). Stored data was left intact.</div>`
      : h.corruptCount > 0
        ? `<div class="banner banner-warn">${h.corruptCount} unreadable history row(s) detected. Valid matches remain viewable/exportable; history edits are paused to preserve stored data byte-for-byte.</div>`
        : '';

  const rows =
    h.items.length === 0
      ? '<div class="muted">No archived matches yet. Finished matches appear here automatically.</div>'
      : h.items
          .map((item) => {
            const badge =
              item.status === 'FINISHED_MANUAL'
                ? 'MANUAL'
                : item.winner === 0
                  ? 'WIN'
                  : 'LOSS';
            const confirmOpen = h.confirmDeleteMatchId === item.matchId;
            return `
              <div class="history-item" data-history-id="${escapeHtml(item.matchId)}">
                <div class="banner-row">
                  <strong>${badge} · Sets ${escapeHtml(item.setsText)} (${escapeHtml(item.scoringMode)})</strong>
                  <span class="muted">${escapeHtml(item.durationText)}</span>
                </div>
                <div class="muted">
                  ${escapeHtml(item.dateText)} · MY UE: ${item.myUePoints} (${escapeHtml(item.uePctText)})
                  ${item.setLines.length ? ` · ${escapeHtml(item.setLines.join(', '))}` : ''}
                </div>
                ${
                  confirmOpen
                    ? `<div class="confirm-box">
                         <div><strong>Delete this match from history?</strong> Export first if you want a copy.</div>
                         <div class="controls-row">
                           <button class="btn btn-sm" data-action="cancel-delete-history">Cancel</button>
                           <button class="btn btn-sm btn-danger" data-action="confirm-delete-history" data-match-id="${escapeHtml(item.matchId)}">Confirm Delete</button>
                         </div>
                       </div>`
                    : `<div class="controls-row">
                         <button class="btn btn-sm btn-primary" data-action="inspect-history" data-match-id="${escapeHtml(item.matchId)}">Inspect</button>
                         ${
                           item.canDelete
                             ? `<button class="btn btn-sm btn-danger" data-action="open-delete-history" data-match-id="${escapeHtml(item.matchId)}">Delete</button>`
                             : `<button class="btn btn-sm" disabled>${item.isCurrentlyOpenActive ? 'Open on Match Over' : 'Read-Only'}</button>`
                         }
                       </div>`
                }
              </div>
            `;
          })
          .join('');

  return `
    <section class="card" data-screen="HISTORY">
      <div class="banner-row">
        <h1>Match History (${h.count})</h1>
        <button class="btn btn-sm" data-action="close-history">${escapeHtml(backLabel)}</button>
      </div>
      ${h.error ? `<div class="banner banner-err">${escapeHtml(h.error)}</div>` : ''}
      ${statusNote}
      <div class="controls-stack">${rows}</div>
    </section>
  `;
}

function renderHistoryDetailScreen(vm) {
  const h = vm.history;
  const rec = h.inspectedRecord;
  const ana = h.inspectedAnalytics;
  if (!rec || !ana) {
    return renderHistoryScreen(vm);
  }
  const s = ana.summary;
  const isManual = s.status === 'FINISHED_MANUAL';
  const headline = isManual
    ? 'Finished Manually'
    : s.winner === 0
      ? 'Match Won — US'
      : 'Match Won — THEM';
  const setLines = s.setHistory.map(formatSetLine);
  const partialLine = formatPartialScoreLine(s);
  const confirmOpen = h.confirmDeleteMatchId === rec.matchId;

  return `
    <section class="card" data-screen="HISTORY_DETAIL">
      <div class="banner-row">
        <button class="btn btn-sm" data-action="back-history-list">← All Matches</button>
        <button class="btn btn-sm" data-action="close-history">${vm.baseScreen === 'LIVE' ? 'Back to Live' : 'Close'}</button>
      </div>
      ${h.error ? `<div class="banner banner-err" role="alert">${escapeHtml(h.error)}</div>` : ''}
      <div class="score-header">
        <span>${escapeHtml(h.inspectedDateText)} · ${escapeHtml(s.scoringMode)}</span>
        <span>${escapeHtml(formatDuration(s.durationSec))} · #${s.revision}</span>
      </div>
      <h1>${escapeHtml(headline)}</h1>
      <div>
        <strong>Sets:</strong> ${s.sets[0]}-${s.sets[1]}
        ${setLines.length ? ` (${escapeHtml(setLines.join(', '))})` : ''}
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
          <span class="stat-value">${escapeHtml(formatUePercent(s.myUePctOfPointsLost))}</span>
        </div>
      </div>

      ${renderAnalyticsPanel(ana, 'history', rec.matchId)}

      ${
        h.inspectedCanDelete
          ? confirmOpen
            ? `<div class="confirm-box">
                 <div><strong>Delete this match from history?</strong> Export first if you want a copy.</div>
                 <div class="controls-row">
                   <button class="btn btn-sm" data-action="cancel-delete-history">Cancel</button>
                   <button class="btn btn-sm btn-danger" data-action="confirm-delete-history" data-match-id="${escapeHtml(rec.matchId)}">Confirm Delete</button>
                 </div>
               </div>`
            : `<button class="btn btn-sm btn-danger" data-action="open-delete-history" data-match-id="${escapeHtml(rec.matchId)}">Delete from History</button>`
          : h.inspectedIsOpenActive
            ? `<div class="muted">Currently open on Match Over — start a New Match before deleting from history.</div>`
            : ''
      }
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
    else if (vm.screen === 'HISTORY') body = renderHistoryScreen(vm);
    else if (vm.screen === 'HISTORY_DETAIL') body = renderHistoryDetailScreen(vm);
    else if (vm.screen === 'SETUP') body = renderSetupScreen(vm);
    else if (vm.screen === 'LIVE') body = renderLiveScreen(vm);
    else body = renderMatchOverScreen(vm);

    const showHistoryBtn =
      vm.screen !== 'LOADING' && vm.screen !== 'HISTORY' && vm.screen !== 'HISTORY_DETAIL';

    root.innerHTML = `
      <header class="topbar">
        <div class="brand">PadelScore</div>
        <div class="topbar-actions">
          ${
            showHistoryBtn
              ? `<button class="btn btn-sm" data-action="open-history">History (${vm.history.count})</button>`
              : ''
          }
          <div class="pill">${vm.isWriter ? 'WRITER' : 'READ-ONLY'} · ${escapeHtml(vm.screen)}</div>
        </div>
      </header>
      ${renderReadOnlyBanner(vm)}
      ${renderWristBanner(vm)}
      ${renderErrorBanners(vm)}
      ${copyFeedback ? `<div class="banner banner-ok">${escapeHtml(copyFeedback)}</div>` : ''}
      ${body}
    `;
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
      // Keep object URL alive through download initiation on Android Chrome before revoking
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
    } else if (action === 'start-match-discard') {
      controller.startMatch({ linkWrist: true, allowDiscardUnarchived: true });
    } else if (action === 'cancel-replacement') {
      controller.cancelReplacementSetup();
    } else if (action === 'retry-archive') {
      controller.retryArchiveCurrentMatch();
    } else if (action === 'open-history') {
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
