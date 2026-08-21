'use strict';

const { Device } = require('homey');
const models = require('../../lib/models');
const { JuraClient } = require('../../lib/juraClient');

// How often to poll @HU? for a status frame while idle. Drives alarms,
// onoff and available/unavailable -- kept short so those feel
// responsive rather than lagging up to a full interval behind reality.
const POLL_INTERVAL_MS = 10000;

// Maintenance percent (@TG:C0) doesn't change fast enough to need every
// cycle -- read it once every 30th poll (~5 min at the 10s interval
// above) instead.
const MAINTENANCE_POLL_EVERY = 30;

// The WiFi module goes fully offline when the machine is powered off or
// hits its auto-off timer -- surface that plainly instead of a raw
// socket error code.
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH']);
function friendlyPollError(err) {
  if (UNREACHABLE_CODES.has(err.code)) {
    return 'Machine appears to be off or unreachable on the network.';
  }
  return err.message;
}

class JuraMachineDevice extends Device {

  async onInit() {
    this.log('Jura machine device init:', this.getName());

    if (!this.hasCapability('onoff')) await this.addCapability('onoff').catch(this.error);
    if (!this.hasCapability('alarm_generic')) await this.addCapability('alarm_generic').catch(this.error);
    // Always (re-)applied, not just on first add, so existing devices pick
    // up the cup glyph too instead of Homey's generic bell icon.
    this.setCapabilityOptions('alarm_generic', {
      title: { en: 'Needs attention', nl: 'Heeft aandacht nodig' },
      icon: '/drivers/jura-machine/assets/alarm_generic.svg',
    }).catch(this.error);

    // Renamed from jura_alarm_beans -- `alarm_` is a reserved Homey
    // prefix that gets automatic grouping, a warning icon, and (most
    // importantly) automatic Flow trigger/condition cards, none of
    // which a jura_-prefixed id would get. Drop the stale one from
    // devices paired before this rename.
    if (this.hasCapability('jura_alarm_beans')) await this.removeCapability('jura_alarm_beans').catch(this.error);

    // alarm_outlet_missing/alarm_rear_cover_missing picked up their
    // icon correctly on first add (confirmed live), but alarm_beans/
    // alarm_tray/alarm_tray_missing didn't, despite adding the same
    // "icon" field to their app.json capability definitions -- Homey
    // appears to snapshot capability metadata (including icon) at the
    // moment a capability is first added to a device, not re-read it
    // from the manifest afterward. Devices that already had these three
    // from an earlier version are stuck with no icon until forced to
    // re-add. One-time migration: remove them here so the loop below
    // re-adds them fresh with the icon this time.
    for (const cap of ['alarm_beans', 'alarm_tray', 'alarm_tray_missing']) {
      if (this.hasCapability(cap)) await this.removeCapability(cap).catch(this.error);
    }

    for (const cap of [
      'alarm_water',
      'alarm_beans',
      'alarm_tray',
      'alarm_tray_missing',
      'alarm_outlet_missing',
      'alarm_rear_cover_missing',
      'jura_maintenance_cleaning',
      'jura_maintenance_filter',
      'jura_maintenance_descale',
      'brew_coffee_button',
      'brew_espresso_button',
    ]) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
    this.setCapabilityOptions('alarm_beans', {
      icon: '/drivers/jura-machine/assets/alarm_beans.svg',
    }).catch(this.error);
    // alarm_tray = tray/grounds present but full (empty_tray/empty_grounds).
    // alarm_tray_missing = tray not inserted at all (insert_tray) --
    // a genuinely different physical state the user asked to
    // distinguish, not just a naming nitpick.
    this.setCapabilityOptions('alarm_tray', {
      icon: '/drivers/jura-machine/assets/alarm_tray.svg',
    }).catch(this.error);
    this.setCapabilityOptions('alarm_tray_missing', {
      icon: '/drivers/jura-machine/assets/alarm_tray_missing.svg',
    }).catch(this.error);
    // outlet_missing/rear_cover_missing: ~96-97% profile coverage (not
    // 100% like the alarms above), see lib/profiles/README.md's alert
    // survey -- profiles that lack the name just never set these true.
    this.setCapabilityOptions('alarm_outlet_missing', {
      icon: '/drivers/jura-machine/assets/alarm_outlet_missing.svg',
    }).catch(this.error);
    this.setCapabilityOptions('alarm_rear_cover_missing', {
      icon: '/drivers/jura-machine/assets/alarm_rear_cover_missing.svg',
    }).catch(this.error);

    this._client = null;
    this._pollTimer = null;
    this._pollCount = 0;

    this.registerCapabilityListener('onoff', async (value) => {
      // Fully read-only in both directions. @AN:02 (standby) is a
      // UART/Bluetooth-era command -- jura_connect's own command
      // registry notes the WiFi dongle silently ignores it (request
      // lands, machine stays on), confirmed against a real ENA 4.
      // Sending it anyway would make Homey report the toggle as
      // successful when nothing actually happened on the machine, so
      // reject both directions instead of silently no-op'ing one.
      if (!value) {
        throw new Error(
          this.homey.__('errors.cannot_power_off') ||
            'This machine cannot be switched off remotely — press the power button on the machine itself.'
        );
      } else {
        throw new Error(
          this.homey.__('errors.cannot_power_on') ||
            'This machine cannot be switched on remotely — press the power button on the machine itself.'
        );
      }
    });

    // Quick-access buttons for the only two products every bundled
    // profile has (see README.md's "Why only 2 quick buttons" note) --
    // brew_product (the flow action) stays the flexible, per-device
    // route for anything else a specific machine's profile supports.
    this.registerCapabilityListener('brew_coffee_button', async () => {
      await this.brew('coffee');
    });
    this.registerCapabilityListener('brew_espresso_button', async () => {
      await this.brew('espresso');
    });

    await this._startPolling();
  }

  async onAdded() {
    this.log('Jura machine device added:', this.getName());
  }

  async onDeleted() {
    this._stopPolling();
    if (this._client) await this._client.close().catch(() => {});
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('address') || changedKeys.includes('profile_code')) {
      this.log('Connection settings changed, reconnecting...');
      this._stopPolling();
      if (this._client) await this._client.close().catch(() => {});
      this._client = null;
      await this._startPolling();
    }
  }

  // ---------- connection ----------

  _buildClient() {
    const store = this.getStore();
    const settings = this.getSettings();
    const address = settings.address || store.address;
    const profileCode = settings.profile_code || store.profileCode || models.DEFAULT_PROFILE_CODE;
    const profile = models.getProfile(profileCode);

    return new JuraClient(address, {
      connId: store.connId,
      authHash: store.authHash,
      profile,
    });
  }

  async _connectIfNeeded() {
    if (this._client && this._client.connected) return;
    this._client = this._buildClient();
    const result = await this._client.connect(15000);
    if (result.state !== 'CORRECT') {
      // WRONG_HASH usually means the machine was reset/re-paired via the
      // official J.O.E. app since we last stored a hash -- surfacing
      // this clearly beats a cryptic downstream timeout.
      throw new Error(
        `Handshake rejected (${result.state}). If this persists, remove and re-pair the device.`
      );
    }
    if (result.newHash && result.newHash !== this.getStoreValue('authHash')) {
      await this.setStoreValue('authHash', result.newHash).catch(this.error);
    }
    this.setAvailable().catch(this.error);
  }

  // ---------- polling ----------

  async _startPolling() {
    await this._poll();
    this._pollTimer = this.homey.setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    try {
      await this._connectIfNeeded();
      const status = await this._client.readStatus(8000);
      this.log('Status:', status.activeAlerts.join(', ') || '(none)');

      // onoff reflects "not in standby" -- the closest read-only analogue
      // of power state this protocol exposes.
      this.setCapabilityValue('onoff', !status.activeAlerts.includes('goodbye')).catch(this.error);

      const hasError = status.errors.length > 0;
      this.setCapabilityValue('alarm_generic', hasError).catch(this.error);

      // fill_water, no_beans, insert_tray, empty_tray and empty_grounds
      // are all present (by name) in all 72 bundled profiles -- see
      // lib/profiles/README.md's alert survey -- so these are safe to
      // compute for any paired model, not just the E8.
      this.setCapabilityValue('alarm_water', status.activeAlerts.includes('fill_water')).catch(this.error);
      this.setCapabilityValue('alarm_beans', status.activeAlerts.includes('no_beans')).catch(this.error);
      // Two genuinely different physical states, not the same thing
      // worded differently: alarm_tray = present but full, needs
      // emptying; alarm_tray_missing = not inserted at all.
      this.setCapabilityValue(
        'alarm_tray',
        ['empty_tray', 'empty_grounds'].some((name) => status.activeAlerts.includes(name))
      ).catch(this.error);
      this.setCapabilityValue('alarm_tray_missing', status.activeAlerts.includes('insert_tray')).catch(this.error);
      // ~96-97% profile coverage, not 100% -- on profiles that lack the
      // alert name entirely, activeAlerts simply never contains it, so
      // this stays false rather than erroring.
      this.setCapabilityValue('alarm_outlet_missing', status.activeAlerts.includes('outlet_missing')).catch(this.error);
      this.setCapabilityValue('alarm_rear_cover_missing', status.activeAlerts.includes('rear_cover_missing')).catch(this.error);

      if (hasError) {
        this.setWarning(status.errors.join(', ')).catch(this.error);
      } else {
        this.unsetWarning().catch(this.error);
      }

      this._pollCount += 1;
      if (this._pollCount % MAINTENANCE_POLL_EVERY === 1) {
        try {
          const maint = await this._client.readMaintenancePercent(6000);
          this.log('Maintenance %:', `cleaning=${maint.cleaning} filter=${maint.filterChange} descale=${maint.descale}`);
          // 0xFF (255) means this machine doesn't track that maintenance
          // type (e.g. no water filter cartridge fitted) -- leave the
          // capability alone rather than showing a nonsense 255%.
          const setIfTracked = (cap, value) => {
            if (value === 0xff) return;
            this.setCapabilityValue(cap, value).catch(this.error);
          };
          setIfTracked('jura_maintenance_cleaning', maint.cleaning);
          setIfTracked('jura_maintenance_filter', maint.filterChange);
          setIfTracked('jura_maintenance_descale', maint.descale);
        } catch (err) {
          // Not every profile's firmware answers @TG:C0 -- don't let this
          // take the whole device unavailable over an optional reading.
          this.error('Maintenance percent read failed (non-fatal):', err.message);
        }
      }
    } catch (err) {
      this.error('Poll failed:', err.message);
      this.setUnavailable(friendlyPollError(err)).catch(this.error);
      if (this._client) {
        await this._client.close().catch(() => {});
        this._client = null;
      }
    }
  }

  // ---------- flow actions (registered in app.js) ----------

  /**
   * Brew a product by name (e.g. "espresso", "cappuccino") with
   * optional recipe overrides. See lib/profiles/EF533*.js for the
   * exact product names available on this machine's profile.
   * DESTRUCTIVE: dispenses immediately, no remote abort. Make sure a
   * cup is in place before calling this.
   *
   * There's no protocol command to read a machine's own personalised
   * recipe settings (the on-machine amount you dialled in yourself) --
   * @TP: always requires a complete explicit recipe, so without an
   * override every brew silently falls back to the bundled profile's
   * factory-default water amount, which won't match what you set on
   * the machine itself. The coffee_ml/espresso_ml device settings are
   * the workaround: filled in, they override the default here for
   * both the quick buttons and this same method's flow-action route.
   */
  async brew(productName, overrides = {}) {
    const finalOverrides = { ...overrides };
    if (!('water_amount' in finalOverrides)) {
      const settings = this.getSettings();
      if (productName === 'coffee' && settings.coffee_ml > 0) {
        finalOverrides.water_amount = settings.coffee_ml;
      } else if (productName === 'espresso' && settings.espresso_ml > 0) {
        finalOverrides.water_amount = settings.espresso_ml;
      }
    }
    await this._connectIfNeeded();
    const reply = await this._client.brew(productName, finalOverrides, { retry: true, timeoutMs: 8000 });
    const { isBrewAccept } = require('../../lib/juraClient');
    if (!isBrewAccept(reply)) {
      // Confirmed live (E8 and E4, so not model-specific): a machine
      // waking from energy-safe can reply to @TP: with something that
      // isn't a @tp:-prefixed frame at all, even after the wake-up
      // retry above -- yet still genuinely starts brewing a moment
      // later. Rather than hard-coding what every model's wake-up
      // reply looks like (unmaintainable across 72 profiles, and we
      // only have hard data for 2), fall back to asking the machine
      // itself: if it's actively heating up, the brew clearly did
      // start, whatever that reply was.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      let heatingUp = false;
      try {
        const status = await this._client.readStatus(6000);
        heatingUp = status.activeAlerts.includes('heating_up');
      } catch (err) {
        this.error('Post-brew status check failed (non-fatal):', err.message);
      }
      if (!heatingUp) {
        throw new Error(`Machine did not accept the brew command (reply: ${reply})`);
      }
      this.log(`Brew accepted despite an unrecognised reply (${reply}) -- machine is heating up`);
    }
    return reply;
  }

}

module.exports = JuraMachineDevice;
