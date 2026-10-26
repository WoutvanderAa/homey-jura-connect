'use strict';

/**
 * Check of a machine address that the user types in: the Machine IP address
 * in the device settings and the manual IP field of the pair flow. The app
 * only ever talks to a machine on the local network, so only an IPv4 dotted
 * quad in a local range is accepted:
 *
 *   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (private),
 *   169.254.0.0/16 (link-local), 100.64.0.0/10 (carrier-grade NAT, as used
 *   by some VPN and mesh networks), 127.0.0.0/8 (loopback: never leaves the
 *   Homey, and the tests run their fake machine there)
 *
 * No hostnames, no IPv6, no spaces, and no leading zeros in a part: some
 * resolvers read "010" as octal, which would send the connection to another
 * address than the one that was checked.
 */

const IPV4_RE = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

const NOT_LOCAL_ADDRESS_MESSAGE =
  "That is not a local network address. Enter the machine's IPv4 address on your home network, for example 192.168.1.50.";

/**
 * @param {*} value
 * @returns {boolean} true for an IPv4 dotted quad in one of the local ranges
 */
function isLocalAddress(value) {
  if (typeof value !== 'string') return false;
  const match = IPV4_RE.exec(value);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127
  );
}

/**
 * Throws the one message the user gets for any address that is not accepted.
 * @param {*} value
 */
function assertLocalAddress(value) {
  if (!isLocalAddress(value)) throw new Error(NOT_LOCAL_ADDRESS_MESSAGE);
}

module.exports = { NOT_LOCAL_ADDRESS_MESSAGE, isLocalAddress, assertLocalAddress };
