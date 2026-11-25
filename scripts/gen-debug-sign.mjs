import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function validateSigningPair(keyPath, certPath, nowMs = Date.now()) {
  const keyPem = fs.readFileSync(keyPath);
  const certPem = fs.readFileSync(certPath);

  let privateKey;
  let cert;
  try {
    privateKey = crypto.createPrivateKey(keyPem);
    cert = new crypto.X509Certificate(certPem);
  } catch (err) {
    throw new Error(`Invalid PEM format in signing pair: ${err.message}`);
  }

  if (!cert.checkPrivateKey(privateKey)) {
    throw new Error('Mismatched signing pair: certificate.pem does not match private.pem');
  }

  const validFromMs = Date.parse(cert.validFrom);
  const validToMs = Date.parse(cert.validTo);
  // Allow 2s tolerance on validFrom for X.509 1-second UTCTime rounding, enforce validTo strictly
  if (
    Number.isNaN(validFromMs) ||
    Number.isNaN(validToMs) ||
    nowMs + 2000 < validFromMs ||
    nowMs >= validToMs
  ) {
    throw new Error(
      `Debug certificate is expired or not yet valid (validFrom=${cert.validFrom}, validTo=${cert.validTo})`
    );
  }

  return {
    fingerprint256: cert.fingerprint256,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
  };
}

export function ensureDebugSigningPair({
  signDir = path.resolve('sign/debug'),
  force = false,
  opensslBin = 'openssl',
  days = 365,
  nowMs = undefined,
} = {}) {
  const keyPath = path.join(signDir, 'private.pem');
  const certPath = path.join(signDir, 'certificate.pem');
  const hasKey = fs.existsSync(keyPath);
  const hasCert = fs.existsSync(certPath);

  if (!force) {
    if (hasKey && hasCert) {
      const info = validateSigningPair(keyPath, certPath, nowMs ?? Date.now());
      return { action: 'reused', keyPath, certPath, ...info };
    }
    if (hasKey !== hasCert) {
      throw new Error(
        `Partial debug signing pair detected in ${signDir} (only one of private.pem or certificate.pem exists). ` +
          'Remove the leftover file or re-run with --force to regenerate.'
      );
    }
  }

  // Generate and validate replacement in a temp directory before touching the working pair
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'padel-sign-'));
  const tmpKey = path.join(tmpDir, 'private.pem');
  const tmpCert = path.join(tmpDir, 'certificate.pem');

  try {
    execFileSync(
      opensslBin,
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        tmpKey,
        '-x509',
        '-days',
        String(days),
        '-out',
        tmpCert,
        '-subj',
        '/CN=PadelScoreDebug',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const info = validateSigningPair(tmpKey, tmpCert, nowMs ?? Date.now());

    fs.mkdirSync(signDir, { recursive: true });
    fs.copyFileSync(tmpKey, keyPath);
    fs.copyFileSync(tmpCert, certPath);

    return { action: force && (hasKey || hasCert) ? 'rotated' : 'generated', keyPath, certPath, ...info };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const force = process.argv.includes('--force');
    const result = ensureDebugSigningPair({ force });
    console.log(
      `${result.action === 'reused' ? 'Reusing existing' : result.action === 'rotated' ? 'Rotated' : 'Generated'} ` +
        `disposable debug key pair in sign/debug/ (SHA-256: ${result.fingerprint256}).`
    );
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}
