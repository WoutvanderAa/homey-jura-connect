'use strict';

const { App } = require('homey');
const models = require('./lib/models');
const profileLib = require('./lib/profile');

class JuraConnectApp extends App {

  async onInit() {
    this.log('Jura Connect app is running');

    const brewAction = this.homey.flow.getActionCard('brew_product');

    const getDeviceProfile = (device) => {
      const store = device.getStore();
      const settings = device.getSettings();
      const profileCode = settings.profile_code || store.profileCode || models.DEFAULT_PROFILE_CODE;
      return models.getProfile(profileCode);
    };

    brewAction.registerRunListener(async (args) => {
      const overrides = {};
      if (args.strength && args.strength.id) {
        // The strength argument keeps its value when the user changes the
        // product in the same card, so check it against the product that is
        // selected now (same lookup as the strength autocomplete below). A
        // product without an adjustable strength just ignores it (the
        // argument is optional); one that has it but not this level fails
        // with a sentence, before anything is sent.
        const product = getDeviceProfile(args.device).products.find((p) => p.name === args.product.id);
        const strengthParam = product && product.params.find((p) => p.kind === 'coffee_strength');
        if (strengthParam) {
          if (!strengthParam.items.some((it) => it.name === args.strength.id)) {
            throw new Error(
              `Pick the strength again in this card: "${args.strength.id}" is not available for ${product.rawName}.`
            );
          }
          overrides.coffee_strength = args.strength.id;
        }
      }
      await args.device.brew(args.product.id, overrides);
      return true;
    });

    // Only products whose recipe builds without any override are offered: a
    // product that cannot be built (EF562's 2 Ristretti, whose default
    // temperature is not one of its items) would fail on every run.
    const buildsWithoutOverrides = (product) => {
      try {
        profileLib.buildRecipeHex(product, {});
        return true;
      } catch {
        return false;
      }
    };

    // The brewable set differs per profile (EF533 vs EF533V2 vs ...),
    // so the picker is filled from the device's own profile rather
    // than a fixed list -- see lib/profiles/*.js for what each has.
    brewAction.registerArgumentAutocompleteListener('product', async (query, args) => {
      const profile = getDeviceProfile(args.device);
      const q = query.trim().toLowerCase();
      return profile.products
        .filter((p) => p.active !== false)
        .filter(buildsWithoutOverrides)
        .filter((p) => !q || p.rawName.toLowerCase().includes(q) || p.name.includes(q))
        .map((p) => ({ id: p.name, name: p.rawName }));
    });

    // Strength options for the (optional) "strength" argument come
    // straight from the selected product's own coffee_strength param --
    // whatever names/range that specific product on that specific
    // device's profile actually has (mild/normal/strong, a 1-10 numeric
    // scale, a named 5-level scale, ...), not a hardcoded per-model
    // table -- see lib/profile.js's encodeParam, which already resolves
    // an item by this exact name. Empty when nothing's been picked yet
    // or the product has no adjustable strength (e.g. hot water); the
    // argument is optional, so an empty list just leaves it unset.
    const prettify = (name) => name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    brewAction.registerArgumentAutocompleteListener('strength', async (query, args) => {
      if (!args.product) return [];
      const profile = getDeviceProfile(args.device);
      const product = profile.products.find((p) => p.name === args.product.id);
      const strengthParam = product && product.params.find((p) => p.kind === 'coffee_strength');
      if (!strengthParam) return [];
      const q = query.trim().toLowerCase();
      return strengthParam.items
        .filter((it) => !q || it.name.toLowerCase().includes(q))
        .map((it) => ({ id: it.name, name: prettify(it.name) }));
    });

    // Every custom alarm_*_true/_false trigger fires on its own (Homey
    // auto-triggers <boolean capability>_true/_false when
    // setCapabilityValue changes it) -- only the condition cards need a
    // listener here. alarm_water is a real Homey system capability and
    // already ships with its own trigger/condition cards.
    this.homey.flow
      .getConditionCard('alarm_beans_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_beans') === true);

    this.homey.flow
      .getConditionCard('alarm_tray_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_tray') === true);

    this.homey.flow
      .getConditionCard('alarm_tray_missing_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_tray_missing') === true);

    this.homey.flow
      .getConditionCard('alarm_outlet_missing_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_outlet_missing') === true);

    this.homey.flow
      .getConditionCard('alarm_rear_cover_missing_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_rear_cover_missing') === true);

    // Maintenance-percent conditions and crossed-above triggers. Unlike
    // the boolean alarm_* capabilities above, Homey doesn't auto-fire
    // anything for a plain "number" capability, so device.js calls
    // .trigger() itself (in _poll()'s maintenance-read block) whenever
    // a reading changes, passing both the new and previous value as
    // state -- the run listener below is what turns that into a
    // one-shot "just crossed this specific flow's threshold" check,
    // since multiple flows can each have their own threshold watching
    // the same underlying value stream.
    const registerMaintenanceCards = (capability, triggerId, conditionId) => {
      this.homey.flow
        .getDeviceTriggerCard(triggerId)
        .registerRunListener(async (args, state) => state.previousValue < args.threshold && state.value >= args.threshold);

      this.homey.flow.getConditionCard(conditionId).registerRunListener(async (args) => {
        const value = args.device.getCapabilityValue(capability);
        // null on profiles that don't track this type (e.g. no filter
        // cartridge fitted) -- can't be "above" a threshold with no
        // reading, so treat that as false rather than coercing null to 0.
        return value != null && value >= args.threshold;
      });
    };

    registerMaintenanceCards(
      'jura_maintenance_cleaning',
      'jura_maintenance_cleaning_crossed_above',
      'jura_maintenance_cleaning_above'
    );
    registerMaintenanceCards(
      'jura_maintenance_filter',
      'jura_maintenance_filter_crossed_above',
      'jura_maintenance_filter_above'
    );
    registerMaintenanceCards(
      'jura_maintenance_descale',
      'jura_maintenance_descale_crossed_above',
      'jura_maintenance_descale_above'
    );
  }

}

module.exports = JuraConnectApp;
