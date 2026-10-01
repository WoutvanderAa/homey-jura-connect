'use strict';

/**
 * TCP client for the Jura WiFi protocol.
 *
 * Ported from `client.py` in the `jura_connect` PyPI package. Handshake
 * matches the J.O.E. Android app's WifiCommandConnectionSetup:
 *
 *   -> @HP:<pin>,<conn_id_hex>,<auth_hash>\r\n
 *   <- @hp4                  CORRECT, no new hash
 *      @hp4:<hash>           CORRECT, persist <hash> for next time
 *      @hp5 / @hp5:00        WRONG_PIN  -- machine wants a PIN, none given
 *      @hp5:01               WRONG_HASH -- conn-id unknown / hash stale
 *      @hp5:02               ABORTED    -- machine refused
 *
 * Initial pairing on a machine without a PIN configured:
 *   1. Open a TCP session, send `@HP:,<conn_id_hex>,` (pin and hash empty).
 *   2. The coffee machine pops up a "Connect" dialog on its own display.
 *   3. The user presses OK on the machine.
 *   4. The machine replies `@hp4:<hash>` carrying a 64-hex-char auth
 *      token -- persist it and pass it as auth_hash next time to skip
 *      the on-machine confirmation.
 */

const net = require('net');
const crypto = require('crypto');
const protocol = require('./protocol');
const profileLib = require('./profile');

const DEFAULT_PORT = 51515;
const DEFAULT_CONN_ID = 'jura-connect-homey';
const DEFAULT_PAIR_TIMEOUT_MS = 60000;

// The dongle pushes an unsolicited @TF:/@TV: status frame roughly every
// 2s while connected, and neither _doHandshake nor _requestOnce ever
// trimmed statusHistory -- left unbounded, it grows for as long as the
// connection stays open (hours, on a device that's rarely power-cycled).
// Nothing in this app reads more than the latest few frames, so cap it
// and drop the oldest once it's full (see _recordStatus below).
const STATUS_HISTORY_MAX = 50;

function connIdHex(connId) {
  let out = '';
  for (let i = 0; i < connId.length; i++) {
    out += (connId.charCodeAt(i) & 0xff).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function randomConnId() {
  return `jura-connect-homey-${crypto.randomBytes(4).toString('hex')}`;
}

class HandshakeError extends Error {}
class PairingTimeout extends HandshakeError {}

/**
 * brew()'s own error shape -- always has a `code` so callers (device.js)
 * can translate to a user-facing message without parsing `message` text.
 * @param {'BREW_NO_REPLY'|'BREW_REFUSED'|'BREW_CONNECTION_LOST'} code
 *   BREW_NO_REPLY: no @tp/@an reply and no @TB within the timeout.
 *   BREW_REFUSED: the machine answered but did not accept (see isBrewAccept).
 *     `reply` carries the machine's own wire reply, e.g. '@tp:00'.
 *   BREW_CONNECTION_LOST: the connection dropped while waiting for a reply
 *     (not connected, the peer closed it, or the reader was destroyed).
 * @param {{reply?: string}} [details]
 */
class BrewError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.code = code;
    if (details.reply !== undefined) this.reply = details.reply;
  }
}

/**
 * readStatus()'s own error when the deadline runs out without a new @TF:
 * but other frames did arrive in the meantime -- see _readStatusOnce's own
 * doc comment for why that counts as "busy", not "disconnected". `code`
 * is always 'STATUS_BUSY' so callers (device.js's _poll()) can tell this
 * apart from a genuine timeout without parsing `message` text, same as
 * BrewError above.
 * @param {string} message
 * @param {number} otherFrames  how many non-@TF: frames arrived while waiting,
 *   plus those that arrived between operations since the previous readStatus()
 * @param {object|null} [lastStatus]  the newest status this client has seen
 *   (parsed, with `receivedAt` and `ageMs`), which readStatus() already
 *   handed out earlier -- or null when no @TF: has been seen at all
 * @param {number|null} [lastStatusAgeMs]  how old `lastStatus` is, or null
 */
class StatusUnavailable extends Error {
  constructor(message, otherFrames, lastStatus = null, lastStatusAgeMs = null) {
    super(message);
    this.name = 'StatusUnavailable';
    this.code = 'STATUS_BUSY';
    this.otherFrames = otherFrames;
    this.lastStatus = lastStatus;
    this.lastStatusAgeMs = lastStatusAgeMs;
  }
}

function classifyHandshakeReply(reply) {
  const m = /^@hp([45])(?::(.*))?$/.exec(reply.trim());
  if (!m) throw new HandshakeError(`unexpected handshake reply: ${JSON.stringify(reply)}`);
  const major = m[1];
  const rest = m[2];
  if (major === '4') return { code: reply.trim(), state: 'CORRECT', newHash: rest || null };
  const c = rest || '';
  let state;
  if (c === '' || c === '00') state = 'WRONG_PIN';
  else if (c === '01') state = 'WRONG_HASH';
  else if (c === '02') state = 'ABORTED';
  else state = `REJECTED:${c}`;
  return { code: reply.trim(), state, newHash: null };
}

/** True when a @TP: reply means the machine accepted the brew (not @tp:00). */
function isBrewAccept(reply) {
  const r = reply.trim().toLowerCase();
  return r.startsWith('@tp') && !r.startsWith('@tp:00');
}

// A bare, two-letter marker frame the dongle pushes unprompted around a
// brew (@TB start, @TS stop) -- ported from jura_connect 0.13.1's own
// marker regex (`_MARKER_FRAME_RE` in its client module). Treated like a
// status push everywhere a caller doesn't specifically ask for one:
// skipped and recorded via _recordStatus, same as @TF:/@TV:, unless the
// caller's own matcher explicitly matches it (see _sendBrewAndWait and
// _waitForFreshTB below, which do ask for @TB specifically).
const MARKER_FRAME_RE = /^@[A-Z]{2}$/;

// The dongle's own reply prefix to @TP: -- @tp/@tp:xx on acceptance or
// rejection, @an:... when it refuses outright (ported from jura_connect
// 0.13.1's own `BREW_REPLY_MATCH`).
const BREW_REPLY_MATCH = /^@(?:tp|an)\b/i;

// The dongle's reply to @HU? (@hu:800 on the E8) -- readStatus() treats it
// as the proof that the @HU? it sent has been answered, see _readStatusOnce.
const HU_REPLY_MATCH = /^@hu\b/i;

// How long readStatus() keeps waiting for the @hu: once it has a status to
// hand out: a @TF: that came in first, or one that was already waiting when
// the @HU? went out. TCP delivers in order, so when the @hu: is here, every
// @TF: the machine sent before answering has been seen too; handing out the
// status at once could return one that is already behind a burst still on
// the wire. A short wait buys that ordering. It is bounded rather than
// "until the @hu:" because firmware that never answers @HU? (unmeasured, V5)
// would otherwise make a poll that already has a status wait for its full
// timeout (8s in device.js), and a brew() queued behind that poll just as
// long. The price: an @hu: slower than this arrives between operations, and
// counts there as a sign of life and as a dropped reply.
// It bounds only polls that have a status to hand out. With no new @TF: and
// no @hu: -- the machine's @TF: broadcast pauses mid-brew, and whether it
// still answers @HU? then is unmeasured (V5) -- a poll lasts its full
// timeout, same as in 0.12.2.
const STATUS_SETTLE_MS = 50;

// Pause before brew()'s single retry. An option with this as its default
// (not a hardcoded literal) so tests can scale it down -- see brew()'s own
// doc comment for what the pause is actually waiting to find out.
const BREW_RETRY_DELAY_MS = 3000;

// How long, right after brew() sees an accept, to keep listening (without
// sending anything) for that accept's own counterpart frame -- a pushed
// @TB after an accepting @tp reply, or an @tp reply after a fresh @TB.
// Left uncollected, that counterpart is routed to whichever operation is
// running when it arrives (another brew() call, a poll, ...), which can
// stumble into it and misread it as its own answer -- reproduced with two
// brew() calls back to back, the second queued while the first is still
// finishing. (One that arrives between operations is harmless: the frame
// router records or drops it, see _consumeIdle.) An option so tests can
// scale it.
const BREW_ACCEPT_GRACE_MS = 1500;

// Status bit -> [name, severity] fallback table (EF536 baseline). Prefer
// the profile-specific ALERTS table (lib/profiles/*.js) when available --
// see MachineStatus.parse below.
const FALLBACK_STATUS_BITS = {
  0: ['insert_tray', 'error'],
  1: ['fill_water', 'error'],
  2: ['empty_grounds', 'error'],
  3: ['empty_tray', 'error'],
  10: ['no_beans', 'info'],
  12: ['heating_up', 'info'],
  13: ['coffee_ready', 'info'],
};

class MachineStatus {
  /**
   * Parse an @TF:<hex> reply into named alert bits.
   * @param {string} reply
   * @param {{alerts: {bit:number, name:string, severity:string}[]}|null} profile
   */
  static parse(reply, profile = null) {
    const body = reply.trim();
    if (!body.toLowerCase().startsWith('@tf:')) {
      throw new Error(`@TF: reply expected, got ${JSON.stringify(reply)}`);
    }
    const data = Buffer.from(body.slice(4), 'hex');
    const active = [];
    const errors = [];
    const info = [];
    const process_ = [];

    let bits;
    if (profile && profile.alerts && profile.alerts.length) {
      bits = {};
      for (const a of profile.alerts) bits[a.bit] = [a.name, a.severity];
    } else {
      bits = FALLBACK_STATUS_BITS;
    }

    for (const [bitIndexStr, [name, severity]] of Object.entries(bits)) {
      const bitIndex = Number(bitIndexStr);
      const byteI = Math.floor(bitIndex / 8);
      const bitInByte = bitIndex % 8;
      if (byteI < data.length && ((data[byteI] >> (7 - bitInByte)) & 1)) {
        active.push(name);
        if (severity === 'error') errors.push(name);
        else if (severity === 'process') process_.push(name);
        else info.push(name);
      }
    }
    return {
      raw: data,
      rawHex: data.toString('hex').toUpperCase(),
      activeAlerts: active,
      errors,
      info,
      process: process_,
    };
  }
}

/**
 * Decoded @TG:C0 reply -- one byte per maintenance type, 0..100 (percent
 * until due), or 0xFF if the machine doesn't track that type. Field
 * order/meaning ported from jura_connect's MaintenancePercent, and
 * confirmed to match the E8 (EF533V2)'s own XML bank definition
 * (<BANK Command="@TG:C0"> lists Cleaning, FilterChange, Decalc in
 * that order).
 */
class MaintenancePercent {
  static parse(reply) {
    const body = reply.trim();
    const prefix = '@tg:c0';
    if (!body.toLowerCase().startsWith(prefix)) {
      throw new Error(`@TG:C0 reply expected, got ${JSON.stringify(reply)}`);
    }
    let hexPart = body.slice(prefix.length);
    if (hexPart.length % 2 !== 0) hexPart += '0';
    const data = Buffer.from(hexPart, 'hex');
    if (data.length < 3) {
      throw new Error(`@TG:C0 payload too short (${data.length} bytes): ${JSON.stringify(reply)}`);
    }
    return {
      cleaning: data[0],
      filterChange: data[1],
      descale: data[2],
      raw: data,
      rawHex: data.toString('hex').toUpperCase(),
    };
  }
}

/**
 * Decoded page 0 of the paginated @TR:32 per-product brew-counter bank.
 * The full bank is 16 pages of 4 u16 slots each (64 slots total), but we
 * only ever request page 0: slot 0 (the first u16 of that page) is the
 * machine's own lifetime brew total, model-independent -- ported from
 * jura_connect 0.13.1's ProductCounters ("Slot 0 carries the total
 * number of brews ever performed"). The other 63 slots hold per-product
 * counts indexed by product code (plus a documented remap quirk on at
 * least one profile), which would need per-model mapping to surface
 * meaningfully -- not worth the complexity for a single lifetime-total
 * settings-page stat.
 *
 * Wire reply: `@tr:32,00,<8 bytes hex>`, or a bare `@tr:00` when the
 * machine doesn't implement this bank at all.
 */
class ProductCounterTotal {
  static parse(reply) {
    const body = reply.trim();
    if (/^@tr:00/i.test(body)) {
      throw new Error('machine does not implement the @TR:32 counter bank');
    }
    const parts = body.split(',');
    if (parts.length < 3 || !/^@tr:32$/i.test(parts[0]) || parts[1] !== '00') {
      throw new Error(`@TR:32,00 reply expected, got ${JSON.stringify(reply)}`);
    }
    const data = Buffer.from(parts[2], 'hex');
    if (data.length < 2) {
      throw new Error(`@TR:32,00 payload too short (${data.length} bytes): ${JSON.stringify(reply)}`);
    }
    return data.readUInt16BE(0);
  }
}

class JuraClient {
  /**
   * @param {string} address
   * @param {object} opts
   * @param {number} [opts.port]
   * @param {string} [opts.pin]
   * @param {string} [opts.connId]
   * @param {string} [opts.authHash]
   * @param {number} [opts.connectTimeoutMs]
   * @param {number} [opts.readTimeoutMs]
   * @param {object} [opts.profile] result of profileLib.getProfile()
   */
  constructor(address, opts = {}) {
    this.address = address;
    this.port = opts.port || DEFAULT_PORT;
    this.pin = opts.pin || '';
    this.connId = opts.connId || DEFAULT_CONN_ID;
    this.authHash = opts.authHash || '';
    this.connectTimeoutMs = opts.connectTimeoutMs || 5000;
    this.readTimeoutMs = opts.readTimeoutMs || 10000;
    this.profile = opts.profile || null;

    this._socket = null;
    this._reader = null;
    this.handshake = null;
    this.statusHistory = [];
    this._queue = Promise.resolve();

    // Frame router state, see _onFrame. `_op` is the inbox of the operation
    // that is running right now (null between operations), `droppedReplies`
    // counts replies that arrived with nobody waiting for them, and
    // `lastCloseReason` is the FIRST cause the FrameReader reported for the
    // end of the connection (set by _onReaderClosed). `_idleNonStatusFrames`
    // counts every frame other than a @TF: that arrived with no operation
    // running (or was left over in an inbox) since the last readStatus()
    // ended -- see _consumeIdle and _readStatusOnce for what it is for.
    // `_statusSeq` numbers the @TF: broadcasts (see _observe) and
    // `_lastReturnedSeq` is the number of the one readStatus() handed out
    // last: when the first is ahead of the second, a newer status is waiting.
    this._op = null;
    this.lastCloseReason = null;
    this.lastFrameAt = null;
    this.latestStatus = null;
    this.droppedReplies = 0;
    this._idleNonStatusFrames = 0;
    this._statusSeq = 0;
    this._lastReturnedSeq = 0;
  }

  get connected() {
    return this._socket !== null;
  }

  /**
   * Serialize every write-then-wait-for-a-reply operation (connect, pair,
   * request, readStatus, brew) through this one instance. Two such
   * operations racing on the same connection would each be handed
   * whichever frame arrived next -- not necessarily the frame that is
   * actually answering their own command. A poll cycle's @HU? and a
   * flow-triggered brew()'s @TP: both in flight at once could otherwise
   * steal each other's reply; confirmed via a real report where brew() got
   * handed a stray status reply and reported the brew rejected even though
   * the machine had genuinely accepted and brewed it. Queuing means only
   * one write+wait cycle is ever outstanding per client, so this can't
   * happen.
   *
   * The same queue also decides what "an operation is running" means for
   * the frame router (see _onFrame). While `fn` runs, `this._op` holds that
   * operation's own inbox, and every frame the reader delivers lands there
   * for fn's _nextFrame() calls to pick up. When `fn` settles -- resolved
   * or thrown -- the inbox is torn down and whatever was never picked up
   * goes through _consumeIdle, exactly like a frame that arrives between
   * operations. Nothing is ever carried over from one operation into the
   * next one.
   */
  _enqueue(fn) {
    const op = async () => {
      this._op = { inbox: [], waiter: null };
      try {
        return await fn();
      } finally {
        const { inbox } = this._op;
        this._op = null;
        for (const frame of inbox) this._consumeIdle(frame.toString('ascii'));
      }
    };
    const run = this._queue.then(op, op);
    this._queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Keep per-frame bookkeeping in this one place: when the last frame of
   * any kind arrived, and the newest @TF: status broadcast together with
   * its arrival time and a running number (`_statusSeq`, raised by every
   * @TF:). Called by _onFrame for every frame, before it is routed
   * anywhere, so what it records never depends on which operation (if any)
   * happens to be running. Nothing else is done here yet.
   * @param {string} reply
   */
  _observe(reply) {
    const now = Date.now();
    this.lastFrameAt = now;
    if (reply.startsWith('@TF:')) {
      this._statusSeq += 1;
      this.latestStatus = { reply, at: now };
    }
  }

  /**
   * The newest @TF: status seen so far, parsed -- the one readStatus()
   * hands out -- with `receivedAt` (when it arrived, ms timestamp) and
   * `ageMs` (how old it is right now) added. Null when no @TF: has been
   * seen on this client yet. Only reads: `_lastReturnedSeq` is moved by
   * _readStatusOnce, and nothing is recorded in statusHistory here (the
   * frame already was, wherever it was consumed).
   */
  _latestParsedStatus() {
    if (!this.latestStatus) return null;
    const { reply, at } = this.latestStatus;
    return Object.assign(MachineStatus.parse(reply, this.profile), {
      receivedAt: at,
      ageMs: Date.now() - at,
    });
  }

  /**
   * The FrameReader's listener: every complete frame arrives here, in
   * order, the moment it has been read off the socket.
   *
   * It is observed first (_observe). Then, while an operation is running
   * (this._op, set in _enqueue), the frame goes to that operation: handed
   * straight to the pending _nextFrame() waiter, or parked in the
   * operation's inbox when nobody is waiting at that instant. With no
   * operation running, nobody asked for it -- see _consumeIdle.
   * @param {Buffer} frame
   */
  _onFrame(frame) {
    const reply = frame.toString('ascii');
    this._observe(reply);
    const op = this._op;
    if (!op) {
      this._consumeIdle(reply);
      return;
    }
    const waiter = op.waiter;
    if (waiter) {
      op.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      op.inbox.push(frame);
    }
  }

  /**
   * A frame nobody is waiting for. Pushes -- @TF:, @TV: and bare markers
   * (MARKER_FRAME_RE) -- are recorded via _recordStatus, same treatment
   * every operation gives them. Anything else is a reply to a command
   * that has already given up (a late @hu:800, say), or one that was never
   * ours: counted in `droppedReplies` and thrown away, so it can never be
   * mistaken for the answer to a later command.
   *
   * Either way, every frame other than a @TF: is also counted in
   * `_idleNonStatusFrames`: it is proof the connection is alive, which
   * the next readStatus() needs when the machine's @TF: broadcast pauses
   * (see _readStatusOnce). Before the frame router such frames simply sat
   * in the read buffer until that poll counted them.
   * @param {string} reply
   */
  _consumeIdle(reply) {
    if (!reply.startsWith('@TF:')) this._idleNonStatusFrames += 1;
    if (reply.startsWith('@TF:') || reply.startsWith('@TV:') || MARKER_FRAME_RE.test(reply)) {
      this._recordStatus(reply);
      return;
    }
    this.droppedReplies += 1;
  }

  /**
   * Wait for the next frame of the running operation: the same contract
   * FrameReader.nextFrame() had in pull mode, which every read loop in
   * this class still relies on. Resolves with the frame as a Buffer,
   * oldest first -- the operation's inbox before anything still to come.
   * Rejects with:
   *  - `not connected` when there is no reader at all;
   *  - the reason the connection ended (`lastCloseReason`) when the reader
   *    is already closed, or closes while this call is waiting;
   *  - exactly `timeout waiting for frame after ${timeoutMs}ms` when
   *    nothing arrives in time. A `timeoutMs` of 0 therefore resolves with
   *    a frame that is already in the inbox and rejects with that same
   *    timeout otherwise, which is what _drainBuffered relies on.
   * An operation awaits one frame at a time, so there is never more than
   * one waiter.
   * @param {number} timeoutMs
   * @returns {Promise<Buffer>}
   */
  _nextFrame(timeoutMs) {
    if (!this._reader) return Promise.reject(new Error('not connected'));
    if (this._reader.closed) {
      return Promise.reject(this.lastCloseReason || new Error('closed'));
    }
    const op = this._op;
    if (!op) return Promise.reject(new Error('no operation is running'));
    if (op.inbox.length > 0) return Promise.resolve(op.inbox.shift());

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        if (op.waiter === waiter) op.waiter = null;
        reject(new Error(`timeout waiting for frame after ${timeoutMs}ms`));
      }, timeoutMs);
      op.waiter = waiter;
    });
  }

  /**
   * The FrameReader's onClose: called once, with the first cause that
   * ended the connection (socket error, peer close, receive-buffer
   * overflow, or our own destroy() in close()). Keeps that cause in
   * `lastCloseReason` and rejects the running operation's pending
   * _nextFrame() waiter with it, if there is one. Every later
   * _nextFrame() call is refused up front, see there.
   * @param {Error} err
   */
  _onReaderClosed(err) {
    this.lastCloseReason = err;
    const op = this._op;
    if (op && op.waiter) {
      const waiter = op.waiter;
      op.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  /**
   * Append a status frame to statusHistory, dropping the oldest one
   * once past STATUS_HISTORY_MAX -- see that constant's own comment for
   * why this needs a cap at all.
   * @param {string} reply
   */
  _recordStatus(reply) {
    this.statusHistory.push(reply);
    if (this.statusHistory.length > STATUS_HISTORY_MAX) this.statusHistory.shift();
  }

  _rawConnect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({
        host: this.address,
        port: this.port,
        timeout: this.connectTimeoutMs,
      });
      const onConnect = () => {
        sock.setTimeout(0); // hand timeout control to per-op logic below
        sock.setNoDelay(true);
        sock.removeListener('error', onError);
        this._socket = sock;
        // Listener mode: the reader pushes every frame to _onFrame instead of
        // waiting to be asked. The callbacks are bound to THIS reader and
        // ignore anything once it is no longer this._reader: connect() called
        // twice without a close() in between leaves the first reader (and its
        // socket) alive, and its frames or its eventual FIN must not be routed
        // into, or reject, an operation running on the new connection.
        // onListenerError logs the message ONLY, never the frame -- a frame
        // can carry secrets (handshake replies, the auth hash), and this
        // class has no logger or redaction yet.
        const reader = new protocol.FrameReader(sock, {
          onFrame: (f) => {
            if (this._reader === reader) this._onFrame(f);
          },
          onClose: (err) => {
            if (this._reader === reader) this._onReaderClosed(err);
          },
          onListenerError: (err) => {
            console.error('[juraClient] frame listener failed:', err.message);
          },
        });
        this._reader = reader;
        resolve();
      };
      const onError = (err) => reject(err);
      sock.once('connect', onConnect);
      sock.once('error', onError);
      sock.once('timeout', () => {
        sock.destroy();
        reject(new Error(`connect timeout after ${this.connectTimeoutMs}ms`));
      });
    });
  }

  async _doHandshake(timeoutMs) {
    const cmd = `@HP:${this.pin},${connIdHex(this.connId)},${this.authHash}`;
    this._socket.write(protocol.wrap(cmd));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new PairingTimeout(
          `no @hp4/@hp5 reply within ${timeoutMs}ms — did the user accept on the machine?`
        );
      }
      let frame;
      try {
        frame = await this._nextFrame(remaining);
      } catch (e) {
        throw new PairingTimeout(`no @hp4/@hp5 reply within ${timeoutMs}ms`);
      }
      const reply = frame.toString('ascii');
      if (reply.startsWith('@TF:') || reply.startsWith('@TV:') || MARKER_FRAME_RE.test(reply)) {
        this._recordStatus(reply);
        continue;
      }
      const result = classifyHandshakeReply(reply);
      if (result.state === 'CORRECT' && result.newHash) this.authHash = result.newHash;
      this.handshake = result;
      return result;
    }
  }

  /** Open the TCP session and run @HP: with a short timeout (known auth_hash). */
  async connect(timeoutMs = 15000) {
    return this._enqueue(async () => {
      await this._rawConnect();
      return this._doHandshake(timeoutMs);
    });
  }

  /**
   * Run the initial pairing flow (no auth hash yet). Blocks up to
   * `timeoutMs` while the user accepts the on-machine "Connect?" prompt.
   * @param {number} timeoutMs
   * @param {(msg: string) => void} [onUserPrompt]
   */
  async pair(timeoutMs = DEFAULT_PAIR_TIMEOUT_MS, onUserPrompt = null) {
    // Queued like connect(): the handshake frames only reach _doHandshake
    // through the running operation's inbox (see _enqueue/_onFrame).
    return this._enqueue(async () => {
      this.authHash = '';
      await this._rawConnect();
      if (onUserPrompt) {
        onUserPrompt(
          `Coffee machine should be showing a "Connect" prompt — confirm it on the machine's own display to accept (the exact button varies by model: often OK/checkmark, on some models the bean button) (waiting up to ${Math.round(timeoutMs / 1000)}s).`
        );
      }
      return this._doHandshake(timeoutMs);
    });
  }

  async close() {
    if (this._socket) {
      try {
        // Polite close: an empty frame, the same thing the J.O.E. app's
        // WifiCommandCloseConnection sends (and jura_connect 0.13.1's own
        // close()). @HE is NOT a close command -- it's WifiCommandOTAEnd,
        // the firmware-update end command that makes the dongle apply an
        // OTA image.
        this._socket.write(protocol.wrap(''));
      } catch {
        // best-effort polite close
      }
      try {
        // destroy() fires the reader's onClose (_onReaderClosed), which also
        // rejects the waiter of an operation still running.
        this._reader.destroy();
      } catch {
        // ignore
      }
      this._socket.destroy();
    }
    this._socket = null;
    this._reader = null;
  }

  /** Fire-and-forget command (no response wait). */
  sendCommand(cmd) {
    if (!this._socket) throw new Error('not connected');
    this._socket.write(protocol.wrap(cmd));
  }

  /**
   * Send `cmd` and return the first reply matching `matchRe`. A matcher is
   * required: without one, "the first non-status reply" is exactly the
   * guess that lets a stray frame pass for the answer, so a missing
   * matcher throws. @TF:/@TV: status frames and bare markers (@TB, @TS,
   * ...) seen along the way are appended to statusHistory instead of being
   * returned, unless `matchRe` itself asks for one of them.
   * @param {string} cmd
   * @param {RegExp} matchRe
   * @param {number} timeoutMs
   */
  async request(cmd, matchRe, timeoutMs = 6000) {
    if (!matchRe) throw new Error('request() needs a matcher');
    return this._enqueue(() => this._requestOnce(cmd, matchRe, timeoutMs));
  }

  async _requestOnce(cmd, matchRe, timeoutMs) {
    if (!this._socket) throw new Error('not connected');
    this._socket.write(protocol.wrap(cmd));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no reply to ${JSON.stringify(cmd)} within ${timeoutMs}ms`);
      const frame = await this._nextFrame(remaining);
      const reply = frame.toString('ascii');
      // Pushes -- status frames and bare markers alike -- are recorded and
      // skipped by default, same treatment as @TF:/@TV: always got. Only
      // returned if the caller's own matcher explicitly wants this exact
      // frame.
      if (reply.startsWith('@TF:') || reply.startsWith('@TV:') || MARKER_FRAME_RE.test(reply)) {
        this._recordStatus(reply);
        if (matchRe.test(reply)) return reply;
        continue;
      }
      if (matchRe.test(reply)) return reply;
    }
  }

  /**
   * Send @HU? (the keep-alive) and return the NEWEST @TF: status broadcast
   * the machine has sent since the previous successful readStatus() --
   * parsed, with `receivedAt` and `ageMs` added -- even when it arrived
   * between operations or during a brew. Throws StatusUnavailable (code
   * STATUS_BUSY) when no new @TF: came but other frames did -- see
   * _readStatusOnce.
   *
   * Whatever way this ends (a status, busy, any error) the count of frames
   * that arrived between operations is reset in the `finally` below, never
   * at the start: at the start it would throw away exactly the frames
   * since the previous readStatus() that the count exists to carry over.
   * The `finally` sits INSIDE the queued function on purpose. _enqueue
   * feeds whatever this operation left in its inbox to _consumeIdle only
   * after the function has settled, so those leftovers are counted after
   * the reset and carry over to the next readStatus(), as they should.
   */
  async readStatus(timeoutMs = 6000) {
    return this._enqueue(async () => {
      try {
        return await this._readStatusOnce(timeoutMs);
      } finally {
        this._idleNonStatusFrames = 0;
      }
    });
  }

  /**
   * readStatus()'s own read loop, split out from readStatus so it can be
   * queued via _enqueue like every other write-then-wait operation.
   *
   * Sends @HU? -- also the keep-alive -- and then waits for the first of:
   * the machine's @hu: answer, a @TF: that arrives after the send, or the
   * deadline. TCP delivers in order, so by the time the @hu: is here every
   * @TF: the machine sent before answering has been observed (see
   * _observe). If `_statusSeq` is then ahead of `_lastReturnedSeq`, a @TF:
   * came in since the previous successful readStatus() -- also one that
   * arrived between operations or in the middle of a brew -- and the NEWEST
   * one is returned, not the oldest. That keeps the status from lagging
   * behind the broadcasts, and a poll no longer has to sit out the next
   * ~2s broadcast just because the last one was already consumed. With
   * nothing new yet, the wait goes on until the deadline for the next @TF:.
   * So a poll ends early only when the @hu: comes, when a status is already
   * waiting, or when a @TF: arrives; a @TF: pause without any of those
   * lasts the full timeout, same as in 0.12.2.
   *
   * Having a status to hand out does not end the wait at once: the rest of
   * a burst may still be on the wire, and only the @hu: proves it is not.
   * So once a @TF: has arrived before the @hu:, or a fresh status was
   * already waiting when @HU? went out, the loop waits for the @hu: for at
   * most STATUS_SETTLE_MS (see there, also for what a slower @hu: costs),
   * and then goes ahead without it.
   *
   * Confirmed live: while the machine is mid-brew, its unsolicited @TF:
   * broadcast pauses for a long stretch (~52s, upstream measured) and
   * @TV: progress frames take over the cadence instead -- see upstream
   * docs/PROTOCOL.md, "Frame cadence during a brew". A poll landing in
   * that window used to time out waiting for a @TF: that simply wasn't
   * coming, and _poll() (drivers/jura-machine/device.js) would tear down
   * a perfectly healthy connection over it. Whether the machine still
   * answers @HU? during that pause is unmeasured (V5). Either way, the
   * @TV: progress frames and markers it keeps sending are frames too -- so
   * any frame at all besides the @TF: we're actually waiting for is proof
   * the connection is alive and just busy, not dead. Counted in `otherFrames`
   * below and used to throw StatusUnavailable (busy) instead of a plain
   * timeout Error (actually unreachable) once the deadline runs out; that
   * error carries the newest status we do have (`lastStatus`, with its
   * age) so the caller can see how stale it is.
   *
   * Frames that arrived BEFORE this poll started count as well. Those
   * that came in between operations never reach this loop (the frame
   * router sends them to _consumeIdle), so _consumeIdle keeps their count
   * in `_idleNonStatusFrames` and the deadline adds it to `otherFrames`.
   * Without that, a machine that does not answer @HU? mid-brew and whose
   * @TV: progress frames all landed between two polls would give a bare
   * timeout, and _poll() would close a healthy connection -- the very
   * thing the paragraph above describes. The sum is what ends up in
   * StatusUnavailable.otherFrames and in its message. The count is reset
   * by readStatus(), not here.
   *
   * Only this operation's own inbox is read, so no frame another
   * operation needs is ever taken away from it.
   * @param {number} timeoutMs
   */
  async _readStatusOnce(timeoutMs) {
    if (!this._socket) throw new Error('not connected');
    this._socket.write(protocol.wrap('@HU?'));
    const deadline = Date.now() + timeoutMs;
    let otherFrames = 0;
    let answered = false; // the @hu: came in, or the settle time ran out
    let settleUntil = null; // see STATUS_SETTLE_MS
    // A fresh status is already waiting (it came in between operations or
    // during a brew): start the settle time now, not at a @TF: that may
    // never come -- a machine that does not answer @HU? would otherwise
    // keep this poll, and a brew() queued behind it, waiting for the
    // deadline.
    if (this._statusSeq > this._lastReturnedSeq) settleUntil = Date.now() + STATUS_SETTLE_MS;

    const timeoutError = () => {
      const sawFrames = otherFrames + this._idleNonStatusFrames;
      if (sawFrames === 0) return new Error(`no reply to "@HU?" within ${timeoutMs}ms`);
      const lastStatus = this._latestParsedStatus();
      return new StatusUnavailable(
        `no @TF: status frame within ${timeoutMs}ms, but the machine sent ${sawFrames} other frame(s) -- most likely busy brewing`,
        sawFrames,
        lastStatus,
        lastStatus ? lastStatus.ageMs : null
      );
    };

    // The newest status when a @TF: came in since the one handed out last,
    // else null. Taking it moves `_lastReturnedSeq`; statusHistory is left
    // alone, the frame was recorded where it was consumed.
    const takeNewStatus = () => {
      if (this._statusSeq <= this._lastReturnedSeq) return null;
      this._lastReturnedSeq = this._statusSeq;
      return this._latestParsedStatus();
    };

    // A @TF: that arrived since the previous readStatus() still counts at
    // the deadline, even if the @hu: never came.
    const atDeadline = () => {
      const status = takeNewStatus();
      if (status) return status;
      throw timeoutError();
    };

    for (;;) {
      if (answered) {
        const status = takeNewStatus();
        if (status) return status;
      }
      // While settling (a @TF: seen, no @hu: yet) the wait ends at the
      // settle time instead of the deadline, whichever comes first.
      const settling = settleUntil !== null && !answered && settleUntil < deadline;
      const remaining = (settling ? settleUntil : deadline) - Date.now();
      if (remaining <= 0) {
        if (settling) {
          answered = true;
          continue;
        }
        return atDeadline();
      }
      let frame;
      try {
        frame = await this._nextFrame(remaining);
      } catch (err) {
        if (/^timeout waiting for frame/.test(err.message)) {
          if (settling) {
            answered = true;
            continue;
          }
          return atDeadline();
        }
        throw err;
      }
      const reply = frame.toString('ascii');
      if (reply.startsWith('@TF:')) {
        this._recordStatus(reply);
        if (settleUntil === null) settleUntil = Date.now() + STATUS_SETTLE_MS;
        continue;
      }
      if (reply.startsWith('@TV:') || MARKER_FRAME_RE.test(reply)) {
        this._recordStatus(reply);
      } else if (HU_REPLY_MATCH.test(reply)) {
        answered = true;
      }
      otherFrames += 1;
    }
  }

  /** Read the maintenance counter bank (@TG:43) as a raw hex string. */
  async readMaintenanceCounterRaw(timeoutMs = 6000) {
    return this.request('@TG:43', /^@tg:43/i, timeoutMs);
  }

  /**
   * Read percent-until-due for cleaning/filter/descale (@TG:C0).
   * Not every profile's XML lists this bank -- callers should expect
   * this to reject on machines that don't support it.
   */
  async readMaintenancePercent(timeoutMs = 6000) {
    const reply = await this.request('@TG:C0', /^@tg:c0/i, timeoutMs);
    return MaintenancePercent.parse(reply);
  }

  /**
   * Read the machine's lifetime brew total (page 0 of the paginated
   * @TR:32 product-counter bank -- see ProductCounterTotal). Not every
   * profile's firmware implements this bank; callers should expect
   * this to reject on machines that don't support it.
   */
  async readTotalBrewCount(timeoutMs = 6000) {
    const reply = await this.request('@TR:32,00', /^(@tr:32,00|@tr:00)/i, timeoutMs);
    return ProductCounterTotal.parse(reply);
  }

  /**
   * Drain whatever frames are already waiting in this operation's inbox,
   * without waiting for any new ones to arrive -- run right before writing
   * a fresh @TP: so a leftover reply from an earlier exchange (e.g. a
   * stale @hu:800 that arrived after its own request had already moved on
   * and returned) or an old @TB from a brew that isn't this one is much
   * less likely to be mistaken for the answer to THIS command. Frames that
   * arrive between operations never get this far -- the frame router sends
   * them to _consumeIdle -- so the inbox of a brew() that has only just
   * started will usually be empty, and this is a cheap safety net. This
   * only covers frames already waiting *before* this call -- a frame that
   * is this command's own accept plus its counterpart is handled
   * separately, see _swallowCounterpart. Status/marker frames drained this
   * way are still recorded via _recordStatus; anything else is simply
   * discarded, which is the whole point.
   */
  async _drainBuffered() {
    if (!this._reader) return; // not connected -- nothing to drain
    for (;;) {
      let frame;
      try {
        frame = await this._nextFrame(0);
      } catch {
        return; // nothing left already buffered
      }
      const reply = frame.toString('ascii');
      if (reply.startsWith('@TF:') || reply.startsWith('@TV:') || MARKER_FRAME_RE.test(reply)) {
        this._recordStatus(reply);
      }
    }
  }

  /**
   * Classify a nextFrame() rejection while waiting for a brew reply: its
   * own timeout (nothing arrived at all) becomes BREW_NO_REPLY, anything
   * else (the reader closed or was destroyed) becomes BREW_CONNECTION_LOST
   * -- never lets FrameReader's own wording ("timeout waiting for frame
   * after Nms") reach a caller directly.
   * @param {Error} err
   * @param {number} timeoutMs
   * @returns {BrewError}
   */
  _brewWaitError(err, timeoutMs) {
    if (/^timeout waiting for frame/.test(err.message)) {
      return new BrewError(`no reply to the brew command within ${timeoutMs / 1000}s`, 'BREW_NO_REPLY');
    }
    return new BrewError(`connection lost while waiting for a brew reply: ${err.message}`, 'BREW_CONNECTION_LOST');
  }

  /**
   * Write `cmd` (a @TP: recipe) and wait for whichever comes first: a
   * reply matching BREW_REPLY_MATCH (@tp.../@an:...), or a *fresh* @TB
   * push -- upstream's own PROTOCOL.md (§5.9) documents @TB as the
   * dongle's brew-start marker; on a live E8 it has arrived before any
   * @tp reply, so treating a fresh @TB as its own accept signal covers
   * that case too. A progress @TV: does NOT count
   * here: it can just as well belong to a brew that was already running
   * before this command, so it isn't proof that THIS @TP: is the one that
   * started it. Any other push/marker seen while waiting is recorded via
   * _recordStatus and skipped, same as _requestOnce. Once accepted, briefly
   * waits for the accept's own counterpart too -- see _swallowCounterpart.
   * @returns {Promise<{accepted: boolean, reply: string}>}
   */
  async _sendBrewAndWait(cmd, timeoutMs, acceptGraceMs) {
    if (!this._socket) throw new BrewError('not connected', 'BREW_CONNECTION_LOST');
    this._socket.write(protocol.wrap(cmd));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new BrewError(`no reply to the brew command within ${timeoutMs / 1000}s`, 'BREW_NO_REPLY');
      }
      let frame;
      try {
        frame = await this._nextFrame(remaining);
      } catch (err) {
        throw this._brewWaitError(err, timeoutMs);
      }
      const reply = frame.toString('ascii');
      if (reply === '@TB') {
        this._recordStatus(reply);
        // Synthetic: no @tp-shaped reply was ever seen, but a fresh @TB is
        // just as much proof of acceptance. Returning the literal '@tp'
        // keeps this compatible with the unchanged isBrewAccept() below,
        // rather than teaching every caller a second way to recognise one.
        await this._swallowCounterpart((r) => BREW_REPLY_MATCH.test(r), acceptGraceMs);
        return { accepted: true, reply: '@tp' };
      }
      if (BREW_REPLY_MATCH.test(reply)) {
        const accepted = isBrewAccept(reply);
        if (accepted) await this._swallowCounterpart((r) => r === '@TB', acceptGraceMs);
        return { accepted, reply };
      }
      if (reply.startsWith('@TF:') || reply.startsWith('@TV:') || MARKER_FRAME_RE.test(reply)) {
        this._recordStatus(reply);
        continue;
      }
      // Anything else doesn't answer @TP: either -- keep waiting for one
      // of the two forms above instead of returning it.
    }
  }

  /**
   * After brew() sees an accept, briefly and passively wait (nothing
   * sent) for that accept's own counterpart -- a pushed @TB following an
   * accepting @tp reply, or an @tp reply following a fresh @TB -- and
   * record it via _recordStatus. Left uncollected, that counterpart would
   * be routed to whichever operation is running when it arrives (another
   * brew() call, a poll, ...), which could stumble into it and misread it
   * as its own answer: reproduced with two brew() calls back to back,
   * where the second one's own rejection made it start listening for a
   * fresh @TB just in time to catch the *first* call's trailing one and
   * wrongly report itself accepted. Gives up quietly after `graceMs` (or on any
   * connection problem) -- by that point the brew this counterpart
   * belongs to is already judged accepted, so there is nothing left to
   * fail.
   * @param {(reply: string) => boolean} isCounterpart
   * @param {number} graceMs
   */
  async _swallowCounterpart(isCounterpart, graceMs) {
    const deadline = Date.now() + graceMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let frame;
      try {
        frame = await this._nextFrame(remaining);
      } catch {
        return;
      }
      const reply = frame.toString('ascii');
      if (isCounterpart(reply)) {
        this._recordStatus(reply);
        return;
      }
      if (reply.startsWith('@TF:') || reply.startsWith('@TV:') || MARKER_FRAME_RE.test(reply)) {
        this._recordStatus(reply);
      }
      // Anything else is neither the counterpart nor a push/marker -- just
      // discarded, same as _drainBuffered.
    }
  }

  /**
   * Passively wait up to `ms` for proof the machine started brewing on
   * its own, with nothing sent -- used during brew()'s retry pause. Two
   * forms count: a fresh @TB, or an @tp-shaped reply that itself accepts
   * (isBrewAccept). Hypothesis, not a confirmed mechanism: this is meant
   * to cover a machine that woke from energy_safe and finished starting
   * only after this pause began. Upstream's own PROTOCOL.md describes a
   * different mechanism for that same case -- the first @TP: is simply
   * ignored and it's the *client's own retry* that brews -- which this
   * client already handles by resending below; this wait is extra
   * insurance in case a given machine instead starts by itself mid-pause,
   * unconfirmed either way. If it happens, the retry must be cancelled
   * rather than double the order. Other pushes seen while waiting are
   * recorded and skipped, same as _sendBrewAndWait.
   * @returns {Promise<'TB'|'tp'|false>} which form proved a start, or false
   */
  async _waitForFreshTB(ms, timeoutMs) {
    const deadline = Date.now() + ms;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let frame;
      try {
        frame = await this._nextFrame(remaining);
      } catch (err) {
        if (/^timeout waiting for frame/.test(err.message)) return false;
        throw this._brewWaitError(err, timeoutMs);
      }
      const reply = frame.toString('ascii');
      if (reply === '@TB') {
        this._recordStatus(reply);
        return 'TB';
      }
      if (BREW_REPLY_MATCH.test(reply) && isBrewAccept(reply)) {
        // An accepting @tp arriving unprompted during the pause is just as
        // much proof of a start as a fresh @TB -- not recorded here, same
        // as a genuine reply in _sendBrewAndWait isn't either.
        return 'tp';
      }
      if (reply.startsWith('@TF:') || reply.startsWith('@TV:') || MARKER_FRAME_RE.test(reply)) {
        this._recordStatus(reply);
      }
      // Anything else isn't what we're waiting for -- keep going until the
      // pause runs out.
    }
  }

  /**
   * Start brewing a product (@TP:<recipe blob>). DESTRUCTIVE: the
   * machine immediately heats up, grinds, and dispenses. Make sure a
   * cup is in place -- there is no remote abort.
   *
   * Resolves with the accepted reply, or throws a BrewError:
   *  - accepted: @tp (any form except @tp:00), or a fresh @TB.
   *  - BREW_REFUSED: @tp:00, or @an:...  With opts.retry, the command is
   *    resent once after retryDelayMs, unless the machine appears to have
   *    started on its own during that pause (see _waitForFreshTB) --
   *    resending then would double the order instead of fixing anything.
   *  - BREW_NO_REPLY: no @tp/@an reply and no @TB within timeoutMs. Never
   *    triggers a retry -- there is nothing indicating the machine did
   *    anything with the first @TP: at all.
   *  - BREW_CONNECTION_LOST: the connection dropped while waiting.
   * @param {string|number} product  name, raw name, or hex code
   * @param {Object<string, number|string>} overrides  recipe parameter overrides
   * @param {{retry?: boolean, timeoutMs?: number, retryDelayMs?: number, acceptGraceMs?: number}} opts
   */
  async brew(product, overrides = {}, opts = {}) {
    if (!this.profile) throw new Error('brew() requires a machine profile to encode the recipe');
    const def = profileLib.resolveProduct(this.profile, product);
    const recipe = profileLib.buildRecipeHex(def, overrides);
    const cmd = `@TP:${recipe}`;
    const timeoutMs = opts.timeoutMs || 6000;
    const retryDelayMs = opts.retryDelayMs != null ? opts.retryDelayMs : BREW_RETRY_DELAY_MS;
    const acceptGraceMs = opts.acceptGraceMs != null ? opts.acceptGraceMs : BREW_ACCEPT_GRACE_MS;

    const refused = (reply) =>
      new BrewError(`machine refused the brew command (reply: ${reply})`, 'BREW_REFUSED', { reply });

    return this._enqueue(async () => {
      await this._drainBuffered();
      let result = await this._sendBrewAndWait(cmd, timeoutMs, acceptGraceMs);
      if (result.accepted) return result.reply;
      if (!opts.retry) throw refused(result.reply);

      const sawStart = await this._waitForFreshTB(retryDelayMs, timeoutMs);
      if (sawStart) {
        // Same leak as an accept inside _sendBrewAndWait, one level up: the
        // form _waitForFreshTB didn't see (a @TB after a self-started @tp,
        // or vice versa) is still coming and would otherwise be routed to
        // whichever operation is running when it arrives -- e.g. a second,
        // queued-up brew() call -- to stumble into. Collect it here too,
        // before releasing the queue.
        await this._swallowCounterpart(sawStart === 'TB' ? (r) => BREW_REPLY_MATCH.test(r) : (r) => r === '@TB', acceptGraceMs);
        return '@tp'; // already brewing on its own -- do not resend @TP:
      }

      // _waitForFreshTB above already actively read everything that
      // arrived during the whole pause -- draining again here would only
      // risk silently swallowing a @TB that arrives exactly as the pause
      // ends, which the retry below would then read as its own reply
      // instead (the machine answers that resend "busy", same as any
      // other @TP: sent while it's occupied). Nothing is gained by
      // draining again, only a frame that could otherwise still be lost.
      result = await this._sendBrewAndWait(cmd, timeoutMs, acceptGraceMs);
      if (result.accepted) return result.reply;
      throw refused(result.reply);
    });
  }

  static randomConnId() {
    return randomConnId();
  }
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_CONN_ID,
  DEFAULT_PAIR_TIMEOUT_MS,
  JuraClient,
  MachineStatus,
  MaintenancePercent,
  HandshakeError,
  PairingTimeout,
  BrewError,
  StatusUnavailable,
  connIdHex,
  isBrewAccept,
};
