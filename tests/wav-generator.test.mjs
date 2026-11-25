import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createKeepAliveWavBytes,
  KEEP_ALIVE_DURATION_SEC,
  KEEP_ALIVE_SAMPLE_RATE,
} from '../src/app/wavGenerator.js';

test('generates valid 10-second 8 kHz 16-bit mono PCM RIFF/WAVE payload with non-zero samples', () => {
  const bytes = createKeepAliveWavBytes();
  const expectedDataSize = KEEP_ALIVE_DURATION_SEC * KEEP_ALIVE_SAMPLE_RATE * 2;
  assert.equal(bytes.byteLength, 44 + expectedDataSize);
  assert.equal(bytes.byteLength, 160044);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start, len) => String.fromCharCode(...bytes.slice(start, start + len));

  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 36 + expectedDataSize);
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getUint32(28, true), 16000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint32(40, true), expectedDataSize);

  let nonZero = 0;
  let maxAbs = 0;
  for (let i = 0; i < KEEP_ALIVE_DURATION_SEC * KEEP_ALIVE_SAMPLE_RATE; i += 1) {
    const sample = view.getInt16(44 + i * 2, true);
    if (sample !== 0) nonZero += 1;
    maxAbs = Math.max(maxAbs, Math.abs(sample));
  }
  assert.ok(nonZero > 70000);
  assert.equal(maxAbs, 120);
});

test('rejects invalid WAV parameters', () => {
  assert.throws(() => createKeepAliveWavBytes({ durationSec: 0 }), /durationSec/);
  assert.throws(() => createKeepAliveWavBytes({ sampleRate: 500 }), /sampleRate/);
  assert.throws(() => createKeepAliveWavBytes({ freqHz: -1 }), /freqHz/);
  assert.throws(() => createKeepAliveWavBytes({ amplitude: 0 }), /amplitude/);
});
