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
   */
  async brew(productName, overrides = {}) {
    await this._connectIfNeeded();
    const reply = await this._client.brew(productName, overrides, { retry: true, timeoutMs: 8000 });
    const { isBrewAccept } = require('../../lib/juraClient');
    if (!isBrewAccept(reply)) {
      throw new Error(`Machine did not accept the brew command (reply: ${reply})`);
    }
    return reply;
  }

}

module.exports = JuraMachineDevice;
