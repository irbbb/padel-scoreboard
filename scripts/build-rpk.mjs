import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSigningPair } from './gen-debug-sign.mjs';
import { verifyRpkSignature } from './rpk-verify.mjs';

export function getExpectedDebugRpkPath(projectRoot = process.cwd()) {
  const manifestPath = path.join(projectRoot, 'src/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return path.join(projectRoot, 'dist', `${manifest.package}.debug.${manifest.versionName}.rpk`);
}

export function buildAndVerifyRpk({
  projectRoot = process.cwd(),
  runAiotBuild = null,
} = {}) {
  const keyPath = path.join(projectRoot, 'sign/debug/private.pem');
  const certPath = path.join(projectRoot, 'sign/debug/certificate.pem');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    throw new Error(
      'Missing or partial disposable debug key pair in sign/debug/. Run "npm run sign:debug" first.'
    );
  }
  validateSigningPair(keyPath, certPath);

  const expectedRpkPath = getExpectedDebugRpkPath(projectRoot);

  // Remove any stale RPK so a failed or skipped build can never pass using an old artifact
  if (fs.existsSync(expectedRpkPath)) {
    fs.rmSync(expectedRpkPath, { force: true });
  }
  if (fs.existsSync(expectedRpkPath)) {
    throw new Error(`Could not remove stale RPK before build: ${expectedRpkPath}`);
  }

  const execBuild =
    runAiotBuild ??
    (() => {
      const aiotBin = path.join(projectRoot, 'node_modules/.bin/aiot');
      return spawnSync(aiotBin, ['build'], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'pipe'],
      });
    });

  const result = execBuild();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    throw new Error(`aiot build exited with code ${result.status}`);
  }

  if (!fs.existsSync(expectedRpkPath)) {
    throw new Error(`Expected signed RPK was not produced by this build: ${expectedRpkPath}`);
  }

  const verification = verifyRpkSignature(expectedRpkPath, certPath);
  return {
    rpkPath: expectedRpkPath,
    ...verification,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const info = buildAndVerifyRpk();
    const relPath = path.relative(process.cwd(), info.rpkPath).replace(/\\/g, '/');
    console.log(`VERIFIED SIGNED RPK: ${relPath} (${info.bytes} bytes)`);
    console.log(`RPK SHA-256 (this build): ${info.rpkSha256}`);
    console.log(`SIGNER CERT SHA-256:      ${info.signerFingerprint256}`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}
