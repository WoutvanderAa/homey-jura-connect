'use strict';

/**
 * Model registry — the ONE place to touch when adding support for a
 * new Jura WiFi Connect machine.
 *
 * To add a model:
 *   1. Find its EF code(s) — see lib/profiles/README.md for how to
 *      pull one out of the `jura_connect` PyPI package (same tool
 *      used to generate every profile already bundled here).
 *   2. Drop the generated file in lib/profiles/<EF_CODE>.js.
 *   3. Add one entry per hardware revision below: friendly name,
 *      profile file, and the article numbers Jura shipped for it
 *      (from jura_connect's JOE_MACHINES.TXT).
 * Nothing else needs to change — driver.js, device.js and juraClient.js
 * are all already model-agnostic and read everything through this file.
 */

const PROFILE_FILES = {
  EF533: require('./profiles/EF533'),
  EF533V2: require('./profiles/EF533V2'),
  EF532: require('./profiles/EF532'),
  EF532V2: require('./profiles/EF532V2'),
  EF1091: require('./profiles/EF1091'),
};

/**
 * One entry per known hardware revision. `articleNumbers` drives
 * auto-detection at pairing time (from the discovery reply); `label`
 * is what the pairing dropdown shows when auto-detection can't find a
 * match and the user has to pick manually.
 */
const MODELS = [
  {
    label: 'Jura E8 (older, EF533)',
    profileCode: 'EF533',
    articleNumbers: [13791, 15057, 15072, 15083, 15084, 15094, 15096, 15097, 15108, 15109, 15157, 15161],
  },
  {
    label: 'Jura E8 (newer, EF533V2)',
    profileCode: 'EF533V2',
    // 15336 (hwId EF538M) confirmed live: paired, status and brew both
    // verified correct against a real machine of this article number.
    articleNumbers: [14006, 15336],
  },
  {
    label: 'Jura E6 (older, EF532)',
    profileCode: 'EF532',
    articleNumbers: [15058, 15070, 15079, 15098, 15099, 15174, 15260],
  },
  {
    label: 'Jura E6 (newer, EF532V2)',
    profileCode: 'EF532V2',
    articleNumbers: [14016, 15326],
  },
  {
    label: 'Jura S8 (EB)',
    profileCode: 'EF1091',
    articleNumbers: [15480, 15484],
  },
];

const DEFAULT_PROFILE_CODE = 'EF533V2';

/** @returns {{label:string, profileCode:string}[]} for pairing-screen dropdowns */
function listModels() {
  return MODELS.map((m) => ({ label: m.label, profileCode: m.profileCode }));
}

/**
 * @param {number} articleNumber
 * @returns {{label:string, profileCode:string}|null} the matching model, or null if unknown
 */
function modelForArticle(articleNumber) {
  const model = MODELS.find((m) => m.articleNumbers.includes(articleNumber));
  return model ? { label: model.label, profileCode: model.profileCode } : null;
}

/**
 * @param {string} code e.g. 'EF533V2'
 * @returns {{code: string, products: object[], alerts: object[]}}
 */
function getProfile(code) {
  const p = PROFILE_FILES[code];
  if (!p) {
    const known = Object.keys(PROFILE_FILES).join(', ');
    throw new Error(`Unknown machine profile "${code}". Bundled profiles: ${known}`);
  }
  return p;
}

module.exports = {
  MODELS,
  DEFAULT_PROFILE_CODE,
  listModels,
  modelForArticle,
  getProfile,
  knownProfileCodes: Object.keys(PROFILE_FILES),
};
