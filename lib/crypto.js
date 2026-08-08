'use strict';

/**
 * Jura WiFi obfuscation cipher.
 *
 * Faithful JS port of `crypto.py` from the `jura_connect` PyPI package
 * (https://pypi.org/project/jura-connect/), itself a direct port of
 * `joe_android_connector.src.connection.wifi.WifiCryptoUtil` from the
 * J.O.E. Android APK. Verified byte-for-byte against the Python
 * original — see /tests in this repo for the cross-check script used
 * during development.
 *
 * Wire framing for TCP messages:
 *
 *   '*' <encoded_payload> '\r\n'
 *
 * <encoded_payload> begins with the random key byte (or the escape
 * sequence 0x1B <key^0x80> when the key value is one of the reserved
 * sync bytes). Every encoded byte that falls into the reserved set is
 * emitted as 0x1B <byte^0x80>. The same escape rules apply on receive.
 *
 * The per-nibble permutation in _a() is self-inverse — encoding twice
 * returns the original input — so the same function powers both
 * encode and decode.
 */

// Permutation tables (4-bit). Lifted verbatim from WifiCryptoUtil via jura_connect.
const SBOX_A = [1, 0, 3, 2, 15, 14, 8, 10, 6, 13, 7, 12, 11, 9, 5, 4];
const SBOX_B = [9, 12, 6, 11, 10, 15, 2, 14, 13, 0, 4, 3, 1, 8, 7, 5];

// Bytes that must be escaped (XOR 0x80, prefixed with 0x1B).
// 0x00 NUL, 0x0A LF, 0x0D CR, 0x26 '&', 0x1B ESC
const RESERVED = new Set([0x00, 0x0a, 0x0d, 0x26, 0x1b]);

const ESCAPE = 0x1b;
const ESCAPE_XOR = 0x80;

/** The per-nibble permutation. Self-inverse for the SBOX_A/SBOX_B pair. */
function _a(nibble, pos, keyHi, keyFull) {
  // Python's `%` always returns a non-negative result for a positive
  // modulus, even on negative operands — JS's `%` does not. mod16()
  // below reproduces Python's behaviour exactly.
  const mod16 = (n) => ((n % 16) + 16) % 16;
  const mod256 = (n) => ((n % 256) + 256) % 256;

  // Stage 1
  let iB = mod256(nibble + pos + keyHi);
  iB = mod16(iB);

  const i11 = mod256(pos >> 4);

  // Stage 2 -- inner SBOX_B lookup
  let innerIdx = mod256(i11 + (SBOX_A[iB] + keyFull) - pos - keyHi);
  innerIdx = mod16(innerIdx);

  // Stage 3 -- outer SBOX_A lookup
  let outerIdx = mod256(SBOX_B[innerIdx] + keyHi + pos - keyFull - i11);
  outerIdx = mod16(outerIdx);

  const result = mod256(SBOX_A[outerIdx] - pos - keyHi);
  return mod16(result);
}

/** Cryptographically-random key byte, skipping reserved low nibbles. */
function keyRandom() {
  const crypto = require('crypto');
  for (;;) {
    const k = crypto.randomBytes(1)[0];
    const low = k & 0x0f;
    // APK rejects low nibbles 0x0E and 0x0F
    if (low !== 0x0e && low !== 0x0f) return k;
  }
}

/**
 * Encode the inner payload (does not include the leading sync '*').
 * @param {Buffer} payload
 * @param {number|null} key
 * @returns {Buffer}
 */
function encodePayload(payload, key = null) {
  const k = key === null ? keyRandom() : key & 0xff;

  const out = [];
  if (RESERVED.has(k)) {
    out.push(ESCAPE, k ^ ESCAPE_XOR);
  } else {
    out.push(k);
  }

  const keyHi = (k >> 4) & 0x0f;
  let pos = 0;
  for (const b of payload) {
    const hi = (b >> 4) & 0x0f;
    const lo = b & 0x0f;
    const eh = _a(hi, pos, keyHi, k) & 0x0f;
    const el = _a(lo, pos + 1, keyHi, k) & 0x0f;
    const enc = ((eh << 4) | el) & 0xff;
    pos += 2;
    if (RESERVED.has(enc)) {
      out.push(ESCAPE, enc ^ ESCAPE_XOR);
    } else {
      out.push(enc);
    }
  }
  return Buffer.from(out);
}

/**
 * Decode the inner payload (does not include the leading sync '*').
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function decodePayload(buf) {
  if (!buf || buf.length === 0) return Buffer.alloc(0);
  let i = 0;
  let key;
  if (buf[i] === ESCAPE) {
    i += 1;
    key = buf[i] ^ ESCAPE_XOR;
    i += 1;
  } else {
    key = buf[i];
    i += 1;
  }
  const keyHi = (key >> 4) & 0x0f;

  const out = [];
  let pos = 0;
  const n = buf.length;
  while (i < n) {
    let b = buf[i];
    i += 1;
    if (b === ESCAPE) {
      if (i >= n) break;
      b = buf[i] ^ ESCAPE_XOR;
      i += 1;
    }
    const hi = (b >> 4) & 0x0f;
    const lo = b & 0x0f;
    const dh = _a(hi, pos, keyHi, key) & 0x0f;
    const dl = _a(lo, pos + 1, keyHi, key) & 0x0f;
    out.push(((dh << 4) | dl) & 0xff);
    pos += 2;
  }
  return Buffer.from(out);
}

// Reasonable upper bound on a single message; matches APK MSS / receive buffer.
const MAX_FRAME = 1500;

/**
 * Encode and wrap a single frame ready to be written to the TCP socket.
 * Output format: '*' <encoded_payload> '\r\n'
 * @param {Buffer|string} payload
 * @param {number|null} key
 * @returns {Buffer}
 */
function wrapFrame(payload, key = null) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'ascii');
  return Buffer.concat([Buffer.from('*'), encodePayload(buf, key), Buffer.from('\r\n')]);
}

/**
 * Decode one received frame. `raw` is the bytes between the leading '*'
 * (which the caller is expected to strip) and the terminating CR/LF,
 * with the encoded key byte still at index 0.
 * @param {Buffer} raw
 * @returns {Buffer}
 */
function unwrapFrame(raw) {
  let buf = raw;
  // Strip optional leading '*' for robustness.
  if (buf.length && buf[0] === 0x2a) buf = buf.subarray(1);
  // Strip trailing CR/LF.
  let end = buf.length;
  while (end > 0 && (buf[end - 1] === 0x0d || buf[end - 1] === 0x0a)) end -= 1;
  buf = buf.subarray(0, end);
  return decodePayload(buf);
}

module.exports = {
  SBOX_A,
  SBOX_B,
  RESERVED,
  MAX_FRAME,
  encodePayload,
  decodePayload,
  wrapFrame,
  unwrapFrame,
};
