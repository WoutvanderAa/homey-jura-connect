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
// XML Argument F17 (grinder_freeness) sits at byte 16, one past the 16-byte
// blob; a product with such a parameter gets a 17-byte blob.
const F17_OFFSET = 16;
// The bytes appended behind F17 on an IntakeF18 machine for "no preselection
// selected": two padding bytes (offsets 17 and 18) and the preselection mask
// byte (offset 19, 0x00 for none), so the blob is 20 bytes.
const F18_TAIL_BYTES = 3;

// Profiles whose machine XML declares <CAPABILITIES IntakeF18="true"/> and
// that have products with an F17 parameter: EF1106 (Z10 EB), EF1208 (Z10 EC),
// EF1119 (E10 EA) and EF1123 (S10 EA). J.O.E. appends the F18 tail to the
// recipe blob on such machines, see up-PROTOCOL.md, "Single encoder for both
// WiFi and BLE" (AppProduct.c). The CAPABILITIES lines, from the upstream
// jura-connect XMLs (2026-10-31): EF1106 4.6.xml and EF1208 1.1.xml
// IntakeF18="true" LanguageDownload="true" ..., EF1119 2.3.xml
// IntakeF18="true", EF1123 3.7.xml IntakeF18="true" LanguageDownload="true" ...
// Nine more bundled profiles are IntakeF18 (EF1096, EF1100, EF1105, EF1120,
// EF1121, EF1127, EF1128, EF1139, EF1184), but they have no F17 product and
// are deliberately not listed: their wire format (16 bytes, no tail) is not
// changed. A new profile with F17 (EF1143, for one) must be added here, or
// its F17 products go out as 17 bytes without the tail.
// Not verified on hardware: if a machine answers @tp:00 to the 20-byte form,
// the 17-byte form without the tail (what upstream jura-connect sends) is the
// one to try next. Do not switch to it without such a report.
const INTAKE_F18_F17_PROFILES = new Set(['EF1106', 'EF1208', 'EF1119', 'EF1123']);

/**
 * For a product with an F17 parameter on one of INTAKE_F18_F17_PROFILES: a
 * copy of the product definition marked `intakeF18: true`, which is what
 * buildRecipeHex reads (it only sees the product, not the profile). Any other
 * product comes back as the very same object.
 * @param {{code: string}} profile
 * @param {object} def
 */
function withIntakeF18(profile, def) {
  if (!INTAKE_F18_F17_PROFILES.has(profile.code)) return def;
  if (!def.params.some((p) => p.offset === F17_OFFSET)) return def;
  return { ...def, intakeF18: true };
}

/**
 * Find a product definition by code, name, or raw name (case-insensitive).
 * @param {{products: object[], code: string}} profile
 * @param {string|number} product
 */
function resolveProduct(profile, product) {
  if (typeof product === 'number') {
    const byCode = profile.products.find((p) => p.code === product);
    if (byCode) return withIntakeF18(profile, byCode);
    throw new Error(`product code 0x${product.toString(16)} not in profile ${profile.code}`);
  }
  const text = String(product).trim();
  if (/^[0-9A-Fa-f]{1,2}$/.test(text)) {
    const code = parseInt(text, 16);
    const byCode = profile.products.find((p) => p.code === code);
    if (byCode) return withIntakeF18(profile, byCode);
  }
  const target = text.toLowerCase().replace(/\s+/g, '_');
  const byName = profile.products.find((p) => p.name === target);
  if (byName) return withIntakeF18(profile, byName);
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
 * Describe a coffee_strength param's valid levels as the numbers shown
 * on the machine's own display -- not necessarily the raw wire byte in
 * param.items[].value. The XML labels a named scale's items with a
 * plain 1-based position, and on a handful of profiles
 * (EF532/EF532coffeeonly/EF533/EF534/EF535's coffee/espresso) the
 * display shows 3..10 while the wire byte only goes 0x01..0x08 -- a
 * genuinely different, shifted scale, not just a different encoding of
 * the same numbers.
 *
 * `numeric` is true when every item's name is a plain digit string
 * (e.g. "1".."10") -- the common case, where the machine's own display
 * literally is that number. `level` is that number for a numeric
 * scale; for a named scale (mild/normal/strong/...) it's the item's
 * 1-based position instead, since every named scale surveyed across
 * all 72 bundled profiles numbers its positions 1..N with no gaps.
 * `wire` is the actual recipe byte, parsed from the XML's hex
 * item.value.
 * @param {object} param  a coffee_strength ProductParam (see profile XML), or null/undefined
 * @returns {{numeric: boolean, levels: {level:number, name:string, wire:number}[]}}
 */
function strengthScale(param) {
  const items = (param && param.items) || [];
  const numeric = items.length > 0 && items.every((it) => /^\d+$/.test(it.name));
  const levels = items.map((it, index) => ({
    level: numeric ? Number(it.name) : index + 1,
    name: it.name,
    wire: parseInt(it.value, 16),
  }));
  return { numeric, levels };
}

/**
 * Human-readable summary of a coffee_strength param's valid *displayed*
 * levels -- what to tell the user to type into the coffee_strength/
 * espresso_strength device settings (see device.js's
 * _syncStrengthOptionLabels). A numeric scale with no gaps collapses to
 * a range ("3 to 10"); a numeric scale with gaps lists every level
 * instead, since a range would wrongly imply the values in between are
 * valid too; a named scale lists "level = name" so the user can see
 * which number to type for which name.
 * @param {object} param  a coffee_strength ProductParam, or null/undefined
 * @returns {string}
 */
function describeStrengthScale(param) {
  const { numeric, levels } = strengthScale(param);
  if (levels.length === 0) return '—'; // matches app.json's placeholder value
  if (numeric) {
    const nums = levels.map((l) => l.level).sort((a, b) => a - b);
    const isConsecutive = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
    if (isConsecutive) return `${nums[0]} to ${nums[nums.length - 1]}`;
    return nums.join(', ');
  }
  return levels.map((l) => `${l.level} = ${l.name.replace(/_/g, ' ')}`).join(', ');
}

/**
 * Translate a displayed strength level (what _syncStrengthOptionLabels
 * tells the user to type, and what's stored in the coffee_strength/
 * espresso_strength device settings) to the actual recipe byte to
 * encode. Needed because a plain number handed to encodeParam is
 * matched against the wire byte directly, not the displayed level --
 * harmless on the common scales where the two are equal, but wrong on
 * the shifted scales above (a displayed level of 5 would silently
 * encode as wire 5, i.e. displayed level 7, instead of being rejected
 * or translated).
 * @param {object} param  a coffee_strength ProductParam
 * @param {number} level  the displayed level, e.g. from a device setting
 * @returns {number} the wire byte to pass as encodeParam's numeric override
 */
function strengthLevelToWire(param, level) {
  const { levels } = strengthScale(param);
  const match = levels.find((l) => l.level === level);
  if (!match) {
    throw new Error(`Strength ${level} isn't available on this machine. Valid: ${describeStrengthScale(param)}.`);
  }
  return match.wire;
}

/**
 * Build the @TP: recipe hex blob for a product: 16 bytes, or 17 (20 with the
 * IntakeF18 tail) for a product with an F17 parameter.
 *
 * Live-verified blob layout (confirmed on a physical E8/EF538 by the
 * upstream jura_connect project): byte 0 = product code; byte
 * `argument - 1` for every XML recipe parameter; byte 8 is always
 * 0x01 (fixed "recipe valid" structural byte); everything else 0x00.
 * This layout is a protocol-level constant, not model-specific -- it
 * applies to every profile the same way.
 *
 * A product with an F17 parameter (grinder_freeness, offset 16) gets a
 * 17-byte blob instead, the same layout with that parameter at byte 16.
 * If resolveProduct() marked it `intakeF18` (see INTAKE_F18_F17_PROFILES),
 * three zero bytes follow ("no preselection selected": two padding bytes and
 * the mask byte), 20 bytes in all. Not live-verified: the layout comes from
 * J.O.E.'s own encoder (up-PROTOCOL.md, AppProduct.c). Byte 15 stays as
 * this encoder sets it (0x00 unless an XML parameter sits there); J.O.E.'s
 * grinder-instructions flag (0x04) is deliberately not implemented.
 *
 * @param {object} productDef  from resolveProduct()
 * @param {Object<string, number|string>} overrides  kind -> value, XML units
 * @returns {string} uppercase hex string: 32 chars, 34 for a product with F17,
 *   40 for one with F17 on an IntakeF18 profile
 */
function buildRecipeHex(productDef, overrides = {}) {
  const remaining = { ...overrides };
  const hasF17 = productDef.params.some((p) => p.offset === F17_OFFSET);
  const blobBytes = hasF17 ? F17_OFFSET + 1 : RECIPE_BLOB_BYTES;
  const blob = new Array(blobBytes).fill(0);
  blob[0] = productDef.code & 0xff;
  blob[RECIPE_VALID_BYTE_INDEX] = RECIPE_VALID_BYTE;

  for (const p of productDef.params) {
    if (!(p.offset > 0 && p.offset < blobBytes)) {
      throw new Error(
        `${productDef.name}: parameter ${p.kind} has offset ${p.offset} outside the ${blobBytes}-byte blob`
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

  if (hasF17 && productDef.intakeF18) blob.push(...new Array(F18_TAIL_BYTES).fill(0));

  return blob.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

module.exports = {
  RECIPE_BLOB_BYTES,
  resolveProduct,
  encodeParam,
  buildRecipeHex,
  strengthScale,
  describeStrengthScale,
  strengthLevelToWire,
};
