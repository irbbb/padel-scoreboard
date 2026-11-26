import { analyzeMatch, isValidDateMs } from './matchAnalytics.js';
import { validateMatchRecord } from './scoreEngine.js';

export const EXPORT_VERSION = 1;

export const CSV_HEADERS = Object.freeze([
  'event_id',
  'timestamp_utc',
  'elapsed_sec',
  'code',
  'point_winner',
  'is_my_ue',
  'pre_set',
  'pre_games_us',
  'pre_games_them',
  'pre_points_us',
  'pre_points_them',
  'in_tiebreak',
  'pre_server',
  'clutch_labels',
  'post_sets_us',
  'post_sets_them',
  'post_games_us',
  'post_games_them',
  'post_points_us',
  'post_points_them',
]);

export function formatIsoUtcOrEmpty(ms) {
  if (!isValidDateMs(ms)) return '';
  return new Date(ms).toISOString();
}

function formatIsoUtcOrNull(ms) {
  if (!isValidDateMs(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Escapes an RFC 4180 CSV field.
 * Numeric cells are emitted directly without formula prefixes; untrusted string cells
 * guard against spreadsheet formula prefixes (leading control chars or =, +, -, @).
 */
export function formatCsvCell(value, { untrustedText = false } = {}) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  let text = String(value);
  if (untrustedText && text.length > 0) {
    // Strip leading ASCII control chars when checking formula start; prefix with apostrophe if risky
    const firstVisible = text.replace(/^[\x00-\x20]+/, '');
    if (
      /^[\t\r\n]/.test(text) ||
      (firstVisible.length > 0 && /^[=+\-@]/.test(firstVisible))
    ) {
      text = `'${text}`;
    }
  }

  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function buildExportFilename(record, ext) {
  const safeExt = ext === 'json' ? 'json' : 'csv';
  const rawId = typeof record?.matchId === 'string' ? record.matchId : 'match';
  const slug = rawId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'match';
  const datePrefix = isValidDateMs(record?.startTimeMs)
    ? new Date(record.startTimeMs).toISOString().slice(0, 10)
    : 'undated';
  return `padel-${datePrefix}-${slug}.${safeExt}`;
}

/**
 * Exports a match and its single-pass analytics as RFC 4180 CSV (one row per rally).
 * Header-only CSV is emitted cleanly for 0-rally matches.
 */
export function exportMatchCsv(record, analytics = null) {
  const frozenRecord = validateMatchRecord(record);
  const resolved = analytics ?? analyzeMatch(frozenRecord, frozenRecord.finishTimeMs ?? frozenRecord.startTimeMs);

  const lines = [CSV_HEADERS.join(',')];

  for (const row of resolved.timeline) {
    const cells = [
      formatCsvCell(row.eventId),
      formatCsvCell(formatIsoUtcOrEmpty(row.t)),
      formatCsvCell(row.elapsedSec),
      formatCsvCell(row.code),
      formatCsvCell(row.pointWinner),
      formatCsvCell(row.isMyUe),
      formatCsvCell(row.preSetNumber),
      formatCsvCell(row.preGames[0]),
      formatCsvCell(row.preGames[1]),
      formatCsvCell(row.prePointsLabel[0]),
      formatCsvCell(row.prePointsLabel[1]),
      formatCsvCell(row.inTieBreak),
      formatCsvCell(row.preServer === 0 ? 'US' : row.preServer === 1 ? 'THEM' : ''),
      formatCsvCell(row.clutchLabels.join('|')),
      formatCsvCell(row.postSets[0]),
      formatCsvCell(row.postSets[1]),
      formatCsvCell(row.postGames[0]),
      formatCsvCell(row.postGames[1]),
      formatCsvCell(row.postPointsLabel[0]),
      formatCsvCell(row.postPointsLabel[1]),
    ];
    lines.push(cells.join(','));
  }

  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Exports a versioned, human-readable JSON snapshot preserving raw values, numeric ratios,
 * null denominators, and safe per-field ISO UTC strings.
 */
export function exportMatchJson(record, analytics = null) {
  const frozenRecord = validateMatchRecord(record);
  const resolved = analytics ?? analyzeMatch(frozenRecord, frozenRecord.finishTimeMs ?? frozenRecord.startTimeMs);

  const payload = {
    exportVersion: EXPORT_VERSION,
    match: frozenRecord,
    timestampsUtc: {
      startTimeUtc: formatIsoUtcOrNull(frozenRecord.startTimeMs),
      finishTimeUtc: formatIsoUtcOrNull(frozenRecord.finishTimeMs),
    },
    summary: resolved.summary,
    analytics: {
      clutch: resolved.clutch,
      serveReturn: resolved.serveReturn,
      serviceHold: resolved.serviceHold,
      clusters: resolved.clusters,
      windows15m: resolved.windows15m,
      unbucketedCount: resolved.unbucketedCount,
      timeline: resolved.timeline.map((row) => ({
        ...row,
        timestampUtc: formatIsoUtcOrNull(row.t),
      })),
    },
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}
