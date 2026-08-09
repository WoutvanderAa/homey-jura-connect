'use strict';

const { App } = require('homey');
const models = require('./lib/models');

class JuraConnectApp extends App {

  async onInit() {
    this.log('Jura E8 app is running');

    const brewAction = this.homey.flow.getActionCard('brew_product');

    brewAction.registerRunListener(async (args) => {
      await args.device.brew(args.product.id);
      return true;
    });

    // The brewable set differs per profile (EF533 vs EF533V2 vs ...),
    // so the picker is filled from the device's own profile rather
    // than a fixed list -- see lib/profiles/*.js for what each has.
    brewAction.registerArgumentAutocompleteListener('product', async (query, args) => {
      const store = args.device.getStore();
      const settings = args.device.getSettings();
      const profileCode = settings.profile_code || store.profileCode || models.DEFAULT_PROFILE_CODE;
      const profile = models.getProfile(profileCode);
      const q = query.trim().toLowerCase();
      return profile.products
        .filter((p) => p.active !== false)
        .filter((p) => !q || p.rawName.toLowerCase().includes(q) || p.name.includes(q))
        .map((p) => ({ id: p.name, name: p.rawName }));
    });

    // alarm_beans_true/_false and alarm_tray_true/_false fire on their
    // own (Homey auto-triggers <boolean capability>_true/_false when
    // setCapabilityValue changes it) -- only the condition cards need a
    // listener here. alarm_water is a real Homey system capability and
    // already ships with its own trigger/condition cards.
    this.homey.flow
      .getConditionCard('alarm_beans_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_beans') === true);

    this.homey.flow
      .getConditionCard('alarm_tray_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_tray') === true);
  }

}

module.exports = JuraConnectApp;
