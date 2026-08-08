'use strict';

const { Device } = require('homey');
const models = require('../../lib/models');
const { JuraClient } = require('../../lib/juraClient');

// How often to poll @HU? for a status frame while idle.
const POLL_INTERVAL_MS = 30000;

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

    this._client = null;
    this._pollTimer = null;

    this.registerCapabilityListener('onoff', async (value) => {
      // The machine has no remote power-on over this protocol (WifiFrog
      // has no equivalent of the Bluetooth @AN:01); it can only be
      // switched to standby. Powering off is possible, powering back on
      // from Homey is not -- reflect that rather than silently failing.
      if (!value) {
        await this._connectIfNeeded();
        await this._client.sendCommand('@AN:02');
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

      if (hasError) {
        this.setWarning(status.errors.join(', ')).catch(this.error);
      } else {
        this.unsetWarning().catch(this.error);
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
