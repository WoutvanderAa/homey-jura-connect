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

// Pause before brew()'s single retry. An option with this as its default
// (not a hardcoded literal) so tests can scale it down -- see brew()'s own
// doc comment for what the pause is actually waiting to find out.
const BREW_RETRY_DELAY_MS = 3000;

// How long, right after brew() sees an accept, to keep listening (without
// sending anything) for that accept's own counterpart frame -- a pushed
// @TB after an accepting @tp reply, or an @tp reply after a fresh @TB.
// Left uncollected, that counterpart sits in the read buffer for whatever
// operation is queued next (another brew() call, a poll, ...) to stumble
// into and misread as its own answer -- reproduced with two brew() calls
// back to back, the second queued while the first is still finishing.
// An option so tests can scale it.
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
  }

  get connected() {
    return this._socket !== null;
  }

  /**
   * Serialize every write-then-wait-for-a-reply operation (connect,
   * request) through this one instance. Two such operations racing on
   * the same connection share one FrameReader, which hands each
   * incoming frame to whichever caller is first in line to await one --
   * not necessarily the caller whose command that frame is actually
   * answering. A poll cycle's @HU? and a flow-triggered brew()'s @TP:
   * both in flight at once could otherwise steal each other's reply;
   * confirmed via a real report where brew() got handed a stray status
   * reply and reported the brew rejected even though the machine had
   * genuinely accepted and brewed it. Queuing means only one write+wait
   * cycle is ever outstanding per client, so this can't happen.
   */
  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
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
        this._reader = new protocol.FrameReader(sock);
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
        frame = await this._reader.nextFrame(remaining);
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
    this.authHash = '';
    await this._rawConnect();
    if (onUserPrompt) {
      onUserPrompt(
        `Coffee machine should be showing a "Connect" prompt — confirm it on the machine's own display to accept (the exact button varies by model: often OK/checkmark, on some models the bean button) (waiting up to ${Math.round(timeoutMs / 1000)}s).`
      );
    }
    return this._doHandshake(timeoutMs);
  }

  async close() {
    if (this._socket) {
      try {
        this._socket.write(protocol.wrap('@HE'));
      } catch {
        // best-effort polite close
      }
      try {
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
   * Send `cmd` and return the first reply matching `matchRe` (or the
   * first non-status reply when matchRe is null). @TF:/@TV: status frames
   * and bare markers (@TB, @TS, ...) seen along the way are appended to
   * statusHistory instead of being returned, unless `matchRe` itself asks
   * for one of them.
   * @param {string} cmd
   * @param {RegExp|null} matchRe
   * @param {number} timeoutMs
   */
  async request(cmd, matchRe = null, timeoutMs = 6000) {
    return this._enqueue(() => this._requestOnce(cmd, matchRe, timeoutMs));
  }

  async _requestOnce(cmd, matchRe, timeoutMs) {
    if (!this._socket) throw new Error('not connected');
    this._socket.write(protocol.wrap(cmd));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no reply to ${JSON.stringify(cmd)} within ${timeoutMs}ms`);
      const frame = await this._reader.nextFrame(remaining);
      const reply = frame.toString('ascii');
      // Pushes -- status frames and bare markers alike -- are recorded and
      // skipped by default, same treatment as @TF:/@TV: always got. Only
      // returned if the caller's own matcher explicitly wants this exact
      // frame.
      if (reply.startsWith('@TF:') || reply.startsWith('@TV:') || MARKER_FRAME_RE.test(reply)) {
        this._recordStatus(reply);
        if (matchRe && matchRe.test(reply)) return reply;
        continue;
      }
      if (!matchRe) return reply;
      if (matchRe.test(reply)) return reply;
    }
  }

  /** Wait for the next unsolicited @TF: status frame and parse it. */
  async readStatus(timeoutMs = 6000) {
    const reply = await this.request('@HU?', /^@TF:/, timeoutMs);
    return MachineStatus.parse(reply, this.profile);
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
   * Drain whatever complete frames are already sitting in the read buffer,
   * without waiting for any new ones to arrive -- run right before writing
   * a fresh @TP: so a leftover reply from an earlier exchange (e.g. a
   * stale @hu:800 that arrived after its own request had already moved on
   * and returned) or an old @TB from a brew that isn't this one is much
   * less likely to be mistaken for the answer to THIS command. This only
   * covers frames already buffered *before* this call -- a frame that is
   * this command's own accept plus its counterpart is handled separately,
   * see _swallowCounterpart. Status/marker frames drained this way are
   * still recorded via _recordStatus; anything else is simply discarded,
   * which is the whole point.
   */
  async _drainBuffered() {
    if (!this._reader) return; // not connected -- nothing to drain
    for (;;) {
      let frame;
      try {
        frame = await this._reader.nextFrame(0);
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
        frame = await this._reader.nextFrame(remaining);
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
   * sit in the read buffer for whatever operation this client runs next
   * (another brew() call, a poll, ...) to stumble into and misread as its
   * own answer: reproduced with two brew() calls back to back, where the
   * second one's own rejection made it start listening for a fresh @TB
   * just in time to catch the *first* call's trailing one and wrongly
   * report itself accepted. Gives up quietly after `graceMs` (or on any
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
        frame = await this._reader.nextFrame(remaining);
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
        frame = await this._reader.nextFrame(remaining);
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
        // or vice versa) is still coming and would otherwise sit in the
        // buffer for whatever this client runs next -- e.g. a second,
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
  connIdHex,
  isBrewAccept,
};
