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
  }

  get connected() {
    return this._socket !== null;
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
      if (reply.startsWith('@TF:') || reply.startsWith('@TV:')) {
        this.statusHistory.push(reply);
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
    await this._rawConnect();
    return this._doHandshake(timeoutMs);
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
        `Coffee machine should be showing a "Connect" prompt — press OK on the machine to accept (waiting up to ${Math.round(timeoutMs / 1000)}s).`
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
   * first non-status reply when matchRe is null). @TF:/@TV: status
   * frames seen along the way are appended to statusHistory.
   * @param {string} cmd
   * @param {RegExp|null} matchRe
   * @param {number} timeoutMs
   */
  async request(cmd, matchRe = null, timeoutMs = 6000) {
    if (!this._socket) throw new Error('not connected');
    this._socket.write(protocol.wrap(cmd));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no reply to ${JSON.stringify(cmd)} within ${timeoutMs}ms`);
      const frame = await this._reader.nextFrame(remaining);
      const reply = frame.toString('ascii');
      if (reply.startsWith('@TF:') || reply.startsWith('@TV:')) {
        this.statusHistory.push(reply);
        if (!matchRe) continue;
        if (!matchRe.test(reply)) continue;
        return reply;
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
   * Start brewing a product (@TP:<recipe blob>). DESTRUCTIVE: the
   * machine immediately heats up, grinds, and dispenses. Make sure a
   * cup is in place -- there is no remote abort.
   * @param {string|number} product  name, raw name, or hex code
   * @param {Object<string, number|string>} overrides  recipe parameter overrides
   * @param {{retry?: boolean, timeoutMs?: number}} opts
   */
  async brew(product, overrides = {}, opts = {}) {
    if (!this.profile) throw new Error('brew() requires a machine profile to encode the recipe');
    const def = profileLib.resolveProduct(this.profile, product);
    const recipe = profileLib.buildRecipeHex(def, overrides);
    let reply = await this.request(`@TP:${recipe}`, null, opts.timeoutMs || 6000);
    if (opts.retry && !isBrewAccept(reply)) {
      // Energy-safe wake-up: the first @TP: only woke the machine; resend now it's awake.
      reply = await this.request(`@TP:${recipe}`, null, opts.timeoutMs || 6000);
    }
    return reply;
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
  connIdHex,
  isBrewAccept,
};
