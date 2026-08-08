'use strict';

/**
 * Recipe-blob encoder — fully model-agnostic.
 *
 * Ported from the relevant parts of `profile.py` in the `jura_connect`
 * PyPI package. Works against whatever profile object it's handed
 * (product/param definitions from ANY bundled lib/profiles/<EF>.js) --
 * model selection itself lives in lib/models.js, not here.
 */

const RECIPE_BLOB_BYTES = 16;
const RECIPE_VALID_BYTE_INDEX = 8;
const RECIPE_VALID_BYTE = 0x01;
const ML_TICK_KINDS = new Set(['water_amount', 'bypass']);
const ML_PER_TICK = 5;

/**
 * Find a product definition by code, name, or raw name (case-insensitive).
 * @param {{products: object[], code: string}} profile
 * @param {string|number} product
 */
function resolveProduct(profile, product) {
  if (typeof product === 'number') {
    const byCode = profile.products.find((p) => p.code === product);
    if (byCode) return byCode;
    throw new Error(`product code 0x${product.toString(16)} not in profile ${profile.code}`);
  }
  const text = String(product).trim();
  if (/^[0-9A-Fa-f]{1,2}$/.test(text)) {
    const code = parseInt(text, 16);
    const byCode = profile.products.find((p) => p.code === code);
    if (byCode) return byCode;
  }
  const target = text.toLowerCase().replace(/\s+/g, '_');
  const byName = profile.products.find((p) => p.name === target);
  if (byName) return byName;
  const known = profile.products.map((p) => p.name).join(', ');
  throw new Error(`product "${product}" not known on profile ${profile.code}. Known: ${known}`);
}

/**
 * Encode one recipe parameter value to its wire byte. Mirrors
 * ProductParam.encode() in profile.py.
 * @param {object} param
 * @param {number|string} value
 */
function encodeParam(param, value) {
  if (param.items && param.items.length) {
    if (typeof value === 'string') {
      const key = value.toLowerCase().replace(/\s+/g, '_');
      let item = param.items.find((it) => it.name === key);
      if (!item) {
        const candidate = value.trim().toUpperCase();
        item = param.items.find((it) => it.value === candidate);
      }
      if (!item) {
        const allowed = param.items.map((it) => `${it.name}=${it.value}`).join(', ');
        throw new Error(`${param.kind}: "${value}" is not recognised. Allowed: ${allowed}`);
      }
      return parseInt(item.value, 16);
    }
    const match = param.items.some((it) => parseInt(it.value, 16) === value);
    if (!match) {
      const allowed = param.items.map((it) => `${it.name}=${it.value}`).join(', ');
      throw new Error(`${param.kind}: ${value} not in catalogue. Allowed: ${allowed}`);
    }
    return value;
  }
  let v = value;
  if (typeof v === 'string') {
    v = parseInt(v, 10);
    if (Number.isNaN(v)) throw new Error(`${param.kind}: expected an integer, got "${value}"`);
  }
  const lo = param.min == null ? 0 : param.min;
  const hi = param.max == null ? 0xff : param.max;
  if (v < lo || v > hi) throw new Error(`${param.kind}: ${v} is outside [${lo}, ${hi}]`);
  if (param.step && param.step > 1 && (v - lo) % param.step !== 0) {
    throw new Error(`${param.kind}: ${v} is not a multiple of step ${param.step} from ${lo}`);
  }
  const wire = ML_TICK_KINDS.has(param.kind) ? Math.floor(v / ML_PER_TICK) : v;
  if (wire < 0 || wire > 0xff) throw new Error(`${param.kind}: ${v} does not fit a wire byte`);
  return wire;
}

/**
 * Build the 16-byte @TP: recipe hex blob for a product.
 *
 * Live-verified blob layout (confirmed on a physical E8/EF538 by the
 * upstream jura_connect project): byte 0 = product code; byte
 * `argument - 1` for every XML recipe parameter; byte 8 is always
 * 0x01 (fixed "recipe valid" structural byte); everything else 0x00.
 * This layout is a protocol-level constant, not model-specific -- it
 * applies to every profile the same way.
 *
 * @param {object} productDef  from resolveProduct()
 * @param {Object<string, number|string>} overrides  kind -> value, XML units
 * @returns {string} 32-char uppercase hex string
 */
function buildRecipeHex(productDef, overrides = {}) {
  const remaining = { ...overrides };
  const blob = new Array(RECIPE_BLOB_BYTES).fill(0);
  blob[0] = productDef.code & 0xff;
  blob[RECIPE_VALID_BYTE_INDEX] = RECIPE_VALID_BYTE;

  for (const p of productDef.params) {
    if (!(p.offset > 0 && p.offset < RECIPE_BLOB_BYTES)) {
      throw new Error(
        `${productDef.name}: parameter ${p.kind} has offset ${p.offset} outside the ${RECIPE_BLOB_BYTES}-byte blob`
      );
    }
    let value;
    if (Object.prototype.hasOwnProperty.call(remaining, p.kind)) {
      value = remaining[p.kind];
      delete remaining[p.kind];
    } else {
      value = p.default;
    }
    if (value === null || value === undefined) {
      if (ML_TICK_KINDS.has(p.kind)) {
        throw new Error(
          `${productDef.name}: parameter ${p.kind} has no value and no XML default; ` +
            'refusing to leave its byte at 0 (would brew with no water). Pass an explicit amount.'
        );
      }
      continue;
    }
    blob[p.offset] = encodeParam(p, value) & 0xff;
  }

  const leftover = Object.keys(remaining);
  if (leftover.length) {
    throw new Error(`${productDef.name}: unknown recipe override kind(s): ${leftover.join(', ')}`);
  }

  return blob.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

module.exports = {
  RECIPE_BLOB_BYTES,
  resolveProduct,
  encodeParam,
  buildRecipeHex,
};
