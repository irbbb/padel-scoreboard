export const KEEP_ALIVE_DURATION_SEC = 10;
export const KEEP_ALIVE_SAMPLE_RATE = 8000;
export const KEEP_ALIVE_FREQ_HZ = 220;
export const KEEP_ALIVE_AMPLITUDE = 120;
export const KEEP_ALIVE_VOLUME = 0.005;

/**
 * Generates a 10-second 8 kHz 16-bit mono PCM RIFF/WAVE payload in memory.
 * Uses gentle non-zero PCM samples (played at volume 0.005) to satisfy Chromium Android's
 * >= 5s media criterion for MediaSession notifications while avoiding HTTP 206 range issues offline.
 */
export function createKeepAliveWavBytes({
  durationSec = KEEP_ALIVE_DURATION_SEC,
  sampleRate = KEEP_ALIVE_SAMPLE_RATE,
  freqHz = KEEP_ALIVE_FREQ_HZ,
  amplitude = KEEP_ALIVE_AMPLITUDE,
} = {}) {
  if (!Number.isSafeInteger(durationSec) || durationSec < 1) {
    throw new Error('Invalid durationSec: expected positive safe integer');
  }
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1000) {
    throw new Error('Invalid sampleRate: expected safe integer >= 1000');
  }
  if (typeof freqHz !== 'number' || !Number.isFinite(freqHz) || freqHz <= 0) {
    throw new Error('Invalid freqHz: expected positive finite number');
  }
  if (!Number.isSafeInteger(amplitude) || amplitude < 1 || amplitude > 32767) {
    throw new Error('Invalid amplitude: expected integer in [1, 32767]');
  }

  const numSamples = durationSec * sampleRate;
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, 1, true); // NumChannels = 1 (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate = SampleRate * Channels * Bits/8
  view.setUint16(32, 2, true); // BlockAlign = Channels * Bits/8
  view.setUint16(34, 16, true); // BitsPerSample = 16
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amplitude);
    view.setInt16(44 + i * 2, sample, true);
  }

  return new Uint8Array(buffer);
}

/**
 * Browser helper: wraps generated PCM WAV bytes in an in-memory Blob object URL.
 * Caller should revoke via URL.revokeObjectURL(url) on final teardown.
 */
export function createKeepAliveAudioBlobUrl(opts) {
  const bytes = createKeepAliveWavBytes(opts);
  const blob = new Blob([bytes], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}
