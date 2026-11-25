import crypto from 'node:crypto';
import fs from 'node:fs';

const RPK_SIG_BLOCK_MAGIC = Buffer.from('RPK Sig Block 42', 'ascii');
const RPK_V2_BLOCK_ID = 0x01000101;
const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const CHUNK_SIZE = 1024 * 1024;

function readLengthPrefixed(buf, offset) {
  if (offset + 4 > buf.length) {
    throw new Error(`Unexpected EOF reading length prefix at offset ${offset}`);
  }
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > buf.length) {
    throw new Error(`Length-prefixed field (${len} bytes) overflows buffer at offset ${offset}`);
  }
  return [buf.subarray(start, end), end];
}

function findEocdOffset(buf) {
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (
      buf[i] === EOCD_SIGNATURE[0] &&
      buf[i + 1] === EOCD_SIGNATURE[1] &&
      buf[i + 2] === EOCD_SIGNATURE[2] &&
      buf[i + 3] === EOCD_SIGNATURE[3]
    ) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        return i;
      }
    }
  }
  throw new Error('Invalid RPK: ZIP End of Central Directory (EOCD) not found');
}

function computeChunkedSha256(sections) {
  const chunkDigests = [];
  for (const sec of sections) {
    if (sec.length === 0) {
      const h = crypto.createHash('sha256');
      const hdr = Buffer.alloc(5);
      hdr[0] = 0xa5;
      hdr.writeUInt32LE(0, 1);
      h.update(hdr);
      chunkDigests.push(h.digest());
      continue;
    }
    for (let off = 0; off < sec.length; off += CHUNK_SIZE) {
      const chunk = sec.subarray(off, Math.min(off + CHUNK_SIZE, sec.length));
      const h = crypto.createHash('sha256');
      const hdr = Buffer.alloc(5);
      hdr[0] = 0xa5;
      hdr.writeUInt32LE(chunk.length, 1);
      h.update(hdr);
      h.update(chunk);
      chunkDigests.push(h.digest());
    }
  }

  const top = crypto.createHash('sha256');
  const topHdr = Buffer.alloc(5);
  topHdr[0] = 0x5a;
  topHdr.writeUInt32LE(chunkDigests.length, 1);
  top.update(topHdr);
  for (const d of chunkDigests) {
    top.update(d);
  }
  return top.digest();
}

function findV2BlockPayload(buf, sigStart, cdOffset) {
  let cursor = sigStart + 8;
  const pairsEnd = cdOffset - 24;
  while (cursor < pairsEnd) {
    if (cursor + 12 > pairsEnd) {
      throw new Error('Malformed RPK Signing Block entry header');
    }
    const pairLen = Number(buf.readBigUInt64LE(cursor));
    cursor += 8;
    if (pairLen < 4 || cursor + pairLen > pairsEnd) {
      throw new Error(`Malformed RPK Signing Block entry length: ${pairLen}`);
    }
    const pairId = buf.readUInt32LE(cursor);
    const value = buf.subarray(cursor + 4, cursor + pairLen);
    cursor += pairLen;
    if (pairId === RPK_V2_BLOCK_ID) {
      return value;
    }
  }
  throw new Error('RPK Signing Block does not contain a v2 signature entry (0x01000101)');
}

/**
 * Cryptographically verifies a signed RPK archive against an expected X.509 certificate PEM.
 * Verifies: ZIP/RPK Signing Block structure, RSA-SHA256 signature over signedData,
 * chunked SHA-256 content digest across all 3 ZIP sections, public key consistency,
 * and exact SHA-256 fingerprint match with expectedCertPath.
 */
export function verifyRpkSignature(rpkPath, expectedCertPath) {
  const buf = fs.readFileSync(rpkPath);
  const expectedCert = new crypto.X509Certificate(fs.readFileSync(expectedCertPath));

  const eocdOffset = findEocdOffset(buf);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset < 32 || cdOffset > eocdOffset) {
    throw new Error(`Invalid ZIP Central Directory offset: ${cdOffset}`);
  }

  const magicOffset = cdOffset - 16;
  if (!buf.subarray(magicOffset, cdOffset).equals(RPK_SIG_BLOCK_MAGIC)) {
    throw new Error('RPK Signing Block magic ("RPK Sig Block 42") not found before Central Directory');
  }

  const trailingSize = Number(buf.readBigUInt64LE(magicOffset - 8));
  const sigStart = cdOffset - trailingSize - 8;
  if (sigStart < 0 || sigStart + 8 > magicOffset - 8) {
    throw new Error(`Invalid RPK Signing Block size: ${trailingSize}`);
  }

  const leadingSize = Number(buf.readBigUInt64LE(sigStart));
  if (leadingSize !== trailingSize) {
    throw new Error(`RPK Signing Block size mismatch: leading=${leadingSize}, trailing=${trailingSize}`);
  }

  const payload = findV2BlockPayload(buf, sigStart, cdOffset);
  const [signers] = readLengthPrefixed(payload, 0);
  const [signer] = readLengthPrefixed(signers, 0);
  const [signedData, o1] = readLengthPrefixed(signer, 0);
  const [signatures, o2] = readLengthPrefixed(signer, o1);
  const [pubKeyDer] = readLengthPrefixed(signer, o2);

  const [digests, sd1] = readLengthPrefixed(signedData, 0);
  const [certs] = readLengthPrefixed(signedData, sd1);
  const [digestEntry] = readLengthPrefixed(digests, 0);
  const digestAlgId = digestEntry.readUInt32LE(0);
  const [expectedDigest] = readLengthPrefixed(digestEntry, 4);

  const [certDer] = readLengthPrefixed(certs, 0);
  const [sigEntry] = readLengthPrefixed(signatures, 0);
  const sigAlgId = sigEntry.readUInt32LE(0);
  const [sigBytes] = readLengthPrefixed(sigEntry, 4);

  if (digestAlgId !== 0x0103 || sigAlgId !== 0x0103) {
    throw new Error(
      `Unsupported RPK signature algorithm ID (digest=0x${digestAlgId.toString(16)}, sig=0x${sigAlgId.toString(16)}); expected RSA-SHA256 (0x103)`
    );
  }

  const signerCert = new crypto.X509Certificate(certDer);

  // Verify embedded public key matches signer certificate public key
  const certPubDer = signerCert.publicKey.export({ type: 'spki', format: 'der' });
  if (!certPubDer.equals(pubKeyDer)) {
    throw new Error('RPK signer public key does not match embedded certificate public key');
  }

  // Verify RSA-SHA256 cryptographic signature over signedData
  const sigValid = crypto.verify('RSA-SHA256', signedData, signerCert.publicKey, sigBytes);
  if (!sigValid) {
    throw new Error('RPK cryptographic signature verification failed');
  }

  // Verify chunked SHA-256 content digest across ZIP entries, Central Directory, and patched EOCD
  const eocdPatched = Buffer.from(buf.subarray(eocdOffset));
  eocdPatched.writeUInt32LE(sigStart, 16);
  const computedDigest = computeChunkedSha256([
    buf.subarray(0, sigStart),
    buf.subarray(cdOffset, eocdOffset),
    eocdPatched,
  ]);
  if (!computedDigest.equals(expectedDigest)) {
    throw new Error('RPK content digest mismatch: archive bytes were modified after signing');
  }

  // Verify signer certificate matches sign/debug/certificate.pem
  if (signerCert.fingerprint256 !== expectedCert.fingerprint256) {
    throw new Error(
      `RPK signer certificate mismatch!\n  RPK signer: ${signerCert.fingerprint256}\n  Expected:   ${expectedCert.fingerprint256}`
    );
  }

  const rpkSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    bytes: buf.length,
    rpkSha256,
    signerFingerprint256: signerCert.fingerprint256,
  };
}
