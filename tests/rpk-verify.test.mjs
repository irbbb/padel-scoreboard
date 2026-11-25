import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDebugSigningPair } from '../scripts/gen-debug-sign.mjs';
import { buildAndVerifyRpk, getExpectedDebugRpkPath } from '../scripts/build-rpk.mjs';
import { verifyRpkSignature } from '../scripts/rpk-verify.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'padel-rpk-test-'));
}

test('buildAndVerifyRpk removes stale RPK and fails if build produces no fresh RPK', () => {
  const root = makeTempDir();
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src/manifest.json'),
      JSON.stringify({ package: 'com.test.stale', versionName: '0.1.0' })
    );
    ensureDebugSigningPair({ signDir: path.join(root, 'sign/debug') });

    const stalePath = getExpectedDebugRpkPath(root);
    fs.writeFileSync(stalePath, Buffer.from('stale-rpk-bytes'));

    // Simulated build exits 0 without writing a new RPK -> must fail, not reuse stale file
    assert.throws(
      () =>
        buildAndVerifyRpk({
          projectRoot: root,
          runAiotBuild: () => ({ status: 0, stdout: '', stderr: '' }),
        }),
      /Expected signed RPK was not produced/
    );
    assert.equal(fs.existsSync(stalePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifyRpkSignature validates real signed RPK and rejects wrong signer or modified bytes', (t) => {
  const rpkPath = getExpectedDebugRpkPath(process.cwd());
  const certPath = path.resolve('sign/debug/certificate.pem');
  if (!fs.existsSync(rpkPath) || !fs.existsSync(certPath)) {
    t.skip('Run "npm run sign:debug && npm run build:rpk" first to run live RPK signature checks');
    return;
  }

  // 1. Real RPK passes with matching signer certificate
  const verified = verifyRpkSignature(rpkPath, certPath);
  assert.ok(verified.bytes > 0);
  assert.match(verified.rpkSha256, /^[0-9a-f]{64}$/);

  const tmpDir = makeTempDir();
  try {
    // 2. Different signer certificate fails
    const otherPair = ensureDebugSigningPair({ signDir: path.join(tmpDir, 'other-sign') });
    assert.throws(
      () => verifyRpkSignature(rpkPath, otherPair.certPath),
      /RPK signer certificate mismatch/
    );

    // 3. Modified RPK content byte fails digest check
    const tamperedRpk = path.join(tmpDir, 'tampered.rpk');
    const bytes = Buffer.from(fs.readFileSync(rpkPath));
    bytes[40] ^= 0xff; // Flip one byte inside ZIP entry data
    fs.writeFileSync(tamperedRpk, bytes);
    assert.throws(
      () => verifyRpkSignature(tamperedRpk, certPath),
      /content digest mismatch/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
