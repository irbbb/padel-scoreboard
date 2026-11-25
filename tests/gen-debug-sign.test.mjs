import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDebugSigningPair, validateSigningPair } from '../scripts/gen-debug-sign.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'padel-sign-test-'));
}

test('first generation creates a valid pair and reuse keeps identical fingerprint', () => {
  const dir = makeTempDir();
  try {
    const first = ensureDebugSigningPair({ signDir: dir });
    assert.equal(first.action, 'generated');
    assert.ok(fs.existsSync(first.keyPath));
    assert.ok(fs.existsSync(first.certPath));

    const second = ensureDebugSigningPair({ signDir: dir });
    assert.equal(second.action, 'reused');
    assert.equal(second.fingerprint256, first.fingerprint256);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('partial pair fails cleanly for key-only and cert-only cases', () => {
  const dir = makeTempDir();
  try {
    const created = ensureDebugSigningPair({ signDir: dir });
    const savedCert = fs.readFileSync(created.certPath);

    // Key-only
    fs.rmSync(created.certPath);
    assert.throws(() => ensureDebugSigningPair({ signDir: dir }), /Partial debug signing pair/);

    // Cert-only
    fs.writeFileSync(created.certPath, savedCert);
    fs.rmSync(created.keyPath);
    assert.throws(() => ensureDebugSigningPair({ signDir: dir }), /Partial debug signing pair/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mismatched private key and certificate are rejected', () => {
  const dirA = makeTempDir();
  const dirB = makeTempDir();
  try {
    const pairA = ensureDebugSigningPair({ signDir: dirA });
    const pairB = ensureDebugSigningPair({ signDir: dirB });
    // Overwrite A's cert with B's cert
    fs.copyFileSync(pairB.certPath, pairA.certPath);

    assert.throws(() => ensureDebugSigningPair({ signDir: dirA }), /Mismatched signing pair/);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('expired certificate is rejected before reuse', () => {
  const dir = makeTempDir();
  try {
    const pair = ensureDebugSigningPair({ signDir: dir, days: 1 });
    const twoDaysLater = Date.now() + 2 * 24 * 60 * 60 * 1000;

    assert.throws(
      () => validateSigningPair(pair.keyPath, pair.certPath, twoDaysLater),
      /expired or not yet valid/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed --force rotation preserves the original working pair', () => {
  const dir = makeTempDir();
  try {
    const original = ensureDebugSigningPair({ signDir: dir });
    const origKey = fs.readFileSync(original.keyPath, 'utf8');
    const origCert = fs.readFileSync(original.certPath, 'utf8');

    assert.throws(() =>
      ensureDebugSigningPair({
        signDir: dir,
        force: true,
        opensslBin: 'nonexistent-openssl-binary-xyz',
      })
    );

    assert.equal(fs.readFileSync(original.keyPath, 'utf8'), origKey);
    assert.equal(fs.readFileSync(original.certPath, 'utf8'), origCert);
    const verified = ensureDebugSigningPair({ signDir: dir });
    assert.equal(verified.fingerprint256, original.fingerprint256);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sign/ directory is excluded in both .gitignore and .dockerignore', () => {
  const gitignore = fs.readFileSync(path.resolve('.gitignore'), 'utf8');
  const dockerignore = fs.readFileSync(path.resolve('.dockerignore'), 'utf8');
  assert.match(gitignore, /^\/?sign\/?$/m);
  assert.match(dockerignore, /^\/?sign\/?$/m);
});
