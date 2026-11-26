import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, addPoint, finishManual } from '../src/core/scoreEngine.js';
import { analyzeMatch } from '../src/core/matchAnalytics.js';
import {
  buildExportFilename,
  CSV_HEADERS,
  exportMatchCsv,
  exportMatchJson,
  formatCsvCell,
} from '../src/core/matchExport.js';

const T0 = Date.UTC(2026, 4, 1, 18, 0, 0);

test('formatCsvCell handles numbers, engine tokens, RFC 4180 quoting, and untrusted formula prefixes', () => {
  assert.equal(formatCsvCell(-42), '-42');
  assert.equal(formatCsvCell('0-0'), '0-0');
  assert.equal(formatCsvCell('a,b'), '"a,b"');
  assert.equal(formatCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(formatCsvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(formatCsvCell('=SUM(A1)', { untrustedText: true }), "'=SUM(A1)");
  assert.equal(formatCsvCell('\t+cmd', { untrustedText: true }), "'\t+cmd");
  assert.equal(formatCsvCell('  -1+1', { untrustedText: true }), "'  -1+1");
  assert.equal(formatCsvCell('@evil', { untrustedText: true }), "'@evil");
});

test('exportMatchCsv emits RFC 4180 header-only file for 0 rallies and consistent column counts with invalid Date fallback', () => {
  let empty = createMatch({ matchId: 'm/empty 1', config: { scoringMode: 'AD', initialServer: null }, nowMs: 1e20 });
  empty = finishManual(empty, 1e20);

  assert.equal(buildExportFilename(empty, 'csv'), 'padel-undated-m-empty-1.csv');
  const emptyCsv = exportMatchCsv(empty);
  const emptyLines = emptyCsv.trimEnd().split('\r\n');
  assert.equal(emptyLines.length, 1);
  assert.equal(emptyLines[0], CSV_HEADERS.join(','));

  let m = createMatch({ matchId: 'm-csv-1', config: { scoringMode: 'GP', initialServer: 0 }, nowMs: T0 });
  m = addPoint(m, 'A', T0 + 5_000);
  m = addPoint(m, 'E', 1e20); // Unusable Date timestamp
  m = finishManual(m, T0 + 15_000);

  const ana = analyzeMatch(m);
  const csv = exportMatchCsv(m, ana);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.equal(line.split(',').length, CSV_HEADERS.length);
  }
  const row1 = lines[1].split(',');
  assert.equal(row1[1], '2026-05-01T18:00:05.000Z');
  assert.equal(row1[3], 'A');
  const row2 = lines[2].split(',');
  assert.equal(row2[1], ''); // Safe empty UTC cell for 1e20
  assert.equal(row2[2], ''); // Null elapsedSec
  assert.equal(row2[3], 'E');
  assert.equal(row2[5], 'true');

  // JSON export retains raw 1e20, numeric ratios, null denominators, and reproduces identically
  const json1 = exportMatchJson(m, ana);
  const json2 = exportMatchJson(m, ana);
  assert.equal(json1, json2);
  const parsed = JSON.parse(json1);
  assert.equal(parsed.exportVersion, 1);
  assert.equal(parsed.analytics.timeline[1].t, 1e20);
  assert.equal(parsed.analytics.timeline[1].timestampUtc, null);
  assert.equal(parsed.analytics.serviceHold.holdRate, null);
  assert.equal(parsed.summary.myUePctOfPointsLost, 1);
});
