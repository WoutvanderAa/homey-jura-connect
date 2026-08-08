'use strict';

/**
 * Auto-discovery of Jura coffee machines on the local network.
 *
 * Ported from `discovery.py` in the `jura_connect` PyPI package.
 * Mirrors the Android app's UDPManagerBroadcast / WifiFrog flow:
 * broadcast a fixed 16-byte scan packet to UDP port 51515 and parse
 * each reply as an extended status frame.
 *
 * Reply layout (offsets in bytes), derived from WifiFrog.H(byte[]):
 *
 *    0..2   total length (big endian)
 *    2..4   control word (low 12 bits == 1523, bit 15 must be set)
 *    4..20  firmware/version string, ASCII, space-padded   -> fw
 *   20..52  user-assigned machine name, ASCII               -> name
 *   52..68  hardware identifier, ASCII                      -> hwId
 *   68..78  10 bytes of binary status (article#, machine#, serial,
 *                production date, UCHI production date)
 *  108..109 1 byte  -> extra
 *      109  status bits: bit0=valid, bit4=ready, bit7=available
 *  110..L   raw status payload
 */

const dgram = require('dgram');
const os = require('os');

const JURA_PORT = 51515;

// The 16-byte broadcast scan probe. Verbatim from UDPCommandScan.
const SCAN_PROBE = Buffer.from('0010A5F3000000000000000000000000', 'hex');

function decodeAscii(blob) {
  return blob.toString('latin1').replace(/\0+$/, '').trim();
}

function ymd(raw) {
  const year = ((raw & 0xfe00) >> 9) + 1990;
  const month = (raw & 0x01e0) >> 5;
  const day = raw & 0x1f;
  if (month === 0 || day === 0) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/**
 * Parse a single broadcast reply. Throws if malformed.
 * @param {Buffer} data
 * @param {string} address
 */
function parseReply(data, address) {
  if (data.length < 110) {
    throw new Error(`reply too short: ${data.length} bytes`);
  }

  const controlBytes = data.subarray(2, 4);
  const control = controlBytes.readUInt16BE(0);
  if ((control & 0x0fff) !== 1523) {
    throw new Error(`not a Jura frame: control=0x${control.toString(16)}`);
  }

  // Mirror WifiFrog.G(idx, bArr): pick bit `length % 8` of byte
  // `length // 8` where `length = bytes*8 - idx - 1`. For the 2-byte
  // control word that means G(14)/G(15) read bits 1/0 of the high byte.
  const g = (buf, idx) => {
    const length = buf.length * 8 - idx - 1;
    return (buf[Math.floor(length / 8)] >> length % 8) & 1;
  };
  if (g(controlBytes, 14) !== 0) throw new Error('control bit-14 must be cleared');
  if (g(controlBytes, 15) !== 1) throw new Error('control bit-15 must be set');

  const totalLen = data.readUInt16BE(0);
  const fw = decodeAscii(data.subarray(4, 20));
  const name = decodeAscii(data.subarray(20, 52));
  const hwId = decodeAscii(data.subarray(52, 68));

  const nums = data.subarray(68, 78);
  const u16 = (off) => ((nums[off] << 8) | nums[off + 1]) & 0xffff;

  const articleNumber = u16(0);
  const machineNumber = u16(2);
  const serialNumber = u16(4);
  const productionDate = ymd(u16(6));
  const uchiProductionDate = ymd(u16(8));

  const flags = data[109];
  const end = Math.min(totalLen, data.length);
  const statusPayload = data.subarray(110, end);

  return {
    address,
    name,
    fw,
    hwId,
    articleNumber,
    machineNumber,
    serialNumber,
    productionDate,
    uchiProductionDate,
    statusFlags: flags,
    statusHex: statusPayload.toString('hex').toUpperCase(),
    raw: data.subarray(0, end),
    // bit4 of byte 109 -> "ready" in WifiFrog.H
    get ready() {
      return Boolean((flags >> 4) & 1);
    },
    // bit0 == 0 means "active product"
    get busy() {
      return (flags & 1) === 0;
    },
    // bit7 == 1 means powered down
    get standby() {
      return Boolean((flags >> 7) & 1);
    },
  };
}

function broadcastAddresses() {
  const targets = ['255.255.255.255'];
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] || []) {
        if (info.family !== 'IPv4' || info.internal) continue;
        const parts = info.address.split('.').map(Number);
        // /24 broadcast heuristic, matches the netmask most home LANs use.
        const bcast = `${parts[0]}.${parts[1]}.${parts[2]}.255`;
        if (!targets.includes(bcast)) targets.push(bcast);
      }
    }
  } catch {
    // best-effort
  }
  return targets;
}

/**
 * Broadcast the scan probe and resolve with every discovered machine
 * seen within `timeoutMs`, deduplicated by address.
 * @param {{timeoutMs?: number, repeats?: number, intervalMs?: number, targets?: string[]}} opts
 * @returns {Promise<object[]>}
 */
function discover(opts = {}) {
  const { timeoutMs = 3000, repeats = 3, intervalMs = 1000, targets = null } = opts;
  const bcastTargets = targets || broadcastAddresses();

  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const seen = new Map();
    let sendsLeft = repeats;
    let sendTimer = null;
    let deadlineTimer = null;

    const sendProbe = () => {
      for (const target of bcastTargets) {
        sock.send(SCAN_PROBE, JURA_PORT, target, () => {});
      }
      sendsLeft -= 1;
      if (sendsLeft > 0) sendTimer = setTimeout(sendProbe, intervalMs);
    };

    const finish = () => {
      clearTimeout(sendTimer);
      clearTimeout(deadlineTimer);
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve(Array.from(seen.values()));
    };

    sock.on('message', (data, rinfo) => {
      if (data.equals(SCAN_PROBE)) return; // our own probe echoed back
      try {
        const machine = parseReply(data, rinfo.address);
        seen.set(machine.address, machine);
      } catch {
        // not a valid Jura reply, ignore
      }
    });

    sock.on('error', () => finish());

    sock.bind(JURA_PORT, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        // ignore
      }
      sendProbe();
      deadlineTimer = setTimeout(finish, timeoutMs);
    });
  });
}

/**
 * TCP reachability probe — returns true if a TCP handshake to the
 * Jura control port succeeds. Useful when a firmware doesn't reply to
 * UDP scans but does accept TCP connections (seen on some TT237W-family
 * dongles). Does not by itself prove the listener is a Jura machine —
 * pair with the encrypted handshake in juraClient.js to confirm.
 * @param {string} address
 * @param {number} port
 * @param {number} timeoutMs
 */
function tcpProbe(address, port = JURA_PORT, timeoutMs = 2000) {
  const net = require('net');
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: address, port, timeout: timeoutMs });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

module.exports = { JURA_PORT, SCAN_PROBE, parseReply, discover, tcpProbe, broadcastAddresses };
