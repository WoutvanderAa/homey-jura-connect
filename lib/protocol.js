'use strict';

/**
 * Shared framing primitives, ported from `protocol.py` in the
 * `jura_connect` PyPI package.
 *
 * A "frame" on the wire is exactly:
 *
 *   '*' <encoded_body> '\r\n'
 *
 * <encoded_body> always starts with a key byte (or the escape pair
 * 0x1B <key^0x80> when the key value clashes with the reserved set).
 * The body bytes after the key are obfuscated by crypto.encodePayload;
 * reserved bytes inside the body are re-escaped with the same 0x1B rule.
 *
 * IMPORTANT (from the upstream Python source): the J.O.E. Android app
 * appends '\r\n' to the *cleartext body* BEFORE encoding, in addition
 * to the outer '\r\n' frame terminator. Some firmwares (TT237W-family,
 * seen on an S8 EB) silently reject writes when the inner CRLF is
 * missing — @TM: still ACKs but the value is dropped. Reads work fine
 * without it. wrap() below always appends the inner CRLF to match the
 * official app, and unwrap()/FrameReader strip it back off so callers
 * see a clean payload.
 */

const crypto = require('./crypto');

const SYNC = 0x2a; // '*'
const LINEBREAK = Buffer.from('\r\n');

/**
 * Encode `payload` and produce a framed wire message.
 * @param {Buffer|string} payload
 * @param {number|null} key
 * @returns {Buffer}
 */
function wrap(payload, key = null) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'ascii');
  const endsWithCrlf =
    buf.length >= 2 && buf[buf.length - 2] === 0x0d && buf[buf.length - 1] === 0x0a;
  const body = endsWithCrlf ? buf : Buffer.concat([buf, LINEBREAK]);
  return Buffer.concat([Buffer.from('*'), crypto.encodePayload(body, key), LINEBREAK]);
}

/**
 * Decode one received frame body (between '*' and the trailing CRLF).
 * @param {Buffer} raw
 * @returns {Buffer}
 */
function unwrap(raw) {
  let buf = raw;
  if (buf.length && buf[0] === SYNC) buf = buf.subarray(1);
  let end = buf.length;
  while (end > 0 && (buf[end - 1] === 0x0d || buf[end - 1] === 0x0a)) end -= 1;
  buf = buf.subarray(0, end);
  let decoded = crypto.decodePayload(buf);
  let dEnd = decoded.length;
  while (dEnd > 0 && (decoded[dEnd - 1] === 0x0d || decoded[dEnd - 1] === 0x0a)) dEnd -= 1;
  return decoded.subarray(0, dEnd);
}

/**
 * Buffered, frame-by-frame reader over a Node net.Socket.
 *
 * Unlike the Python version (which blocks on sock.recv()), this
 * accumulates incoming data via the socket's 'data' event and exposes
 * an async nextFrame() that resolves as soon as a complete frame is
 * available — checking the already-buffered bytes first so frames
 * that arrived before nextFrame() was called aren't missed.
 */
class FrameReader {
  constructor(socket) {
    this._socket = socket;
    this._buf = Buffer.alloc(0);
    this._waiters = []; // { resolve, reject }
    this._closed = false;
    this._closeError = null;

    this._onData = (chunk) => {
      this._buf = Buffer.concat([this._buf, chunk]);
      this._drain();
    };
    this._onClose = () => {
      this._closed = true;
      this._closeError = new Error('peer closed the connection');
      this._rejectAll(this._closeError);
    };
    this._onError = (err) => {
      this._closed = true;
      this._closeError = err;
      this._rejectAll(err);
    };

    socket.on('data', this._onData);
    socket.on('close', this._onClose);
    socket.on('error', this._onError);
  }

  clear() {
    this._buf = Buffer.alloc(0);
  }

  destroy() {
    this._socket.removeListener('data', this._onData);
    this._socket.removeListener('close', this._onClose);
    this._socket.removeListener('error', this._onError);
    this._rejectAll(new Error('FrameReader destroyed'));
  }

  _rejectAll(err) {
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  _drain() {
    while (this._waiters.length > 0) {
      const frame = this._tryExtractFrame();
      if (frame === null) return;
      const w = this._waiters.shift();
      clearTimeout(w.timer);
      w.resolve(frame);
    }
  }

  _tryExtractFrame() {
    const star = this._buf.indexOf(SYNC);
    if (star < 0) return null;
    const crlf = this._buf.indexOf(LINEBREAK, star + 1);
    if (crlf < 0) return null;
    const body = this._buf.subarray(star + 1, crlf);
    this._buf = this._buf.subarray(crlf + LINEBREAK.length);
    let decoded = crypto.decodePayload(body);
    let dEnd = decoded.length;
    while (dEnd > 0 && (decoded[dEnd - 1] === 0x0d || decoded[dEnd - 1] === 0x0a)) dEnd -= 1;
    return decoded.subarray(0, dEnd);
  }

  /**
   * Resolve with the next complete decoded frame body.
   * @param {number} timeoutMs
   * @returns {Promise<Buffer>}
   */
  nextFrame(timeoutMs = 10000) {
    if (this._closed) return Promise.reject(this._closeError || new Error('closed'));
    const immediate = this._tryExtractFrame();
    if (immediate !== null) return Promise.resolve(immediate);

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = this._waiters.indexOf(waiter);
        if (idx >= 0) this._waiters.splice(idx, 1);
        reject(new Error(`timeout waiting for frame after ${timeoutMs}ms`));
      }, timeoutMs);
      this._waiters.push(waiter);
    });
  }
}

/**
 * Encode and write one frame to a net.Socket.
 * @param {import('net').Socket} socket
 * @param {Buffer|string} payload
 * @param {number|null} key
 */
function sendFrame(socket, payload, key = null) {
  socket.write(wrap(payload, key));
}

module.exports = { SYNC, LINEBREAK, wrap, unwrap, FrameReader, sendFrame };
