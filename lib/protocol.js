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

// A frame is never larger than crypto.MAX_FRAME (1500 bytes), and idle
// periods only ever accumulate a handful of unread unsolicited @TF:
// broadcasts before a poll drains them -- this is a generous multiple
// of both. If a peer never sends a valid '*'...'\r\n' frame terminator
// at all, _buf would otherwise grow without bound off of whatever it
// keeps writing; treat exceeding this as a protocol error instead.
// The check counts leftover plus the new chunk before any frame is
// handed out, in both modes, so a single chunk of complete frames over
// this limit trips it too (theoretical with Jura's tiny frames).
const MAX_BUFFERED_BYTES = 64 * 1024;

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
 *
 * Two modes, picked once by the constructor's `opts` and never switched:
 *
 *   - pull (no `onFrame`): the behaviour described above. The caller
 *     asks for frames one at a time via nextFrame().
 *   - listener (`onFrame` set): every complete frame is pushed to
 *     `onFrame` in arrival order instead, and nextFrame() is refused.
 *     Each call sits in its own try/catch, so a throwing listener can
 *     never take the socket's event emitter (and with it the process)
 *     down, and never costs the frames queued behind it.
 *
 * `onClose` works in both modes and fires exactly once, with the FIRST
 * cause that ended the reader: the socket's 'error', the socket's
 * 'close', the MAX_BUFFERED_BYTES overflow, or destroy(). Later causes
 * (the usual 'error' followed by 'close', say) do not fire it again.
 */
class FrameReader {
  /**
   * @param {import('net').Socket} socket
   * @param {object} [opts]
   * @param {(frame: Buffer) => void} [opts.onFrame] Listener mode: called
   *   with each decoded frame body, in order, from inside the socket's
   *   'data' handler.
   * @param {(err: Error) => void} [opts.onClose] Called once, with the
   *   first cause that closed the reader. A throw from it is swallowed.
   * @param {(err: Error, frame: Buffer) => void} [opts.onListenerError]
   *   Called when `onFrame` throws, with that error and the frame it was
   *   handed. If this throws too, or is absent, the error is swallowed.
   */
  constructor(socket, opts = {}) {
    this._socket = socket;
    this._buf = Buffer.alloc(0);
    this._waiters = []; // { resolve, reject }
    // _closed / _closeError drive nextFrame() and _onData exactly as they
    // always did: set by the socket events only, and _closeError is
    // overwritten by a later event (error, then close). They are NOT the
    // public closed/closeError -- those track the first cause below, so
    // that pull-mode callers keep seeing the wording they always saw.
    this._closed = false;
    this._closeError = null;
    this._closeSeen = false;
    this._firstCloseError = null;
    this._silentError = null; // set by destroy(), see there
    this._frameListener = typeof opts.onFrame === 'function' ? opts.onFrame : null;
    this._closeListener = typeof opts.onClose === 'function' ? opts.onClose : null;
    this._errorListener =
      typeof opts.onListenerError === 'function' ? opts.onListenerError : null;

    this._onData = (chunk) => {
      if (this._closed) return;
      this._buf = Buffer.concat([this._buf, chunk]);
      if (this._buf.length > MAX_BUFFERED_BYTES) {
        const err = new Error(
          `receive buffer exceeded ${MAX_BUFFERED_BYTES} bytes without a complete frame`
        );
        this._buf = Buffer.alloc(0);
        this._closed = true;
        this._closeError = err;
        this._rejectAll(err);
        this._noteClose(err);
        this._socket.destroy(err);
        return;
      }
      if (this._frameListener !== null) {
        this._deliverFrames();
      } else {
        this._drain();
      }
    };
    this._onClose = () => {
      this._closed = true;
      this._closeError = new Error('peer closed the connection');
      this._rejectAll(this._closeError);
      this._noteClose(this._closeError);
    };
    this._onError = (err) => {
      this._closed = true;
      this._closeError = err;
      this._rejectAll(err);
      this._noteClose(err);
    };

    socket.on('data', this._onData);
    socket.on('close', this._onClose);
    socket.on('error', this._onError);
  }

  /** True once any cause (socket error/close, overflow, destroy()) has ended the reader. */
  get closed() {
    return this._closeSeen;
  }

  /** The FIRST cause that ended the reader, or null while it is still open. */
  get closeError() {
    return this._firstCloseError;
  }

  clear() {
    this._buf = Buffer.alloc(0);
  }

  /**
   * Detach from the socket and reject everyone still waiting.
   *
   * After removing its own listeners this leaves ONE silent 'error'
   * listener on the socket (once per reader, however often destroy() is
   * called). Removing our own 'error' listener would otherwise leave the
   * socket with none, and Node turns an 'error' event nobody listens for
   * into an uncaughtException. That is not hypothetical: the overflow
   * path calls socket.destroy(err), which fires 'error' a tick LATER, so
   * an onClose that calls destroy() in the meantime (a client cleaning up
   * after itself, say) would crash the process on an error that was
   * already handled.
   * The reader is finished by now, so a late socket error has nobody left
   * to report to and is dropped.
   */
  destroy() {
    this._socket.removeListener('data', this._onData);
    this._socket.removeListener('close', this._onClose);
    this._socket.removeListener('error', this._onError);
    if (this._silentError === null) {
      this._silentError = () => {};
      this._socket.on('error', this._silentError);
    }
    const err = new Error('FrameReader destroyed');
    this._rejectAll(err);
    this._noteClose(err);
  }

  /**
   * Record `err` as the first close cause and fire `onClose` with it.
   * Only the first call in a reader's lifetime does anything: every later
   * cause (error then close, an overflow's own follow-up 'error',
   * destroy() after the fact) returns at once, which is what makes
   * `onClose` fire exactly once. A throw from `onClose` is swallowed,
   * for the same reason a throwing onFrame is -- this runs inside socket
   * event handlers.
   * @param {Error} err
   */
  _noteClose(err) {
    if (this._closeSeen) return;
    this._closeSeen = true;
    this._firstCloseError = err;
    if (this._closeListener === null) return;
    try {
      this._closeListener(err);
    } catch {
      // onClose must never escape into the socket's event emitter
    }
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

  /**
   * Listener mode's counterpart of _drain(): hand every complete frame
   * in the buffer to `onFrame`, oldest first, until none is left.
   *
   * Each call has its own try/catch. A throw goes to `onListenerError`
   * (with the frame that caused it) when one was given; if that throws
   * as well, or there is none, the error is swallowed. Either way the
   * loop simply moves on to the next frame -- one bad frame or one buggy
   * listener neither drops the frames behind it nor escapes into the
   * socket's 'data' emitter as an uncaughtException.
   *
   * The loop also stops as soon as the reader is closed (a listener that
   * calls destroy() from inside onFrame, say), so nothing is delivered
   * after destroy() has returned.
   */
  _deliverFrames() {
    for (;;) {
      if (this._closeSeen) return;
      const frame = this._tryExtractFrame();
      if (frame === null) return;
      try {
        this._frameListener(frame);
      } catch (err) {
        if (this._errorListener !== null) {
          try {
            this._errorListener(err, frame);
          } catch {
            // onListenerError must not escape either
          }
        }
      }
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
   * Resolve with the next complete decoded frame body. Pull mode only:
   * with an `onFrame` listener set, frames are pushed to it and this
   * rejects at once, since two consumers of one stream would each miss
   * the frames the other took.
   * @param {number} timeoutMs
   * @returns {Promise<Buffer>}
   */
  nextFrame(timeoutMs = 10000) {
    if (this._frameListener !== null) {
      return Promise.reject(
        new Error('nextFrame() is not available when an onFrame listener is set')
      );
    }
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
