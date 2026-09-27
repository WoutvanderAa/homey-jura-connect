'use strict';

const { Device } = require('homey');
const models = require('../../lib/models');
const profileLib = require('../../lib/profile');
const { JuraClient } = require('../../lib/juraClient');

// How often to poll @HU? for a status frame while idle. Drives alarms,
// onoff and available/unavailable -- kept short so those feel
// responsive rather than lagging up to a full interval behind reality.
const POLL_INTERVAL_MS = 10000;

// Maintenance percent (@TG:C0) doesn't change fast enough to need every
// cycle -- read it once every 30th poll (~5 min at the 10s interval
// above) instead.
const MAINTENANCE_POLL_EVERY = 30;

// Maps each maintenance-percent capability to its "crossed above" flow
// trigger card id (both registered in app.js) -- see _poll()'s
// maintenance-read block below for where these actually get triggered.
const MAINTENANCE_TRIGGER_IDS = {
  jura_maintenance_cleaning: 'jura_maintenance_cleaning_crossed_above',
  jura_maintenance_filter: 'jura_maintenance_filter_crossed_above',
  jura_maintenance_descale: 'jura_maintenance_descale_crossed_above',
};

// The WiFi module goes fully offline when the machine is powered off or
// hits its auto-off timer -- surface that plainly instead of a raw
// socket error code.
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH']);

// Confirmed live: the machine can become briefly unreachable for
// several polls in a row while it's physically brewing (grinding/
// pumping/heating draws enough power to make its own WiFi module
// unresponsive for a bit) -- reproduced with no relation to anything
// this app sends, i.e. not something fixable from the client side.
// Only flip to unavailable after this many *consecutive* failed polls,
// so one such hiccup doesn't flicker the device tile every time
// something brews. A real outage (powered off, out of range, auto-off
// timer) still shows unavailable soon enough -- POLL_INTERVAL_MS apart.
const POLL_FAIL_THRESHOLD = 3;

// Alert names seen around an active brew cycle on the E8's own alert
// table (lib/profiles/EF538.js) -- used by brew()'s post-reply fallback
// below. heating_up alone missed a second confirmed-live false-negative
// (reply @TB, coffee genuinely brewed) where the machine was already at
// temperature and so never went through a heating_up phase at all.
const BREW_IN_PROGRESS_ALERTS = [
  'heating_up',
  'coffee_ready',
  'coffee_rinsing',
  'please_wait',
  'enjoy_product',
  'system_filling',
];

// Confirmed live: even the widened alert list above can still miss a
// single point-in-time check -- an espresso needing a real cold-start
// heat-up can take longer than one snapshot 3s after the reply covers,
// so the brew-in-progress state may not have started yet (or may have
// already passed) at the moment we happen to look. Check a few times
// spread out instead of once, stopping as soon as any of them matches.
const BREW_STATUS_CHECK_ATTEMPTS = 3;
const BREW_STATUS_CHECK_INTERVAL_MS = 3000;
function friendlyPollError(err) {
  if (UNREACHABLE_CODES.has(err.code)) {
    return 'Machine appears to be off or unreachable on the network.';
  }
  return err.message;
}

/**
 * The name of this profile's "plain hot water" product, or null if it
 * doesn't have one -- used to conditionally show brew_hotwater_button
 * (see _syncHotwaterCapability below), unlike brew_coffee_button/
 * brew_espresso_button which every bundled profile has.
 *
 * Surveyed across all 72 bundled profiles: `hotwater_portion` is the
 * name on 43 of them; on the other profiles that have hot water at
 * all, the XML instead calls it `hotwater_portion_normal` (the two
 * names never coexist on the same profile -- confirmed, not assumed)
 * because that profile also offers temperature/flavour-specific
 * variants like `hotwater_portion_green_tea`. Together the two names
 * cover 67/72 profiles; the remaining 5 (all coffee-focused, e.g.
 * EF532coffeeonly) genuinely have no hot water product at all.
 */
function resolveHotwaterProductName(profile) {
  const names = new Set(profile.products.filter((p) => p.active !== false).map((p) => p.name));
  if (names.has('hotwater_portion')) return 'hotwater_portion';
  if (names.has('hotwater_portion_normal')) return 'hotwater_portion_normal';
  return null;
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

    // Deliberately no remove/re-add migration here anymore -- the
    // previous version did this on every single init (removing then
    // re-adding alarm_beans/alarm_tray/alarm_tray_missing below just to
    // pick up their icon), against Athom's own docs ("do not call
    // removeCapability on every init!"). Any device that ever ran 0.4.1
    // or later already has the icon from app.json's capability
    // definitions, and Homey updates installed apps automatically.

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
    this._connectPromise = null;
    this._pollTimer = null;
    this._pollCount = 0;
    this._pollFailCount = 0;
    this._polling = false;
    await this._syncHotwaterCapability();
    await this._syncStrengthOptionLabels();

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

    // Quick-access buttons. Coffee/espresso are the only two products
    // every bundled profile has, so these two are always added (see
    // README.md's "Why only 2 quick buttons" note for why there isn't
    // a wider fixed menu here) -- brew_hotwater_button is the one
    // exception, conditionally added below since not every machine has
    // hot water. brew_product (the flow action) stays the flexible,
    // per-device route for anything else a specific machine supports.
    this.registerCapabilityListener('brew_coffee_button', async () => {
      await this.brew('coffee');
    });
    this.registerCapabilityListener('brew_espresso_button', async () => {
      await this.brew('espresso');
    });
    // Safe to register even on a device that doesn't have this
    // capability right now (_syncHotwaterCapability above decides
    // that per-device) -- Homey simply never fires a listener for a
    // capability a device doesn't have.
    this.registerCapabilityListener('brew_hotwater_button', async () => {
      await this.brew(this._hotwaterProductName);
    });

    await this._startPolling();
  }

  /**
   * Add or remove brew_hotwater_button depending on whether this
   * specific device's machine actually has a hot water product --
   * unlike brew_coffee_button/brew_espresso_button (both 100% bundled-
   * profile coverage), only ~93% of profiles do (see
   * resolveHotwaterProductName), so this can't just be a static entry
   * in the driver's default capability list the way those two are.
   * Re-run from onSettings when profile_code changes, in case a
   * correction adds or removes hot water support.
   */
  async _syncHotwaterCapability() {
    const profile = this._resolveProfile();
    this._hotwaterProductName = resolveHotwaterProductName(profile);
    if (this._hotwaterProductName) {
      if (!this.hasCapability('brew_hotwater_button')) {
        await this.addCapability('brew_hotwater_button').catch(this.error);
        this.setCapabilityOptions('brew_hotwater_button', {
          icon: '/drivers/jura-machine/assets/button_hotwater.svg',
        }).catch(this.error);
      }
    } else if (this.hasCapability('brew_hotwater_button')) {
      await this.removeCapability('brew_hotwater_button').catch(this.error);
    }
  }

  /**
   * Fill in the read-only coffee_strength_options/espresso_strength_options
   * settings labels with this specific device's own valid strength
   * values (see lib/profile.js's describeStrengthScale) -- the closest
   * thing to a per-device dropdown that Homey's static settings schema
   * allows. Shows the number to type into coffee_strength/
   * espresso_strength below, not the raw wire byte -- see
   * strengthScale's own doc comment for why those two can differ.
   * Re-run from onSettings when profile_code changes.
   */
  async _syncStrengthOptionLabels() {
    const profile = this._resolveProfile();
    const optionsFor = (productName) => {
      const product = profile.products.find((p) => p.name === productName);
      const param = product && product.params.find((p) => p.kind === 'coffee_strength');
      return profileLib.describeStrengthScale(param);
    };
    this.setSettings({
      coffee_strength_options: optionsFor('coffee'),
      espresso_strength_options: optionsFor('espresso'),
    }).catch(this.error);
  }

  async onAdded() {
    this.log('Jura machine device added:', this.getName());
  }

  async onDeleted() {
    this._stopPolling();
    if (this._client) await this._client.close().catch(() => {});
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    // Validate first, before any of the side effects below run --
    // Homey surfaces a thrown Error here to the user and keeps the old
    // settings, so a rejected strength level shouldn't leave a
    // reconnect or a capability sync half-applied for a save that never
    // actually took effect. Resolved against `newSettings` (not yet
    // reflected in this.getSettings()/_resolveProfile()'s own default),
    // since a profile_code change in this same save can itself be what
    // makes the strength invalid.
    const newProfile = this._resolveProfile(newSettings);
    for (const [settingKey, productName, label] of [
      ['coffee_strength', 'coffee', 'Coffee'],
      ['espresso_strength', 'espresso', 'Espresso'],
    ]) {
      const level = newSettings[settingKey];
      if (level > 0 && (changedKeys.includes(settingKey) || changedKeys.includes('profile_code'))) {
        const product = newProfile.products.find((p) => p.name === productName);
        const param = product && product.params.find((p) => p.kind === 'coffee_strength');
        if (!profileLib.strengthScale(param).levels.some((l) => l.level === level)) {
          throw new Error(
            `${label} strength ${level} isn't available on this machine. Valid: ${profileLib.describeStrengthScale(param)}.`
          );
        }
      }
    }

    if (changedKeys.includes('profile_code')) {
      // A corrected profile can add or remove hot water support, and
      // changes which strength values are valid.
      await this._syncHotwaterCapability();
      await this._syncStrengthOptionLabels();
    }
    if (changedKeys.includes('address') || changedKeys.includes('profile_code')) {
      this.log('Connection settings changed, reconnecting...');
      this._stopPolling();
      if (this._client) await this._client.close().catch(() => {});
      this._client = null;
      await this._startPolling();
    }
  }

  // ---------- connection ----------

  /**
   * The profile for this device's machine -- settings override the
   * store. Takes an explicit `settings` object (defaulting to the
   * already-saved this.getSettings()) so onSettings can resolve against
   * `newSettings` -- the settings Homey is about to save, not yet
   * reflected in this.getSettings() -- to validate a profile_code
   * change before it takes effect.
   */
  _resolveProfile(settings = this.getSettings()) {
    const store = this.getStore();
    const profileCode = settings.profile_code || store.profileCode || models.DEFAULT_PROFILE_CODE;
    return models.getProfile(profileCode);
  }

  _buildClient() {
    const store = this.getStore();
    const settings = this.getSettings();
    const address = settings.address || store.address;
    const profile = this._resolveProfile();

    return new JuraClient(address, {
      connId: store.connId,
      authHash: store.authHash,
      // @HP: includes the pin on every handshake, not just the first --
      // a machine with a security PIN set (via the J.O.E. app) needs it
      // again on every reconnect, not only during pairing.
      pin: store.pin || '',
      profile,
    });
  }

  /**
   * Connect if there's no live connection yet. Concurrent callers (the
   * poll timer and a flow-triggered brew() can genuinely overlap --
   * setInterval doesn't wait for the previous _poll() to finish, and
   * brew() calls this independently) share the one in-flight attempt
   * via _connectPromise instead of each racing to open their own
   * socket. Without this, two callers that both see "not connected" at
   * the same moment would each build a separate JuraClient and connect
   * separately; whichever finished last would win the this._client
   * assignment and the other's socket would be silently orphaned --
   * never closed, just left open. The Jura WiFi dongle likely only
   * accepts one connection at a time, so a leaked one like that would
   * make every subsequent connection attempt fail until the machine's
   * own idle-connection timeout eventually cleans it up.
   */
  async _connectIfNeeded() {
    if (this._client && this._client.connected) return;
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect();
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  async _doConnect() {
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
    // setInterval fires on a fixed cadence regardless of whether the
    // previous _poll() finished -- a slow cycle (reconnect + an 8s
    // readStatus timeout can already exceed POLL_INTERVAL_MS on its
    // own) could otherwise let two calls run at once. Skip rather than
    // pile up; the next tick picks up where this one left off anyway.
    if (this._polling) return;
    this._polling = true;
    try {
      await this._connectIfNeeded();
      const status = await this._client.readStatus(8000);
      this._pollFailCount = 0;
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
            const previousValue = this.getCapabilityValue(cap);
            this.setCapabilityValue(cap, value).catch(this.error);
            // previousValue is null the very first time this is ever read
            // (capability has no value yet) -- nothing to have "crossed"
            // from, so skip triggering rather than firing on every flow's
            // threshold on that first reading.
            if (previousValue !== null && previousValue !== value) {
              this.homey.flow
                .getDeviceTriggerCard(MAINTENANCE_TRIGGER_IDS[cap])
                .trigger(this, { value }, { value, previousValue })
                .catch(this.error);
            }
          };
          setIfTracked('jura_maintenance_cleaning', maint.cleaning);
          setIfTracked('jura_maintenance_filter', maint.filterChange);
          setIfTracked('jura_maintenance_descale', maint.descale);
        } catch (err) {
          // Not every profile's firmware answers @TG:C0 -- don't let this
          // take the whole device unavailable over an optional reading.
          this.error('Maintenance percent read failed (non-fatal):', err.message);
        }

        // Lifetime brew total (@TR:32 page 0) -- shown as a read-only
        // settings-page field rather than a capability, since it's a
        // single slow-changing stat, not something worth an Insights
        // graph or a device-tile slot. Same "not every profile answers
        // this bank" reality as the maintenance percent read above, so
        // same non-fatal handling -- but distinguished from a merely
        // transient failure (timeout, disconnect) so a network hiccup
        // doesn't wrongly overwrite the field with "not supported".
        try {
          const total = await this._client.readTotalBrewCount(6000);
          this.setSettings({ total_brews: String(total) }).catch(this.error);
        } catch (err) {
          if (/does not implement the @TR:32/.test(err.message)) {
            this.setSettings({ total_brews: 'Not supported by this machine' }).catch(this.error);
          }
          this.error('Total brew count read failed (non-fatal):', err.message);
        }
      }
    } catch (err) {
      this._pollFailCount += 1;
      this.error(`Poll failed (${this._pollFailCount}/${POLL_FAIL_THRESHOLD}):`, err.message);
      // Only flip the device tile to unavailable once a hiccup has
      // outlasted a couple of poll cycles -- see POLL_FAIL_THRESHOLD.
      if (this._pollFailCount >= POLL_FAIL_THRESHOLD) {
        this.setUnavailable(friendlyPollError(err)).catch(this.error);
      }
      if (this._client) {
        await this._client.close().catch(() => {});
        this._client = null;
      }
    } finally {
      this._polling = false;
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
   * recipe settings (the on-machine amount/strength you dialled in
   * yourself) -- @TP: always requires a complete explicit recipe, so
   * without an override every brew silently falls back to the bundled
   * profile's factory-default water amount and strength, which won't
   * match what you set on the machine itself. Confirmed live: a real
   * E4 always brewed at strength level 2 ("normal") regardless of what
   * was last set on the machine, since nothing here ever overrode it.
   * The coffee_ml/espresso_ml/coffee_strength/espresso_strength/
   * hotwater_ml device settings are the workaround: filled in, they
   * override the default here for both the quick buttons and this same
   * method's flow-action route. Strength's valid range varies by
   * machine (most 1-10, some fewer), and on a few profiles the level
   * number the machine displays doesn't match the XML's raw wire byte
   * at all -- see lib/profile.js's strengthScale. strengthLevelToWire()
   * translates the displayed level to that wire byte and rejects one
   * this device's profile doesn't have, rather than this method trying
   * to know every machine's own scale.
   */
  async brew(productName, overrides = {}) {
    const finalOverrides = { ...overrides };
    const settings = this.getSettings();
    if (!('water_amount' in finalOverrides)) {
      if (productName === 'coffee' && settings.coffee_ml > 0) {
        finalOverrides.water_amount = settings.coffee_ml;
      } else if (productName === 'espresso' && settings.espresso_ml > 0) {
        finalOverrides.water_amount = settings.espresso_ml;
      } else if (
        (productName === 'hotwater_portion' || productName === 'hotwater_portion_normal') &&
        settings.hotwater_ml > 0
      ) {
        finalOverrides.water_amount = settings.hotwater_ml;
      }
    }
    if (!('coffee_strength' in finalOverrides)) {
      // Translates the displayed level (what the user typed, and what
      // _syncStrengthOptionLabels told them was valid) to the actual
      // wire byte -- see strengthLevelToWire's own doc comment for why
      // a plain number can't just be passed through to encodeParam.
      const strengthParam = (name) => {
        const product = this._resolveProfile().products.find((p) => p.name === name);
        return product && product.params.find((p) => p.kind === 'coffee_strength');
      };
      if (productName === 'coffee' && settings.coffee_strength > 0) {
        finalOverrides.coffee_strength = profileLib.strengthLevelToWire(strengthParam('coffee'), settings.coffee_strength);
      } else if (productName === 'espresso' && settings.espresso_strength > 0) {
        finalOverrides.coffee_strength = profileLib.strengthLevelToWire(strengthParam('espresso'), settings.espresso_strength);
      }
    }
    await this._connectIfNeeded();
    const reply = await this._client.brew(productName, finalOverrides, { retry: true, timeoutMs: 8000 });
    const { isBrewAccept } = require('../../lib/juraClient');
    if (!isBrewAccept(reply)) {
      // Confirmed live on a real E8, twice now, with two different
      // unrecognised replies (@hu:800, then @TB) both times a genuine
      // successful brew: the machine doesn't always confirm @TP: with a
      // @tp:-prefixed frame. Rather than loosening isBrewAccept itself
      // (risky -- we don't actually know every rejection reply looks
      // like @tp:00 either, on this or the other 71 profiles, so that
      // could turn a real rejection into a silent false "success"),
      // fall back to asking the machine itself whether anything is
      // happening. heating_up alone missed the @TB case: the machine
      // was already at temperature, so it never went through a
      // heating_up phase for that brew at all. Check the fuller set of
      // brew-cycle-adjacent alerts instead -- still a pure add-on that
      // can only *suppress* a false error, never manufacture a false
      // success, and still a no-op on profiles that don't define these
      // alert names (same as any other alarm a machine can't report).
      // A single snapshot can still miss the window (confirmed live: an
      // espresso needing a real cold-start heat-up outlasted one check),
      // so try a few times spread out rather than looking just once.
      let matchedAlert = null;
      for (let attempt = 1; attempt <= BREW_STATUS_CHECK_ATTEMPTS && !matchedAlert; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, BREW_STATUS_CHECK_INTERVAL_MS));
        try {
          const status = await this._client.readStatus(6000);
          matchedAlert = BREW_IN_PROGRESS_ALERTS.find((a) => status.activeAlerts.includes(a)) || null;
        } catch (err) {
          this.error(
            `Post-brew status check ${attempt}/${BREW_STATUS_CHECK_ATTEMPTS} failed (non-fatal):`,
            err.message
          );
        }
      }
      if (!matchedAlert) {
        throw new Error(`Machine did not accept the brew command (reply: ${reply})`);
      }
      this.log(`Brew accepted despite an unrecognised reply (${reply}) -- machine shows "${matchedAlert}"`);
    }
    return reply;
  }

}

module.exports = JuraMachineDevice;
