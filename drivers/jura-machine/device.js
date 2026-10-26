'use strict';

const { Device } = require('homey');
const models = require('../../lib/models');
const profileLib = require('../../lib/profile');
const { JuraClient, MachineStatus, AUTH_HASH_RE, PairingTimeout, isMachineClosedError, monotonicMs } = require('../../lib/juraClient');
const { redactFrame, clipText } = require('../../lib/frameLog');

// How often to poll @HU? for a status frame while idle. Drives alarms,
// onoff and available/unavailable -- kept short so those feel
// responsive rather than lagging up to a full interval behind reality.
const POLL_INTERVAL_MS = 10000;

// How long brew() waits for the machine to answer @TP: before giving up
// -- referenced both when calling JuraClient.brew() and in the
// BREW_NO_REPLY user message below, so the two can't drift apart.
const BREW_TIMEOUT_MS = 8000;

// How long an earlier brew that ended in doubt (BREW_NO_REPLY or
// BREW_CONNECTION_LOST: its command may have reached the machine) still counts
// when brew() words a failure that sent nothing, see _brewNotSentText.
const UNCERTAIN_BREW_WINDOW_MS = 60000;

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

// What a read-only label in the settings page's Statistics group shows when
// there is nothing to show (no reading yet, or the machine doesn't track
// that maintenance type) -- same as the labels' own "value" in app.json.
const STATISTICS_PLACEHOLDER = '—';

// The WiFi module goes fully offline when the machine is powered off or
// hits its auto-off timer -- surface that plainly instead of a raw
// socket error code.
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH']);

// Seen live: polls used to fail several times in a row while the
// machine was physically brewing. That was first put down to the WiFi
// module dropping out under load, but the most likely explanation is
// that the @TF: status broadcast itself pauses for the length of a
// brew (see _readStatusOnce in lib/juraClient.js). Since 0.12.2 any
// other frame counts as a sign of life there, so only genuine silence
// still counts as a failed poll here.
// Since 0.13.0 this no longer decides anything for the tile: it goes
// unavailable on time without a successful poll (TIMING.UNAVAILABLE_AFTER_MS
// below), not on a number of failed polls. It is still the "/3" of the "Poll
// failed (n/3)" log line, which reports and tests rely on, and it is where the
// log goes quiet: the first POLL_FAIL_THRESHOLD failed polls in a row get their
// own line, the last of them is followed by one line that says so (see
// _logPollFailure), and from then on only a summary every
// TIMING.QUIET_SUMMARY_MS, until a poll works again.
const POLL_FAIL_THRESHOLD = 3;

// When the machine is switched off it sends a @TF: with this alert set (the name
// is the same in all 72 bundled profiles), the announcement that it is
// switching off, and goes quiet about 20 s later: see _noteStatusForSwitchOff.
const SWITCH_OFF_ALERT = 'switch_off_delay_active';

// Alerts that are the machine switching off and no fault, whatever severity a
// profile gives them (it is `error` in all 72): they count for neither the
// generic alarm nor the warning (see _applyStatus). please_wait comes just
// before the announcement. Both stay in the `Status:` line.
const NOT_A_FAULT_ALERTS = new Set([SWITCH_OFF_ALERT, 'please_wait']);

// What the tile says from the moment the machine is lost after it announced
// that it is switching off (see _poll).
const SWITCHED_OFF_TEXT = 'The machine is switched off.';

// Everything about when this device connects again and when its tile goes
// unavailable. One frozen object: a test scales a copy on the instance
// (`device._timing = { ...TIMING, RECONNECT_GAP_MS: 200 }`) and never touches
// these production values.
//
//  RECONNECT_GAP_MS      The WiFi module resets a connection that is opened
//                        too soon after the previous session ended
//                        (PROTOCOL.md 4.5), and a reset that arrives as
//                        another session end keeps the loop going. So a new
//                        connection waits at least this long after the end of
//                        ANY session: our own close, a FIN or RST from the
//                        machine, a failed poll or connect, a cancelled
//                        connect. A poll in that time is skipped (not a
//                        failure); a brew waits the rest, at most this long.
//  RECONNECT_MAX_MS      After a connect that failed the wait grows: the gap,
//                        twice the gap, then this (20, 40, 60 s), until a
//                        connect succeeds again. Only a connect that had a TCP
//                        session counts (a refused, reset or unanswered
//                        handshake): a machine that cannot be reached at all,
//                        because it is off, keeps the gap, so that it is back
//                        within the gap and a poll after it is switched on.
//                        It applies to polls only; a brew never waits longer
//                        than the gap.
//  UNAVAILABLE_AFTER_MS  The tile goes unavailable once this long has passed
//                        without a successful poll (a status was read, or the
//                        machine answered busy: that is a sign of life), and
//                        not before. Counted in time, not in polls.
//  BUSY_MAX_MS           A machine that for this long only answers busy
//                        (STATUS_BUSY: it answers @HU? but never sends a @TF:
//                        again) gets its connection reset, once, with a line
//                        in the log, and the count of busy time starts over.
//                        It is no failed poll and never makes the tile
//                        unavailable: a cleaning or descaling programme of
//                        more than this has not been measured, and the tile
//                        must not go unavailable because of one. A brew is
//                        far shorter than this.
//  BREW_DEADLINE_MS      How long a brew has, from the moment brew() is called,
//                        to get its command written: a brew that has to wait
//                        for a poll, for the gap or for a slow connect and is
//                        not there in time sends nothing and says so (see
//                        brew()). It limits the sending only: once the command
//                        is out, the wait for the machine's answer comes on
//                        top of it. And it does not cut off the gap, the
//                        socket or the handshake: the message can come later
//                        than the deadline, up to about 40 s after the tap,
//                        but after the deadline no @TP: is ever sent. The time
//                        the Homey interface waits for a flow action must
//                        therefore be at least max(D + 12.5 s; 40 s), with D
//                        this value. 30 s is provisional, until measured on
//                        the machine (step L2).
//  QUIET_SUMMARY_MS      While the log is quiet (POLL_FAIL_THRESHOLD failed
//                        polls in a row, see _logPollFailure) it gets one
//                        summary line this often, counted from the line that
//                        said the log went quiet. Checked at every poll, so it
//                        can come up to a poll cycle late.
//  SWITCH_OFF_WINDOW_MS  How long after the machine announced that it is
//                        switching off (see _noteStatusForSwitchOff) a poll
//                        that fails is the machine having been switched off,
//                        and no failure (see _poll). Measured on the machine:
//                        it stops answering 19.5 to 27.9 s after the
//                        announcement, so this is more than four times that.
//                        A poll that works inside the window does not end it:
//                        the machine goes on answering for about 20 s. An
//                        announcement that is not followed by a loss within
//                        the window lapses without a trace.
//  FRAME_LINES_PER_MIN   The most frame lines ("[frame] hh:mm:ss.mmm TX ...") the
//                        log gets in a fixed minute, for the device and not per
//                        client: a reconnect does not start with a new budget.
//                        What is over is counted and not written; the count
//                        comes in one line, in front of the next frame line that
//                        is written (see _logFrame). The peak measured is 35 a
//                        minute. While the log is quiet (see _logPollFailure)
//                        none is written at the time: the newest
//                        QUIET_FRAMES_KEPT are kept and written when the quiet
//                        ends, outside this budget (see _flushQuietFrames).
const TIMING = Object.freeze({
  RECONNECT_GAP_MS: 20000,
  RECONNECT_MAX_MS: 60000,
  UNAVAILABLE_AFTER_MS: 60000,
  BUSY_MAX_MS: 300000,
  BREW_DEADLINE_MS: 30000,
  QUIET_SUMMARY_MS: 900000,
  SWITCH_OFF_WINDOW_MS: 120000,
  FRAME_LINES_PER_MIN: 100,
});

// The error that ends a connect which a reset or a delete has cancelled (see
// _closeIfStale, _waitForGap, and the catch of _doConnect, which gives it to a
// connect that failed because the device itself reset the client). Its code
// tells _doConnect that the machine did nothing wrong.
const CONNECT_CANCELLED_CODE = 'CONNECT_CANCELLED';

function connectCancelledError() {
  const err = new Error('Connection attempt cancelled: the device was reset or removed while it was connecting.');
  err.code = CONNECT_CANCELLED_CODE;
  return err;
}

// How often _poll() writes the one-line health summary to the log. There is
// no timer for it: the end of every poll checks whether this long has passed
// since the previous line (see _logHealth).
const HEALTH_EVERY_MS = 300000;

// The length of the fixed window in which TIMING.FRAME_LINES_PER_MIN frame lines
// are let through (see _logFrame).
const FRAME_WINDOW_MS = 60000;

// How many frame lines are kept while the log is quiet, to be written when the
// quiet ends (see _logFrame, _flushQuietFrames). The newest ones: the frames of
// the connection that ends the quiet are the last to come.
const QUIET_FRAMES_KEPT = 30;

// Text that came from the machine (a brew reply, the reason a connection
// ended) goes into a user message or a log line only after redactFrame and
// cut to this length, so a frame that quotes a secret, holds a line break or
// runs on for kilobytes can neither leak, fake a log line nor fill a report.
const MACHINE_TEXT_MAX = 120;

// The longest text handed to setUnavailable, which Homey shows on the tile.
const UNAVAILABLE_TEXT_MAX = 200;

// Log lines that carry an error message get more room than text shown to a
// user: the message is mostly our own, and a cut one hides the cause.
const LOG_TEXT_MAX = 300;

// The figures of takeStats() that add up over clients (see _bankStats). The
// longest @TF: gap is a maximum, not a sum, so it is handled apart; the
// average follows from tfGapSumMs and tfGapCount.
const BANKED_SUM_KEYS = ['tf', 'tv', 'hu', 'markers', 'other', 'tfGapCount', 'tfGapSumMs', 'droppedReplies'];

// The text of the timeout that JuraClient._rawConnect gives a socket that did
// not open in time.
const CONNECT_TIMEOUT_RE = /^connect timeout after /;

// The text of the timeout that JuraClient._doHandshake gives a handshake that
// was not answered in time (a PairingTimeout), with or without the question
// that follows it.
const HANDSHAKE_TIMEOUT_RE = /^no handshake reply within /;

/**
 * Whether a connect failed before there was any TCP session: the socket could
 * not be opened (an error code of UNREACHABLE_CODES: the machine is off or not
 * reachable) or did not open in time (the timeout of the raw socket). With no
 * session the machine cannot have reset anything because we came back too soon,
 * so such a failure does not lengthen the wait for the next connect (see
 * _doConnect). A handshake that was refused, reset or not answered did have a
 * session, and does count.
 */
function failedWithoutSession(err) {
  return UNREACHABLE_CODES.has(err.code) || CONNECT_TIMEOUT_RE.test(String(err.message));
}

function friendlyPollError(err) {
  // Also the connect that timed out: no TCP session, the same as a machine that
  // is off.
  if (failedWithoutSession(err)) {
    return 'Machine appears to be off or unreachable on the network.';
  }
  // A reset or a FIN of the machine: the log keeps the raw text, the tile gets
  // a sentence that says what to do (the J.O.E. app is the usual cause).
  if (isMachineClosedError(err)) {
    return 'The machine ended the connection. If the J.O.E. app is connected to the machine, close it; the connection is retried automatically.';
  }
  // A handshake the machine did not answer: the raw text asks whether the user
  // accepted on the machine, which is worded for pairing and means nothing to a
  // poll or a brew. The log keeps the raw text; the pairing flow (driver.js)
  // passes it on as it is.
  if (err instanceof PairingTimeout || HANDSHAKE_TIMEOUT_RE.test(String(err.message))) {
    return 'The machine did not answer when connecting. If the J.O.E. app is connected to the machine, close it; the connection is retried automatically.';
  }
  return err.message;
}

/** Text that may quote a frame, made safe to show or log: see MACHINE_TEXT_MAX. */
function safeText(text, max = MACHINE_TEXT_MAX) {
  return clipText(redactFrame(text), max);
}

// What an error code looks like when it is a name (EHOSTUNREACH, ETIMEDOUT) and
// not text: see pollFailClass.
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/;

// The start of the message that _doConnect gives a handshake the machine
// rejected (a state other than CORRECT, such as WRONG_HASH after the auth token
// changed). That error has no code, and the text is made by the device itself,
// not taken from the machine: the machine's own text is not in the part that is
// matched.
const HANDSHAKE_REJECTED_RE = /^Handshake rejected \(/;

/**
 * The kind of a failed poll, as one short word or two for the quiet log lines
 * (see _logPollFailure): never the message of the error, which can quote an IP
 * address or a frame. The error's own code when it is a name (EHOSTUNREACH,
 * ECONNREFUSED, ETIMEDOUT), else "handshake rejected" for a handshake the
 * machine rejected, else "no reply" for a read that got no answer, else
 * "machine closed" for a connection the machine ended, else "error".
 */
function pollFailClass(err) {
  if (typeof err.code === 'string' && ERROR_CODE_RE.test(err.code)) return err.code;
  if (HANDSHAKE_REJECTED_RE.test(String(err.message))) return 'handshake rejected';
  if (/^no reply to/.test(String(err.message))) return 'no reply';
  if (isMachineClosedError(err)) return 'machine closed';
  return 'error';
}

/** A time span for the log, rounded down: "42 s", "17 min" or "3 h 5 min". */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The frame figures of clients that are gone: all zero. */
function emptyBankedStats() {
  return { tf: 0, tv: 0, hu: 0, markers: 0, other: 0, tfGapCount: 0, tfGapSumMs: 0, tfMaxMs: 0, droppedReplies: 0 };
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
    // Raised by every _resetClient(): a connect that was started under an
    // older number belongs to a client that was reset or deleted meanwhile,
    // see _doConnect.
    this._clientGeneration = 0;
    this._pollTimer = null;
    this._pollCount = 0;
    // Whether the maintenance reads are owed (see _poll): set on every
    // MAINTENANCE_POLL_EVERY-th poll, cleared when they are made.
    this._maintenanceDue = false;
    this._pollFailCount = 0;
    this._polling = false;
    // What _applyStatus last applied: the raw status and the text of the
    // `Status:` line (both null: none yet, or the connection was reset since),
    // the warning text (undefined: none set by this device yet, or the last
    // call failed, null: the warning was cleared), and the capabilities whose
    // last set failed and are set again whatever their value, see there.
    this._appliedRawHex = null;
    this._appliedStatusLine = null;
    // The text of the `Maintenance %:` line last written (null: none yet, or
    // the connection was reset since), see _poll.
    this._loggedMaintenanceLine = null;
    this._appliedWarning = undefined;
    this._retryCaps = new Set();
    // When the last session, or attempt at one, ended, whoever ended it (see
    // _noteSessionEnd); null until the first one, so the very first connect
    // does not wait.
    this._lastSessionEndAt = null;
    // Connects in a row that failed, cancelled ones and ones that never had a
    // TCP session (see failedWithoutSession) not counted: it sets how long the
    // next one waits (see _reconnectWaitMs). Starts over at the next connect
    // that works.
    this._connectFailures = 0;
    // The wait of a connect for the gap, if one is running, so a reset can
    // cancel it (see _waitForGap).
    this._gapWait = null;
    // The last client whose connection the machine ended (see _buildClient's
    // onClose), as opposed to one the device threw away itself: both raise
    // `_clientGeneration`, only this tells them apart (see _doConnect).
    this._endedByMachine = null;
    // Whether the log already says that polls are being skipped for the gap,
    // so a run of skipped polls gives one line (see _poll).
    this._pollSkipLogged = false;
    // Whether the last end noted by _noteSessionEnd was that of a real session
    // (a TCP connection that was open and then ended), and not of a connect that
    // never got one: only the first needs the pause the log line of a skipped
    // poll talks about (see _skipPoll).
    this._lastEndHadSession = true;
    // For the quiet log (see _logPollFailure): when the first failed poll of the
    // run in progress was (null when none), when the next summary is due (null
    // unless the log has gone quiet), and what kind the last failed poll was.
    this._failRunSince = null;
    this._quietNextSummaryAt = null;
    this._lastFailClass = '';
    // For the budget of the frame lines (see _logFrame): when the minute being
    // counted began (null: none yet), how many frame lines it has let through,
    // and how many were left out since the line that said so last. And the
    // newest frame lines of the quiet log, kept to be written when it ends.
    this._frameWindowAt = null;
    this._frameWindowLines = 0;
    this._frameLeftOut = 0;
    this._quietFrames = [];
    // For the switch-off (see _noteStatusForSwitchOff, _poll): when the machine
    // last announced that it is switching off (null: it did not, or the run of
    // failed polls it led to is over), whether the run of failed polls in
    // progress is the machine being switched off, and how many polls of that run
    // failed. Those are not counted in `_pollFailCount`: that is the "n" of the
    // "Poll failed (n/3)" lines, and a machine that is switched off is no failure.
    this._switchOffAnnouncedAt = null;
    this._switchedOff = false;
    this._offFailedPolls = 0;
    // For the tile: the last time a poll showed the machine alive (a status
    // was read, or it answered busy), since when the machine has only
    // answered busy, what the last failed poll said, and whether the tile is
    // available. null is unknown: it has not been checked whether Homey still
    // shows the tile as unavailable from before an app restart, so the first
    // poll that works says setAvailable once, to be sure (see _pollSucceeded).
    this._lastAliveAt = this._monotonicNow();
    this._busySince = null;
    this._lastFailText = '';
    this._available = null;
    // Whether a setAvailable or setUnavailable call is still on its way (see
    // _setTile).
    this._tileCallPending = false;
    // For the health line (_logHealth): polls by outcome and reconnects since
    // the previous line, when that line was written, and when the current
    // connection was made.
    this._healthPolls = { ok: 0, busy: 0, fail: 0 };
    this._healthReconnects = 0;
    this._lastHealthAt = this._monotonicNow();
    this._hasConnected = false;
    this._sessionStartedAt = null;
    // Why the last client that _resetClient() threw away had ended; kept until
    // the next one, as a state.
    this._lastCloseReason = '';
    // For the text of a brew that sent nothing (see _brewNotSentText): how many
    // brew() calls of this device are running right now, and when (on the
    // monotonic clock) the last brew ended in doubt, null until one did.
    this._brewsRunning = 0;
    this._lastUncertainBrewAt = null;
    // The frame figures of clients thrown away since the previous health line
    // (see _bankStats), added to those of the current client in _logHealth.
    this._healthBanked = emptyBankedStats();
    // Pending onSettings deferred-apply timer, if any -- see onSettings
    // and _startPolling below for why settings changes need this at all.
    this._applySettingsTimer = null;
    // What the deferred timer above still needs to do once it fires --
    // accumulated across every save since it last ran, not just the
    // *last* save's own changedKeys (see onSettings for why that
    // distinction matters).
    this._pendingSettingsApply = { labels: false, reconnect: false };
    await this._syncHotwaterCapability();
    await this._syncStrengthOptionLabels();

    // Which machine this is, for a user who has to tell us: the article number
    // and hwId were stored at pairing, devices paired before that have none.
    this.log(
      `Machine: profile ${this._resolveProfile().code}, art. ${this.getStoreValue('articleNumber') || 'unknown'}, hwId ${
        this.getStoreValue('hwId') || 'unknown'
      }`
    );

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
            'This machine cannot be switched off remotely: press the power button on the machine itself.'
        );
      } else {
        throw new Error(
          this.homey.__('errors.cannot_power_on') ||
            'This machine cannot be switched on remotely: press the power button on the machine itself.'
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
      this.log('button brew_coffee_button');
      await this.brew('coffee');
    });
    this.registerCapabilityListener('brew_espresso_button', async () => {
      this.log('button brew_espresso_button');
      await this.brew('espresso');
    });
    // Safe to register even on a device that doesn't have this
    // capability right now (_syncHotwaterCapability above decides
    // that per-device) -- Homey simply never fires a listener for a
    // capability a device doesn't have.
    this.registerCapabilityListener('brew_hotwater_button', async () => {
      this.log('button brew_hotwater_button');
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
   *
   * Takes an explicit `settings` object (defaulting to the already-
   * saved this.getSettings()) so onSettings can pass `newSettings` --
   * this.getSettings() still returns the OLD profile_code from inside
   * onSettings itself, since Homey only persists newSettings once
   * onSettings resolves (community.homey.app/t/88948). Only capability
   * calls happen here, no settings read/write, so unlike
   * _syncStrengthOptionLabels below this is safe to run immediately
   * instead of deferred.
   */
  async _syncHotwaterCapability(settings = this.getSettings()) {
    const profile = this._resolveProfile(settings);
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

  /**
   * Write what one poll found for the read-only labels in the settings
   * page's Statistics group (total_brews, maintenance_*) in a single
   * setSettings, with only the ones that differ from what is saved now --
   * nothing is written when nothing changed. Called from _poll() only,
   * never from onSettings (see there for why setSettings is unsafe in
   * that handler). async, so a setSettings that throws instead of
   * rejecting still ends up in the caller's .catch, not in the poll.
   */
  async _saveStatistics(wanted) {
    const saved = this.getSettings();
    const changed = {};
    for (const [key, value] of Object.entries(wanted)) {
      if (saved[key] !== value) changed[key] = value;
    }
    if (Object.keys(changed).length > 0) await this.setSettings(changed);
  }

  async onAdded() {
    this.log('Jura machine device added:', this.getName());
  }

  async onDeleted() {
    this._stopPolling();
    // Otherwise a pending onSettings deferred-apply (see onSettings
    // below) would still fire after the device is gone.
    if (this._applySettingsTimer) this.homey.clearTimeout(this._applySettingsTimer);
    this._pendingSettingsApply.labels = false;
    this._pendingSettingsApply.reconnect = false;
    await this._resetClient('device deleted');
  }

  /**
   * Homey calls this when the app stops or the device is taken out of
   * service, with the same duties as onDeleted: no timer may fire any more,
   * and the connection ends with the polite close (the empty frame, then FIN)
   * instead of being left for the machine to time out.
   */
  async onUninit() {
    this._stopPolling();
    if (this._applySettingsTimer) this.homey.clearTimeout(this._applySettingsTimer);
    this._pendingSettingsApply.labels = false;
    this._pendingSettingsApply.reconnect = false;
    await this._resetClient('device uninit');
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
      // A corrected profile can add or remove hot water support --
      // passed newSettings explicitly since _syncHotwaterCapability
      // would otherwise read this.getSettings()'s still-OLD profile_code
      // (see that method's own doc comment). Only touches capabilities,
      // so unlike the label sync below it's safe to run right away.
      await this._syncHotwaterCapability(newSettings);
    }
    if (changedKeys.includes('address') || changedKeys.includes('profile_code')) {
      this.log('Connection settings changed, reconnecting...');
      this._stopPolling();
      await this._resetClient('connection settings changed');
      // The backoff of the old address or profile means nothing for the new
      // one, so the new one is not made to wait for it. The gap stays: it
      // counts from this moment, also when there was no client to reset (a
      // reset without a client notes no end of a session by itself). The same
      // goes for the run of failed polls (see _logPollFailure): what the old
      // address did not answer says nothing about the new one, so the run ends
      // here, without a line for it, and a new address that does not answer
      // gets its own "Poll failed (n/3)" lines and its own transition line. So
      // does what the old address said about switching off (see _poll). The
      // frame lines kept while the log was quiet are the old address's too: they
      // are dropped and not written, and what they left out stays counted (see
      // _logFrame).
      this._connectFailures = 0;
      this._pollFailCount = 0;
      this._failRunSince = null;
      this._quietNextSummaryAt = null;
      this._quietFrames = [];
      this._switchOffAnnouncedAt = null;
      this._switchedOff = false;
      this._offFailedPolls = 0;
      this._noteSessionEnd();
    }

    // Accumulated (OR'd in), not overwritten -- a save's own changedKeys
    // must not erase an earlier, still-pending save's need for a label
    // sync or reconnect (see the big comment below for the scenario
    // this guards against).
    this._pendingSettingsApply.labels = this._pendingSettingsApply.labels || changedKeys.includes('profile_code');
    this._pendingSettingsApply.reconnect =
      this._pendingSettingsApply.reconnect || changedKeys.includes('address') || changedKeys.includes('profile_code');

    // Everything below either reads this.getSettings() or calls
    // setSettings(), and both are unsafe to do straight from inside
    // onSettings: this.getSettings() here would still return the OLD
    // values (Homey only persists newSettings once onSettings resolves
    // -- community.homey.app/t/88948), and Athom's own SDK team
    // documents setSettings() called from onSettings as unreliable
    // (athombv/homey-apps-sdk-issues #383, #333) -- developers there
    // settle on deferring it by about a second instead. The timer
    // itself is cleared and re-armed on every call (not appended to) so
    // two saves in quick succession only ever apply once -- but what to
    // apply comes from _pendingSettingsApply above, accumulated across
    // every save since the timer last fired, not this call's own
    // changedKeys: a second save that only changes something unrelated
    // (e.g. coffee_ml) would otherwise silently swallow an earlier
    // save's still-pending profile_code/address work, since only the
    // *last* setTimeout callback that gets armed ever actually runs.
    if (this._applySettingsTimer) this.homey.clearTimeout(this._applySettingsTimer);
    this._applySettingsTimer = this.homey.setTimeout(async () => {
      this._applySettingsTimer = null;
      const { labels, reconnect } = this._pendingSettingsApply;
      this._pendingSettingsApply.labels = false;
      this._pendingSettingsApply.reconnect = false;
      // A rejected promise out of a timer callback is never caught by
      // anything else -- Homey wouldn't surface it to the user the way
      // a thrown Error from onSettings itself gets surfaced, it would
      // just be an unhandled rejection.
      try {
        if (labels) {
          // Changes which strength values are valid -- see
          // _syncStrengthOptionLabels's own doc comment.
          await this._syncStrengthOptionLabels();
        }
        if (reconnect) {
          await this._startPolling();
        }
      } catch (err) {
        this.error('Deferred settings-apply failed:', err.message);
      }
    }, 1000);
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
    // The frame lines kept while the log is quiet (see _logFrame) are those of
    // the clients before this one: they are dropped, not written, so that the
    // attempts of a night do not come out when the quiet ends. What they left
    // out stays counted.
    this._quietFrames = [];
    const store = this.getStore();
    const settings = this.getSettings();
    const address = settings.address || store.address;
    const profile = this._resolveProfile();

    const client = new JuraClient(address, {
      connId: store.connId,
      authHash: store.authHash,
      // @HP: includes the pin on every handshake, not just the first --
      // a machine with a security PIN set (via the J.O.E. app) needs it
      // again on every reconnect, not only during pairing.
      pin: store.pin || '',
      profile,
      // Synchronous on purpose: FrameLog hands every line over right away and
      // does not wait for it. The lines are redacted and cut before they get here.
      // The budget is the device's and not this client's (see _logFrame).
      logger: (line) => this._logFrame(line),
      // The connection ended (the machine closed or reset it, or a socket
      // error): throw the client away now, with its figures banked, instead
      // of finding out at the next poll. A client that is no longer the
      // current one was reset already, and _resetClient's own close() of the
      // current one ends up here too, so both are ignored.
      onClose: () => {
        if (this._client === client) {
          // Noted before the reset: _doConnect tells this end of a connect
          // (the machine's, counted) from one the device itself began.
          this._endedByMachine = client;
          this._resetClient('closed').catch(this.error);
        }
      },
      // The machine sends a @TF: status by itself about every 2 s: it is
      // applied as it comes in, and not only when the poll reads one, so a
      // short state and an alarm show at once. Only the current client's: a
      // push of one that was reset meanwhile (the listener runs a moment after
      // the frame, see _notifyPush in the client) changes nothing. What is
      // applied is the newest status the client has, not the frame that was
      // announced: frames that arrive in one socket packet are announced one
      // after the other, and the poll may have applied the last of them by
      // then, which an older frame must not undo. A push says nothing about
      // whether the machine can be reached: that stays with the poll (see
      // _poll). The announcement that the machine is switching off is looked
      // for in the frame that was announced as well, not only in `latest`: it
      // is short, and a newer frame from the same socket packet is what
      // `latest` is by then (see _noteStatusForSwitchOff). The client swallows
      // whatever the listener throws, so a failure is logged here.
      onPush: (reply) => {
        if (this._client !== client) return;
        if (!reply.startsWith('@TF:')) return;
        const latest = client.latestStatus;
        if (!latest) return;
        try {
          const pushed = MachineStatus.parse(reply, client.profile);
          this._noteStatusForSwitchOff(pushed);
          this._applyStatus(latest.reply === reply ? pushed : MachineStatus.parse(latest.reply, client.profile));
        } catch (err) {
          this.error('Status push could not be applied:', safeText(err.message, LOG_TEXT_MAX));
        }
      },
    });
    return client;
  }

  /**
   * One frame line of a client's FrameLog (see _buildClient) on its way to the
   * log, within a budget: at most TIMING.FRAME_LINES_PER_MIN in a fixed minute,
   * counted on the monotonic clock and for the device, over all its clients, so
   * a reconnect does not start with a new one. While the log is quiet (see
   * _logPollFailure) none is written at the time: a machine that takes the
   * connection but gives no session (another app holds it) would else leave a
   * TX @HP: line at every connect attempt, all night. What is not written is
   * counted. The newest QUIET_FRAMES_KEPT of the quiet log are kept as well
   * (`_quietFrames`, outside the budget: they do not count in it, and it does not
   * keep them out), because the quiet ends with a connection that works, and
   * its frames are what a bug report needs: the handshake that gets the machine
   * back, and the TX @TP: line with the recipe of a brew that came before the
   * first poll. The ring starts over with every new client (see _buildClient), so
   * the attempts of a night are not in it. It is written by _flushQuietFrames
   * when the quiet ends (see _endFailRun, _endSwitchedOff) and dropped when the
   * address or the profile changes (see onSettings). What is over the budget
   * (not in the quiet log) is counted and not kept. The count is told by one
   * line, "(+N lines left out)", in front of the next frame line that is written
   * (or, at the end of the quiet, in front of the kept lines), and never alone:
   * it has no timer and no minute of its own, so a quiet log stays quiet. That
   * line does not count in the budget. The count starts over before the line is
   * written, as in _endFailRun. Returns what `log` returned for the frame line,
   * for FrameLog to deal with (it swallows a promise that rejects, see its class
   * comment); the same is done here for the line that tells the count.
   * @param {string} line
   */
  _logFrame(line) {
    const now = this._monotonicNow();
    if (this._frameWindowAt === null || now - this._frameWindowAt >= FRAME_WINDOW_MS) {
      this._frameWindowAt = now;
      this._frameWindowLines = 0;
    }
    if (this._quietNextSummaryAt !== null) {
      this._frameLeftOut += 1;
      this._quietFrames.push(line);
      if (this._quietFrames.length > QUIET_FRAMES_KEPT) this._quietFrames.shift();
      return;
    }
    if (this._frameWindowLines >= this._frameLinesPerMin()) {
      this._frameLeftOut += 1;
      return;
    }
    this._frameWindowLines += 1;
    if (this._frameLeftOut > 0) {
      const leftOut = this._frameLeftOut;
      this._frameLeftOut = 0;
      const told = this.log('[frame]', `(+${leftOut} lines left out)`);
      if (told && typeof told.then === 'function') told.then(undefined, () => {});
    }
    return this.log('[frame]', line);
  }

  /**
   * The log is not quiet any more (see _endFailRun, _endSwitchedOff): the frame
   * lines kept while it was (see _logFrame) are written now, in the order they
   * came, behind one line that tells how many were left out before them,
   * "(+N lines left out)". N is all that was left out since the line that said
   * so last, minus the lines that are kept and written here, so what is written
   * and what is counted add up to what the FrameLogs offered. The lines are
   * outside the budget: they do not count in the minute that is running, and it
   * does not keep them out. Nothing kept, nothing written: the count stays, for
   * the next frame line to tell, as the count is never alone. The ring and the
   * count start over before anything is written, as in _endFailRun. Never
   * throws, for the same reason: a log that throws must not keep the quiet from
   * ending. A promise that `log` returns and that rejects is swallowed, as in
   * _logFrame.
   */
  _flushQuietFrames() {
    const kept = this._quietFrames;
    this._quietFrames = [];
    if (kept.length === 0) return;
    const leftOut = this._frameLeftOut - kept.length;
    this._frameLeftOut = 0;
    try {
      const write = (text) => {
        const told = this.log('[frame]', text);
        if (told && typeof told.then === 'function') told.then(undefined, () => {});
      };
      if (leftOut > 0) write(`(+${leftOut} lines left out)`);
      for (const line of kept) write(line);
    } catch {
      // What is not written stays unwritten: the quiet is over all the same.
    }
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
   *
   * The attempt in flight is checked FIRST, before `connected`: a client
   * whose socket is up but whose handshake is still running already calls
   * itself connected, and a second caller (a brew) that trusted that would
   * write its command over a session the machine has not accepted yet.
   *
   * A new connection also waits for the time since the previous session ended
   * (see _reconnectWaitMs). A caller that cannot wait for that (the poll) gets
   * `false` and does nothing; one that can (`waitForGap`, a brew) waits the
   * rest, and so does the connect that every caller after it shares. Resolves
   * `true` when there is a connection.
   * @param {{waitForGap?: boolean}} [opts]
   * @returns {Promise<boolean>}
   */
  async _connectIfNeeded({ waitForGap = false } = {}) {
    if (this._connectPromise) return this._connectPromise;
    if (this._client && this._client.connected) return true;
    // A client that is here but no longer connected (its onClose has not
    // thrown it away yet, or it never got connected) goes through the same
    // reset as any other, so its figures and its close reason are kept, and
    // the wait below counts from this moment. Not awaited, on purpose:
    // everything it changes happens before its first await, and an await here
    // would let a second caller slip in between and start a connect of its
    // own.
    if (this._client) this._resetClient('closed').catch(this.error);
    const waitMs = this._reconnectWaitMs(waitForGap);
    if (waitMs > 0 && !waitForGap) return false;
    // A connect is made (or waited for): the run of skipped polls, if there
    // was one, is over, and the next one gets its own log line.
    this._pollSkipLogged = false;
    this._connectPromise = this._connectAfter(waitMs);
    try {
      return await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  /**
   * The connect that _connectIfNeeded shares: waits `waitMs` (the gap, when
   * a brew has to wait for it), then connects. With nothing to wait for it
   * calls _doConnect in the same tick, as before the gap existed. A timer can
   * fire a moment before the time is really up, so the wait is checked again
   * and repeated until it has passed.
   *
   * The end of the wait is fixed once, on the monotonic clock (see
   * monotonicMs), and every check is against that deadline. Working it out
   * again from the wall clock after each timer would let a wall clock that
   * jumped back (an NTP step, a manual change) stretch the wait by the size
   * of the jump.
   * @param {number} waitMs
   * @returns {Promise<boolean>}
   */
  async _connectAfter(waitMs) {
    const deadline = monotonicMs() + waitMs;
    let remainingMs = waitMs;
    while (remainingMs > 0) {
      await this._waitForGap(remainingMs);
      remainingMs = deadline - monotonicMs();
    }
    await this._doConnect();
    return true;
  }

  /**
   * How long, in ms, a new connection still has to wait: until the end of the
   * last session (see _noteSessionEnd) is at least the gap ago, and after
   * connects that failed in a row (`_connectFailures`) the longer wait of
   * TIMING.RECONNECT_MAX_MS: the gap, twice the gap, then the maximum. 0 when
   * nothing has to be waited for. `forBrew`: a brew waits for the gap only,
   * never for the longer wait after failed connects, so it is at most
   * TIMING.RECONNECT_GAP_MS. Counted on the monotonic clock (`_monotonicNow`), so a
   * wall clock that jumped since the session ended, back or forward, does not
   * change it; and never more than the pause itself either.
   * @param {boolean} [forBrew]
   * @returns {number}
   */
  _reconnectWaitMs(forBrew = false) {
    if (this._lastSessionEndAt === null) return 0;
    const timing = this._timing;
    let pauseMs = timing.RECONNECT_GAP_MS;
    if (!forBrew && this._connectFailures > 1) {
      pauseMs = Math.max(
        pauseMs,
        Math.min(timing.RECONNECT_GAP_MS * Math.pow(2, this._connectFailures - 1), timing.RECONNECT_MAX_MS)
      );
    }
    return Math.min(pauseMs, Math.max(0, this._lastSessionEndAt + pauseMs - this._monotonicNow()));
  }

  /**
   * TIMING.BREW_DEADLINE_MS of this device. A key that is missing or not a
   * number falls back to the production value, key by key: a test puts a
   * `_timing` with only some of the keys on a device, and a deadline of NaN
   * would make every brew fail.
   * @returns {number}
   */
  _brewDeadlineMs() {
    return Number.isFinite(this._timing.BREW_DEADLINE_MS) ? this._timing.BREW_DEADLINE_MS : TIMING.BREW_DEADLINE_MS;
  }

  /**
   * Remember that a session (or an attempt at one) has just ended: the gap
   * counts from now. Called wherever a client leaves or is closed, whoever
   * ended it: _resetClient (our own close, the machine's FIN or RST via
   * onClose, a failed poll, a failed connect), _closeIfStale and the close in
   * the catch of _doConnect. It counts as the end of a real session, see
   * `_lastEndHadSession`.
   */
  _noteSessionEnd() {
    this._lastSessionEndAt = this._monotonicNow();
    this._lastEndHadSession = true;
  }

  /**
   * Resolves after `ms`, or rejects with the "connection attempt cancelled"
   * error when _resetClient cancels it (a delete, an uninit or a changed
   * address while a brew still waits for the gap): the connect behind it must
   * not open a socket for a device that is gone or points elsewhere.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _waitForGap(ms) {
    return new Promise((resolve, reject) => {
      const timer = this.homey.setTimeout(() => {
        this._gapWait = null;
        resolve();
      }, ms);
      this._gapWait = {
        cancel: () => {
          this.homey.clearTimeout(timer);
          this._gapWait = null;
          reject(connectCancelledError());
        },
      };
    });
  }

  /**
   * A reset or delete can come when the machine has answered the handshake
   * already, while the new token is being stored (close() cancels a connect
   * that is still queued, opening its socket or in its handshake, but one that
   * has its answer would still return as if it succeeded, to a caller that
   * then finds no client). That is what `_clientGeneration` is for: when it
   * changed since this connect started, the connect fails and its client is
   * closed (again, if the reset did so already) and not used. That check
   * comes AFTER the auth token of the handshake has been stored: a machine
   * that rotated its token for this connection must not be left with a stored
   * one it no longer accepts, only because the connect arrived late.
   *
   * Whatever goes wrong on the way (a rejected handshake, no reply, a
   * cancelled attempt), the client of this attempt does not stay open: it goes
   * through _resetClient when it is still the current one, which also keeps
   * the real reason for `close=` in the health line, or is simply closed when
   * a reset has replaced it already. The error is then thrown again.
   */
  async _doConnect() {
    const generation = this._clientGeneration;
    const client = this._buildClient();
    this._client = client;
    try {
      const result = await client.connect(15000);
      if (result.state !== 'CORRECT') {
        // WRONG_HASH usually means the machine was reset/re-paired via the
        // official J.O.E. app since we last stored a hash -- surfacing
        // this clearly beats a cryptic downstream timeout. The start of the
        // text is what HANDSHAKE_REJECTED_RE recognises: keep the two together.
        throw new Error(
          `Handshake rejected (${result.state}). If this persists, remove and re-pair the device.`
        );
      }
      const storedHash = this.getStoreValue('authHash') || '';
      if (result.newHash && result.newHash !== storedHash) {
        // newHash is already a hex token of 16 to 128 characters (see
        // classifyHandshakeReply). Store it when it is the documented 64
        // hex, or when it has the same length as the token this machine
        // gave at pairing -- a machine with a different token length that
        // rotates it on reconnect must not be locked out, while a damaged
        // frame is very unlikely to match the stored length exactly.
        if (AUTH_HASH_RE.test(result.newHash) || result.newHash.length === storedHash.length) {
          await this.setStoreValue('authHash', result.newHash).catch(this.error);
        } else {
          // Only the length is logged, never the token itself.
          this.error(
            `Machine sent an auth token of ${result.newHash.length} characters, not 64 hex and not the length of the stored one; the stored hash was kept.`
          );
        }
      } else if (result.hashLength !== undefined) {
        this.error(`Machine sent an unusable auth token (length ${result.hashLength}); the stored hash was kept.`);
      }
      await this._closeIfStale(client, generation);
      // A connection that comes after an earlier one is a reconnect.
      if (this._hasConnected) this._healthReconnects += 1;
      this._hasConnected = true;
      this._sessionStartedAt = this._monotonicNow();
      // The backoff starts over. The tile is not set available here: only a
      // poll that reads a status does that (see _poll).
      this._connectFailures = 0;
    } catch (err) {
      // A reset that the device began itself while this connect ran (a
      // changed address, a delete, an uninit) ends the connect with an error
      // of the client (the handshake's reader destroyed, or a socket that was
      // still opening): that is a cancelled connect, whatever the client
      // says. A changed generation alone does not tell: the machine that
      // resets the handshake also goes through _resetClient, via onClose, and
      // that one must keep counting below.
      const cancelled = generation !== this._clientGeneration && this._endedByMachine !== client;
      const failure = cancelled ? connectCancelledError() : err;
      // A connect that failed lengthens the wait for the next one (see
      // _reconnectWaitMs), whoever ended the connection: the machine that
      // refused the handshake, or reset it so that our own onClose threw the
      // client away first. Two kinds do not: a connect the device cancelled
      // itself (the connect was fine, a reset or delete came, see
      // _closeIfStale), and one that never had a TCP session (see
      // failedWithoutSession): a machine that is off cannot be churning, and
      // must not make the wait after it is switched on any longer than the gap.
      const withoutSession = failedWithoutSession(failure);
      if (failure.code !== CONNECT_CANCELLED_CODE && !withoutSession) this._connectFailures += 1;
      if (this._client === client) {
        await this._resetClient(failure.message);
      } else {
        await client.close().catch(() => {});
        this._noteSessionEnd();
      }
      // A connect that never had a TCP session (see failedWithoutSession) ended
      // no session: the wait after it is the device's own, not a pause the
      // machine needs (see _skipPoll).
      if (failure.code !== CONNECT_CANCELLED_CODE && withoutSession) this._lastEndHadSession = false;
      throw failure;
    }
  }

  /**
   * Throws, after closing `client`, when a reset or delete has happened since
   * `generation` was read: the connect that got this far is of no use to
   * anyone. Closing again is harmless when _resetClient already did.
   */
  async _closeIfStale(client, generation) {
    if (generation === this._clientGeneration) return;
    await client.close().catch(() => {});
    this._noteSessionEnd();
    // Not every reset is the device's: when the machine reset or closed the
    // connection while the token was being stored, the reset came from onClose
    // (see _buildClient). That connect failed and says why, so that it counts
    // (see the catch of _doConnect) and nobody is told the device was reset.
    if (this._endedByMachine === client) {
      throw client.lastCloseReason || new Error('The machine ended the connection while it was connecting.');
    }
    throw connectCancelledError();
  }

  /**
   * The one way a client leaves this device, whatever the reason (`reason`,
   * a short text of our own, used when the client has none): a failed poll,
   * the client's own onClose, a lost connection during a brew, a deleted
   * device, a changed address or profile, uninit. In this order:
   *
   *  1. `_clientGeneration` goes up, so a connect still under way is
   *     abandoned (see _doConnect). A connect always has its client in
   *     `this._client` from its first moment, so with no client there is
   *     nothing to abandon and nothing is done at all;
   *  2. `this._client` is cleared at once, so nothing else can pick the old
   *     client up again;
   *  3. the reason it ended is kept (the client's own, else `reason`), as the
   *     next client starts without one, see _logHealth;
   *  4. its frame figures are banked, see _bankStats;
   *  5. it is closed.
   *
   * Steps 1 to 4 happen before the first await, so a caller that does not
   * await this still sees them done. Never rejects: it runs while things are
   * being cleaned up.
   *
   * The gap before the next connect counts from this moment (see
   * _noteSessionEnd), and a brew that still waits for that gap is cancelled
   * (see _waitForGap).
   *
   * A caller that works with a client of its own (the poll, a brew) passes it
   * as `client`: the reset then only happens when that is still the current
   * client. Without it, a failure that is only noticed late (the old client's
   * read times out after a new one has been made) would throw the new client
   * away. A call without a client resets whatever the current one is.
   * @param {string} reason
   * @param {JuraClient} [client]
   */
  async _resetClient(reason, client) {
    if (client !== undefined && this._client !== client) return;
    if (this._gapWait) this._gapWait.cancel();
    const current = this._client;
    if (!current) return;
    this._clientGeneration += 1;
    this._client = null;
    // The next connection applies the status again, once (see _applyStatus),
    // and logs the maintenance reading again, once (see _poll).
    this._appliedRawHex = null;
    this._appliedStatusLine = null;
    this._loggedMaintenanceLine = null;
    this._lastCloseReason = safeText((current.lastCloseReason && current.lastCloseReason.message) || reason);
    this._bankStats(current);
    this._noteSessionEnd();
    await current.close().catch(() => {});
  }

  // ---------- polling ----------

  async _startPolling() {
    // Guards against ever running two intervals side by side -- onInit
    // and onSettings's deferred callback (see onSettings above) can
    // each end up calling this, so this needs to be safe to call
    // regardless of whether a caller already stopped the previous one.
    // The interval is set BEFORE awaiting the first _poll(), not after:
    // that first poll (a connect plus a readStatus) can take up to
    // ~13s, and a second _startPolling() call landing in that window
    // would otherwise stop and replace this._pollTimer before the first
    // call's own setInterval ever ran, orphaning that first interval --
    // _stopPolling()/onDeleted() would then never see or clear it
    // again. Setting the interval first means two overlapping calls
    // always leave exactly one interval behind, whichever call's
    // setInterval ran last. _poll()'s own `_polling` guard already
    // keeps the calls this interval makes from overlapping each other.
    this._stopPolling();
    this._pollTimer = this.homey.setInterval(() => this._poll(), POLL_INTERVAL_MS);
    await this._poll();
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
    // Held outside the try: the catch below resets this client, and only it.
    let client = null;
    try {
      // false: the machine is still given time since its last session ended
      // (TIMING.RECONNECT_GAP_MS, or the longer wait after failed connects).
      // A poll does not wait for that and does not count as failed: it is
      // skipped, and the next tick tries again.
      if ((await this._connectIfNeeded()) === false) {
        this._skipPoll();
        return;
      }
      // Held in a local: the client's own onClose can throw it away (set
      // this._client to null) at any await below.
      client = this._client;
      let status;
      try {
        status = await client.readStatus(8000);
      } catch (err) {
        if (err.code === 'STATUS_BUSY') {
          // Almost certainly just brewing (see StatusUnavailable in
          // lib/juraClient.js), not a dead connection -- so don't close
          // it, don't touch capabilities or the warning, don't count
          // this cycle, and don't run the maintenance/brew-count reads
          // below. Just wait for the next poll to catch a @TF: once the
          // machine settles back down.
          //
          // A busy round is always a sign of life: it never makes the tile
          // unavailable, and it is no failed poll. Past TIMING.BUSY_MAX_MS in
          // a row (a machine that answers @HU? and never sends a @TF: again,
          // or a cleaning or descaling programme longer than has been
          // measured) the connection is reset, once, and the busy time starts
          // over, so that a new connection that is still busy gets another
          // full BUSY_MAX_MS: one reset per BUSY_MAX_MS at most.
          const now = this._monotonicNow();
          if (this._busySince === null) this._busySince = now;
          const busyTooLong = now - this._busySince > this._timing.BUSY_MAX_MS;
          this._endFailRun();
          this._pollFailCount = 0;
          this._lastAliveAt = now;
          this._healthPolls.busy += 1;
          if (busyTooLong) {
            this._busySince = null;
            const busyText = `Machine answered busy for more than ${this._timing.BUSY_MAX_MS / 1000} s without sending a status`;
            this.log(`${busyText}; the connection is reset once, and the busy time starts over.`);
            await this._resetClient(busyText, client);
          } else {
            this.log('No status this cycle (machine busy):', err.message);
          }
          return;
        }
        throw err;
      }
      this._endFailRun();
      this._pollFailCount = 0;
      this._busySince = null;
      this._healthPolls.ok += 1;
      this._pollSucceeded();
      this._noteStatusForSwitchOff(status);
      this._applyStatus(status, { fromPoll: true });

      this._pollCount += 1;
      // The maintenance reads are due on poll 1, 31, 61, ... but each can hold
      // the connection for up to 6 s, so not while the machine brews (a brew
      // phase of the client, or a brew() of this device that is running): a
      // brew queued behind one would wait for it. The reading stays due
      // and is made by the first poll after the brew; the count, and so the
      // beat of 1, 31, 61, ..., does not move.
      if (this._pollCount % MAINTENANCE_POLL_EVERY === 1) this._maintenanceDue = true;
      if (this._maintenanceDue && !client.inBrewPhase() && this._brewsRunning === 0) {
        this._maintenanceDue = false;
        // What this reading found for the settings page's Statistics group;
        // written together, in one setSettings, after both reads below.
        const statistics = {};
        try {
          const maint = await client.readMaintenancePercent(6000);
          // Logged when its text differs from the one logged last, like the
          // `Status:` line: every reading is made, and written to the
          // capabilities and the labels below, but one that found the same
          // percentages as the last is not worth a log line every 5 minutes.
          const maintenanceLine = `cleaning=${maint.cleaning} filter=${maint.filterChange} descale=${maint.descale}`;
          if (maintenanceLine !== this._loggedMaintenanceLine) {
            this._loggedMaintenanceLine = maintenanceLine;
            this.log('Maintenance %:', maintenanceLine);
          }
          // The same three readings as labels. Unlike the capabilities
          // below, a 0xFF (type not tracked by this machine) shows the
          // placeholder here instead of being left alone, so the label
          // doesn't keep an old percentage.
          const shown = (value) => (value === 0xff ? STATISTICS_PLACEHOLDER : `${value}%`);
          statistics.maintenance_cleaning = shown(maint.cleaning);
          statistics.maintenance_filter = shown(maint.filterChange);
          statistics.maintenance_descale = shown(maint.descale);
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
          this.error('Maintenance percent read failed (non-fatal):', safeText(err.message, LOG_TEXT_MAX));
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
          const total = await client.readTotalBrewCount(6000);
          statistics.total_brews = String(total);
        } catch (err) {
          if (/does not implement the @TR:32/.test(err.message)) {
            statistics.total_brews = 'Not supported by this machine';
          }
          this.error('Total brew count read failed (non-fatal):', safeText(err.message, LOG_TEXT_MAX));
        }

        // Not awaited, and a failed write is only logged: the labels are a
        // convenience, not worth a failed poll.
        this._saveStatistics(statistics).catch(this.error);
      }
    } catch (err) {
      this._busySince = null;
      // A run that was taken for the machine being switched off ends here when
      // this failure shows that the machine is on (see _lostWhileSwitchingOff):
      // the failure then goes the ordinary way, below.
      const lostInSwitchOff = this._lostWhileSwitchingOff(err);
      const switchOffEnds = this._switchedOff && !lostInSwitchOff;
      if (switchOffEnds) this._endSwitchedOff();
      if (lostInSwitchOff) {
        this._logSwitchedOff(err);
      } else {
        this._pollFailCount += 1;
        this._healthPolls.fail += 1;
        this._logPollFailure(err);
        // What the tile shows if this failure is still the latest one when the
        // time without a successful poll runs out (see _updateAvailability).
        // The message can quote a frame (redactFrame) and goes on the tile, so
        // it is cut as well.
        this._lastFailText = safeText(friendlyPollError(err), UNAVAILABLE_TEXT_MAX);
        // The tile of the run that just ended says the machine is switched off,
        // and _updateAvailability leaves a tile that is unavailable alone, so
        // the text is set here, once, with the text of this failure.
        if (switchOffEnds && this._available === false) this._setTile(false, this._lastFailText);
      }
      // Only the client this poll used, and only when it is still the current
      // one: nothing is left to do when the client's onClose threw it away
      // already, and a client made since must stay. A failed connect has no
      // client here; _doConnect has reset its own.
      if (client) await this._resetClient(err.message, client);
    } finally {
      this._polling = false;
      this._updateAvailability();
      this._logHealth();
    }
  }

  /**
   * Apply a status (a parsed @TF:) to the device: the `Status:` log line,
   * onoff, the alarms and the warning. Two callers: the poll, with the status
   * it read (`fromPoll`), and the client's `onPush` listener (see
   * _buildClient), with the newest @TF: the machine sent by itself. It does
   * nothing for availability, the busy time or the maintenance reads: those
   * stay with the poll.
   *
   * Applying the same thing twice must cost nothing, because the machine
   * repeats the same status about every 2 s and the poll often reads the very
   * @TF: that was pushed a moment before. So a push of a raw status equal to
   * the one applied last (`_appliedRawHex`) does nothing, not even a log line.
   * The poll does not stop there: it looks at every capability and at the
   * warning on every poll, so that whatever a failed call left behind is put
   * right by the next poll (see below), as it was before the pushes came in.
   * A capability is only set when its value differs from the one it has, or
   * when its last set failed (`_retryCaps`: Homey may store the value before
   * the call has succeeded, so after a failure the comparison alone sees no
   * difference), and the warning only when its text differs from the one last
   * set (a failed call empties that text, so the next time it is tried
   * again). A capability that cannot be read is logged and left alone, and
   * never makes this throw: the others and the warning are still applied, and
   * the poll does not fail over it.
   *
   * The `Status:` line is written when the raw status changed and its text is
   * not the one last written: a bit the profile does not know changes the raw
   * status and not the text. A reset of the client empties `_appliedRawHex` and
   * the last text (see _resetClient), so a connection that is made again
   * applies the status once more, and the log says so once.
   *
   * The machine switching off is no fault: switch_off_delay_active and
   * please_wait (NOT_A_FAULT_ALERTS) count for neither `alarm_generic` nor the
   * warning, whatever their severity in the profile. They stay in the `Status:`
   * line. A real fault at the same time still sets both, with only the real
   * faults in the text of the warning.
   * @param {{rawHex: string, activeAlerts: string[], errors: string[]}} status
   * @param {{fromPoll?: boolean}} [opts]
   */
  _applyStatus(status, { fromPoll = false } = {}) {
    const changed = status.rawHex !== this._appliedRawHex;
    if (!changed && !fromPoll) return;
    this._appliedRawHex = status.rawHex;
    const line = status.activeAlerts.join(', ') || '(none)';
    if (changed && line !== this._appliedStatusLine) {
      this._appliedStatusLine = line;
      this.log('Status:', line);
    }

    const setIfChanged = (cap, value) => {
      let differs;
      try {
        differs = this._retryCaps.has(cap) || this.getCapabilityValue(cap) !== value;
      } catch (err) {
        this.error('Status capability could not be read:', cap, safeText(err.message, LOG_TEXT_MAX));
        return;
      }
      if (!differs) return;
      this._retryCaps.delete(cap);
      this.setCapabilityValue(cap, value).catch((err) => {
        this._retryCaps.add(cap);
        this.error(err);
      });
    };

    // onoff reflects "not in standby" -- the closest read-only analogue
    // of power state this protocol exposes.
    setIfChanged('onoff', !status.activeAlerts.includes('goodbye'));

    const errors = status.errors.filter((name) => !NOT_A_FAULT_ALERTS.has(name));
    const hasError = errors.length > 0;
    setIfChanged('alarm_generic', hasError);

    // fill_water, no_beans, insert_tray, empty_tray and empty_grounds
    // are all present (by name) in all 72 bundled profiles -- see
    // lib/profiles/README.md's alert survey -- so these are safe to
    // compute for any paired model, not just the E8.
    setIfChanged('alarm_water', status.activeAlerts.includes('fill_water'));
    setIfChanged('alarm_beans', status.activeAlerts.includes('no_beans'));
    // Two genuinely different physical states, not the same thing
    // worded differently: alarm_tray = present but full, needs
    // emptying; alarm_tray_missing = not inserted at all.
    setIfChanged('alarm_tray', ['empty_tray', 'empty_grounds'].some((name) => status.activeAlerts.includes(name)));
    setIfChanged('alarm_tray_missing', status.activeAlerts.includes('insert_tray'));
    // ~96-97% profile coverage, not 100% -- on profiles that lack the
    // alert name entirely, activeAlerts simply never contains it, so
    // this stays false rather than erroring.
    setIfChanged('alarm_outlet_missing', status.activeAlerts.includes('outlet_missing'));
    setIfChanged('alarm_rear_cover_missing', status.activeAlerts.includes('rear_cover_missing'));

    // The warning text of the last call, null after an unsetWarning, undefined
    // after a call that failed: the very first status always makes a call
    // (undefined differs from both), which also clears a warning that was still
    // showing from before an app restart.
    const warning = hasError ? errors.join(', ') : null;
    if (warning !== this._appliedWarning) {
      this._appliedWarning = warning;
      const failed = (err) => {
        this._appliedWarning = undefined;
        this.error(err);
      };
      if (hasError) {
        this.setWarning(warning).catch(failed);
      } else {
        this.unsetWarning().catch(failed);
      }
    }
  }

  /**
   * A failed poll goes to the log. The first POLL_FAIL_THRESHOLD in a row get a
   * line of their own, "Poll failed (n/3)", with the message of the error. The
   * last of them is followed by one line that says the log goes quiet: from
   * then on a failed poll writes nothing (and neither does a skipped one, see
   * _skipPoll), and every TIMING.QUIET_SUMMARY_MS one line sums it up, until a
   * poll works again (see _endFailRun). So a machine that is switched off for
   * days leaves a few lines per day, and not one per poll. Only the kind of the
   * failure is in the quiet lines (see pollFailClass), never its message, which
   * can quote an address. `_pollFailCount` is not capped: only what is logged is.
   * @param {Error} err
   */
  _logPollFailure(err) {
    const now = this._monotonicNow();
    if (this._failRunSince === null) this._failRunSince = now;
    this._lastFailClass = pollFailClass(err);
    if (this._quietNextSummaryAt !== null) {
      this._logQuietSummary(now);
      return;
    }
    this.error(`Poll failed (${this._pollFailCount}/${POLL_FAIL_THRESHOLD}):`, safeText(err.message, LOG_TEXT_MAX));
    if (this._pollFailCount < POLL_FAIL_THRESHOLD) return;
    const everyMs = this._quietSummaryMs();
    this._quietNextSummaryAt = now + everyMs;
    this.error(
      `Machine unreachable: ${POLL_FAIL_THRESHOLD} polls in a row failed (last: ${this._lastFailClass}). ` +
        `Further failures are not logged one by one; a summary follows every ${formatDuration(everyMs)}.`
    );
  }

  /**
   * While the log is quiet (see _logPollFailure): one summary line when a
   * TIMING.QUIET_SUMMARY_MS is up, counted from the line that said the log went
   * quiet. Called by every poll cycle that failed or was skipped. The next one
   * is worked out from the schedule and not from now, so that a cycle that comes
   * late does not push the later ones back (over a long outage that would lose
   * a summary every few), and when whole periods were missed it is the first
   * one still ahead, not a line for each missed one. The time is since the first
   * failed poll of the run, as in the line that ends it (see _endFailRun). When
   * the run is the machine being switched off (see _logSwitchedOff) the line
   * says so, in the log and not as an error.
   * @param {number} now
   */
  _logQuietSummary(now) {
    if (this._quietNextSummaryAt === null || now < this._quietNextSummaryAt) return;
    const everyMs = this._quietSummaryMs();
    this._quietNextSummaryAt += (Math.floor((now - this._quietNextSummaryAt) / everyMs) + 1) * everyMs;
    if (this._switchedOff) {
      this.log(
        `Machine still switched off for ${formatDuration(now - this._failRunSince)}: ${this._pollFailCount + this._offFailedPolls} polls failed, last: ${this._lastFailClass}.`
      );
      return;
    }
    this.error(
      `Machine still unreachable for ${formatDuration(now - this._failRunSince)}: ${this._pollFailCount} polls failed, last: ${this._lastFailClass}.`
    );
  }

  /**
   * A poll worked (a status was read, or the machine answered busy: the places
   * that count as a sign of life, see _lastAliveAt), so a run of failed polls is
   * over. When it had made the log go quiet, that gets one line, with the time
   * since the first failed poll and the number of failed polls (so it is called
   * before `_pollFailCount` starts over); a run that did not gets none. Never
   * throws: it only looks at what _logPollFailure kept. The run is cleared
   * before the line is written, so that the log does not stay quiet for good
   * should writing it ever throw. The end of a run that was the machine being
   * switched off (see _logSwitchedOff) also ends its announcement, and the polls
   * that failed in it (`_offFailedPolls`) count in the line. A poll that works
   * in any other case leaves the announcement alone: the machine goes on
   * answering after it announced that it is switching off. The frame lines kept
   * while the log was quiet (see _logFrame) are written before that line, by
   * _flushQuietFrames: they are the frames of the connection that works, so the
   * log reads frames, then the line that the machine is reachable again.
   */
  _endFailRun() {
    const wasQuiet = this._quietNextSummaryAt !== null;
    const lastedMs = wasQuiet ? this._monotonicNow() - this._failRunSince : 0;
    const failedPolls = this._pollFailCount + this._offFailedPolls;
    this._quietNextSummaryAt = null;
    this._failRunSince = null;
    if (this._switchedOff) this._switchOffAnnouncedAt = null;
    this._switchedOff = false;
    this._offFailedPolls = 0;
    if (wasQuiet) {
      this._flushQuietFrames();
      this.log(`Machine reachable again after ${formatDuration(lastedMs)} and ${failedPolls} failed polls.`);
    }
  }

  /**
   * TIMING.QUIET_SUMMARY_MS of this device. A key that is missing or not a
   * positive number falls back to the production value, as for the brew
   * deadline (see _brewDeadlineMs): a test puts a `_timing` with only some of
   * the keys on a device.
   * @returns {number}
   */
  _quietSummaryMs() {
    const ms = this._timing.QUIET_SUMMARY_MS;
    return Number.isFinite(ms) && ms > 0 ? ms : TIMING.QUIET_SUMMARY_MS;
  }

  /**
   * TIMING.SWITCH_OFF_WINDOW_MS of this device, with the same fallback as
   * _quietSummaryMs.
   * @returns {number}
   */
  _switchOffWindowMs() {
    const ms = this._timing.SWITCH_OFF_WINDOW_MS;
    return Number.isFinite(ms) && ms > 0 ? ms : TIMING.SWITCH_OFF_WINDOW_MS;
  }

  /**
   * TIMING.FRAME_LINES_PER_MIN of this device, with the same fallback as
   * _quietSummaryMs.
   * @returns {number}
   */
  _frameLinesPerMin() {
    const n = this._timing.FRAME_LINES_PER_MIN;
    return Number.isFinite(n) && n > 0 ? n : TIMING.FRAME_LINES_PER_MIN;
  }

  /**
   * Whether the machine announced that it is switching off less than
   * TIMING.SWITCH_OFF_WINDOW_MS before `now` (see _noteStatusForSwitchOff).
   * @param {number} now
   * @returns {boolean}
   */
  _switchOffWindowOpen(now) {
    return this._switchOffAnnouncedAt !== null && now - this._switchOffAnnouncedAt < this._switchOffWindowMs();
  }

  /**
   * Look at a status (a parsed @TF:) for the announcement that the machine is
   * switching off: switch_off_delay_active. When the machine is switched off
   * it sends that, and please_wait just before, and stops answering about 20 s
   * later (the dongle goes with it): without this that is a failure, with
   * "Poll failed" lines and a tile that goes unavailable after a minute as if
   * something were wrong. Two callers: the client's `onPush` listener (see
   * _buildClient), with the frame that was pushed, and the poll, with the status
   * it read. The listener looks at the frame itself and not only at the newest
   * status: frames that come in one socket packet are announced one after the
   * other, and the short announcement must not go missing behind a newer frame.
   *
   * The first one starts a window of TIMING.SWITCH_OFF_WINDOW_MS and gets one
   * line in the log; while the window runs, another says nothing. What a poll
   * that fails in the window means is in _logSwitchedOff.
   * @param {{activeAlerts: string[]}} status
   */
  _noteStatusForSwitchOff(status) {
    if (!status.activeAlerts.includes(SWITCH_OFF_ALERT)) return;
    const now = this._monotonicNow();
    if (this._switchOffWindowOpen(now)) return;
    this._switchOffAnnouncedAt = now;
    this.log(`Machine announces it is switching off (${SWITCH_OFF_ALERT}).`);
  }

  /**
   * Whether the poll that just failed is the machine being switched off and no
   * failure. Inside the window, less than TIMING.SWITCH_OFF_WINDOW_MS after the
   * announcement (see _noteStatusForSwitchOff), any failed poll counts: the
   * timeout of @HU?, a connect that fails, a FIN or a reset. After the window
   * the run of failed polls it led to (`_switchedOff`, see _logSwitchedOff)
   * goes on, until a poll works again, but only for a failure that had no TCP
   * session (see failedWithoutSession): a machine that is switched off has
   * none. A failure with a session, a handshake that is rejected or a
   * connection that the machine ends (the J.O.E. app holds it), shows that the
   * machine is on: it is no longer switched off, and the failure is one like
   * any other (see _endSwitchedOff).
   * @param {Error} err the error of the poll that failed
   * @returns {boolean}
   */
  _lostWhileSwitchingOff(err) {
    if (this._switchOffWindowOpen(this._monotonicNow())) return true;
    return this._switchedOff && failedWithoutSession(err);
  }

  /**
   * The run of failed polls that was taken for the machine being switched off
   * ends, because a poll failed after the window with a TCP session behind it
   * (see _lostWhileSwitchingOff): the machine is on and does not work. Not as in
   * _endFailRun, there is no line that the machine is reachable again, as no
   * poll worked. The run starts over with this failure as its first, so that it
   * gets the lines of an ordinary failure ("Poll failed (1/3)", the line that
   * says the log goes quiet, the summaries) and not those of a machine that is
   * switched off. The frame lines kept while the log was quiet (see _logFrame)
   * are written before the line that says why: they are those of this attempt,
   * the one that showed the machine is on (see _flushQuietFrames). The tile is
   * left to the caller (see _poll).
   */
  _endSwitchedOff() {
    this._switchedOff = false;
    this._switchOffAnnouncedAt = null;
    this._offFailedPolls = 0;
    this._quietNextSummaryAt = null;
    this._failRunSince = null;
    this._pollFailCount = 0;
    this._flushQuietFrames();
    this.log('Machine answers again but the connection failed: no longer treated as switched off.');
  }

  /**
   * A poll failed while the machine is switching off or switched off (see
   * _lostWhileSwitchingOff: in the window any failure, after it only one
   * without a TCP session). That is no failure: it is not counted in
   * `_pollFailCount` (the "n" of the "Poll failed (n/3)" lines) and not in the
   * health figures, and there is no such line. It is counted in
   * `_offFailedPolls`, for the summary and the line that ends the run (see
   * _logQuietSummary, _endFailRun), apart from `_pollFailCount` so that this
   * count can be told from a real failure. The log goes quiet at once, without
   * the three lines of a failure: the first failed poll gets one line, with
   * how long ago the machine announced it, after that there is only the summary
   * every TIMING.QUIET_SUMMARY_MS. The backoff of the connects is as it is (see
   * _doConnect). The tile goes unavailable at once, with its own text: an
   * announcement followed by a machine that does not answer leaves no doubt, so
   * it need not wait for TIMING.UNAVAILABLE_AFTER_MS. A call that was refused,
   * or that was not made because another was still on its way, is made again at
   * the next poll that fails (see _setTile). The tile becomes available again,
   * and the run ends, at the first poll that works (see _pollSucceeded), or
   * ends without that when a failure with a TCP session shows that the machine
   * is on (see _endSwitchedOff).
   * @param {Error} err
   */
  _logSwitchedOff(err) {
    const now = this._monotonicNow();
    this._offFailedPolls += 1;
    if (this._failRunSince === null) this._failRunSince = now;
    this._lastFailClass = pollFailClass(err);
    this._lastFailText = SWITCHED_OFF_TEXT;
    if (this._available !== false) this._setTile(false, SWITCHED_OFF_TEXT);
    if (this._switchedOff) {
      this._logQuietSummary(now);
      return;
    }
    this._switchedOff = true;
    const everyMs = this._quietSummaryMs();
    this._quietNextSummaryAt = now + everyMs;
    this.log(
      `Machine switched off: it announced this ${formatDuration(now - this._switchOffAnnouncedAt)} ago and stopped answering. ` +
        `Connection attempts go on quietly; a summary follows every ${formatDuration(everyMs)}.`
    );
  }

  /**
   * A poll that is skipped because the machine is still given time since its
   * last session ended (see _connectIfNeeded). It is no failure and counts for
   * nothing; the log gets one line for a whole run of skipped polls, and none
   * while the log is quiet (see _logPollFailure), only the summary when it is
   * due. The line only says the machine needs a pause when the last end was a
   * real session (see `_lastEndHadSession`): after a connect that never got one
   * (a machine that is off or refuses) the wait is the device's own.
   */
  _skipPoll() {
    if (this._quietNextSummaryAt !== null) {
      this._logQuietSummary(this._monotonicNow());
      return;
    }
    if (this._pollSkipLogged) return;
    this._pollSkipLogged = true;
    const waitS = Math.ceil(this._reconnectWaitMs() / 1000);
    this.log(
      this._lastEndHadSession
        ? `Poll skipped: waiting ${waitS} s before connecting again (the machine needs a pause after a connection ends).`
        : `Poll skipped: waiting ${waitS} s before the next connection attempt.`
    );
  }

  /**
   * A poll has read a status: the machine is alive, and the tile is set
   * available when it was not, or when that is not known (see onInit). This
   * is the only place that does so; connecting alone proves nothing. (A busy
   * round also counts as a sign of life, but only keeps the tile from going
   * unavailable: see _poll.)
   */
  _pollSucceeded() {
    this._lastAliveAt = this._monotonicNow();
    this._lastFailText = '';
    if (this._available === true) return;
    this._setTile(true);
  }

  /**
   * Once per outage, not before TIMING.UNAVAILABLE_AFTER_MS has passed without
   * a successful poll, the tile goes unavailable (setUnavailable, with the
   * text of the latest failed poll). Time decides, whatever the polls did in
   * between: failed, skipped, or cancelled by a reset. Called at the end of
   * every poll, so a call that Homey rejected is made again there (see
   * _setTile).
   */
  _updateAvailability() {
    if (this._available === false) return;
    if (this._monotonicNow() - this._lastAliveAt < this._timing.UNAVAILABLE_AFTER_MS) return;
    this._setTile(false, this._lastFailText || 'No status from the machine.');
  }

  /**
   * Tell Homey that the tile is available, or unavailable with `text`. The
   * state in `_available` only changes when Homey has taken the call: if it
   * rejects it, the state stays as it was, so that the next poll tries again
   * (otherwise the tile could stay wrong for good). While a call is still on
   * its way no second one is made, so a call that takes a while is not
   * repeated by the next poll. A line in the log says what Homey was told, once
   * it has taken the call and not before. Never rejects.
   * @param {boolean} available
   * @param {string} [text]
   */
  async _setTile(available, text) {
    if (this._tileCallPending) return;
    this._tileCallPending = true;
    try {
      if (available) {
        await this.setAvailable();
      } else {
        await this.setUnavailable(text);
      }
      const wasAvailable = this._available;
      this._available = available;
      if (!available) {
        this.log(`Tile unavailable: ${text}`);
      } else if (wasAvailable === null) {
        this.log('Tile available: first status after app start.');
      } else if (wasAvailable === false) {
        this.log('Tile available again: a status was read.');
      }
    } catch (err) {
      this.error(
        `${available ? 'setAvailable' : 'setUnavailable'} failed, it is tried again at the next poll:`,
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      this._tileCallPending = false;
    }
  }

  /**
   * Take the frame figures of a client that is about to be closed and thrown
   * away (see _resetClient) and add them to `_healthBanked`. The next client
   * starts from zero, so without this a connection that keeps dropping would
   * show a health line with nothing in it. Never throws: it runs while a
   * client is being cleaned up.
   * @param {JuraClient} client
   */
  _bankStats(client) {
    try {
      const stats = client.takeStats();
      const banked = this._healthBanked;
      for (const key of BANKED_SUM_KEYS) banked[key] += stats[key];
      banked.tfMaxMs = Math.max(banked.tfMaxMs, stats.tfMaxMs);
    } catch (err) {
      this.error('Health stats failed:', err.message);
    }
  }

  /**
   * Once per HEALTH_EVERY_MS, write one line that sums up how the connection
   * has been doing since the previous one. Called at the end of every poll
   * and does nothing until that much time has passed, so no timer is needed.
   * Fixed shape, so a report can be searched and parsed:
   *
   *   health polls=ok:N,busy:N,fail:N reconnects=N session=Ns tf=N tv=N hu=N
   *   markers=N other=N tfAvgMs=N tfMaxMs=N dropped=N close="..."
   *
   * (one line; broken here for width). Everything counts the time since the
   * previous health line, except `session`, the age of the current connection
   * (0 when there is none). `close` is the reason the connection last ended,
   * as JSON text: the reason of the current client if it has one, else the
   * one _poll() kept from the client it threw away.
   *
   * The frame figures cover every client of that time: the current one, from
   * JuraClient.takeStats() (which holds nothing that belongs to the
   * handshake), plus those of clients thrown away since (`_healthBanked`,
   * see _bankStats). Counts and `dropped` are added up, `tfMaxMs` is the
   * largest of them, and `tfAvgMs` is the total of all @TF: gaps over their
   * number, not an average of averages. With no client right now (the last
   * poll failed and closed it) only the banked figures count. The banked
   * figures start over after the line is written, like the poll counts.
   * Nothing is written while the log is quiet (see _logPollFailure) and there
   * is no connection: nothing has happened that the line could tell. The counts
   * are kept, so the first line after it sums up that time.
   * Never throws: a problem with this line must not break polling.
   */
  _logHealth() {
    try {
      if (this._quietNextSummaryAt !== null && !this._client) return;
      const now = this._monotonicNow();
      if (now - this._lastHealthAt < HEALTH_EVERY_MS) return;
      this._lastHealthAt = now;
      const current = this._client ? this._client.takeStats() : null;
      const banked = this._healthBanked;
      const total = (key) => banked[key] + (current ? current[key] : 0);
      const gapCount = total('tfGapCount');
      const tfAvgMs = gapCount > 0 ? Math.round(total('tfGapSumMs') / gapCount) : 0;
      const tfMaxMs = Math.max(banked.tfMaxMs, current ? current.tfMaxMs : 0);
      const closeReason = (current && current.lastCloseReason) || this._lastCloseReason;
      const polls = this._healthPolls;
      const reconnects = this._healthReconnects;
      this._healthBanked = emptyBankedStats();
      this._healthPolls = { ok: 0, busy: 0, fail: 0 };
      this._healthReconnects = 0;
      const sessionS = this._client && this._sessionStartedAt ? Math.round((now - this._sessionStartedAt) / 1000) : 0;
      this.log(
        `health polls=ok:${polls.ok},busy:${polls.busy},fail:${polls.fail} reconnects=${reconnects} session=${sessionS}s ` +
          `tf=${total('tf')} tv=${total('tv')} hu=${total('hu')} markers=${total('markers')} other=${total('other')} ` +
          `tfAvgMs=${tfAvgMs} tfMaxMs=${tfMaxMs} dropped=${total('droppedReplies')} ` +
          `close=${JSON.stringify(safeText(closeReason))}`
      );
    } catch (err) {
      this.error('Health line failed:', err.message);
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
   *
   * The brew has TIMING.BREW_DEADLINE_MS, from the call, to get its command
   * written; JuraClient.brew() checks that right before it writes (opts.sendBy)
   * and also whether the connection is still there (opts.reportNotSent). A
   * brew that is too late, or whose connection is gone, sends nothing and the
   * user is told so (see _brewNotSentText); the device does not send it again
   * by itself, the user taps again. A brew asked for while the machine is busy
   * with a drink or a rinse (opts.refuseInBrewPhase, see JuraClient.inBrewPhase)
   * is not sent either, and the user is told the machine is busy.
   */
  async brew(productName, overrides = {}) {
    // The deadline for sending, worked out here and nowhere else: the first
    // thing, in the same tick as the call, before the settings, the wait for
    // the gap and the connect. On the monotonic clock of the client, the one
    // it compares it with (a wall clock that steps would move the deadline).
    const deadlineMs = this._brewDeadlineMs();
    const deadlineAt = monotonicMs() + deadlineMs;
    // Whether another brew() of this device was still running when this one
    // started, fixed now (see _brewNotSentText).
    const othersRunning = this._brewsRunning > 0;
    this._brewsRunning += 1;
    try {
      return await this._brewBy(productName, overrides, deadlineAt, othersRunning, deadlineMs);
    } finally {
      this._brewsRunning -= 1;
    }
  }

  /**
   * The text for a brew that sent nothing: the deadline had passed
   * (BREW_DEADLINE) or the connection was gone when the command was to be
   * written (BREW_NOT_SENT). It says "this brew command", not "nothing was
   * brewed": with a double tap another tap may already have started a brew, or
   * may be about to. So when another brew() of this device was running when
   * this one started (`othersRunning`), is running now (the count includes this
   * brew itself, so more than 1), or an earlier one ended in doubt less than
   * UNCERTAIN_BREW_WINDOW_MS ago (BREW_NO_REPLY, BREW_CONNECTION_LOST: its
   * command may have reached the machine), it adds that another brew may have
   * started, and then leaves out "Try again.": the user is to check the machine
   * first.
   * @param {'BREW_DEADLINE'|'BREW_NOT_SENT'} code
   * @param {boolean} othersRunning
   * @param {number} deadlineMs the deadline this brew began with, as brew() worked it out
   * @returns {string}
   */
  _brewNotSentText(code, othersRunning, deadlineMs) {
    const text =
      code === 'BREW_DEADLINE'
        ? `This brew command was not sent: the machine could not be reached within ${Math.round(deadlineMs / 1000)} seconds.`
        : 'The connection to the machine dropped before this brew command was sent, so it did not reach the machine.';
    const uncertainRecently =
      this._lastUncertainBrewAt !== null && monotonicMs() - this._lastUncertainBrewAt < UNCERTAIN_BREW_WINDOW_MS;
    return othersRunning || this._brewsRunning > 1 || uncertainRecently
      ? `${text} Another brew may have started: check the machine before trying again.`
      : `${text} Try again.`;
  }

  /**
   * The body of brew(), with the deadline it worked out (the point in time, and
   * its length for the text) and whether another brew was running at its start.
   */
  async _brewBy(productName, overrides, deadlineAt, othersRunning, deadlineMs) {
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
    // A brew waits for the gap since the last session ended, if that is still
    // running (at most TIMING.RECONNECT_GAP_MS), and then connects.
    try {
      await this._connectIfNeeded({ waitForGap: true });
    } catch (err) {
      // The connect failed, so nothing was sent. The log keeps the raw text; the
      // user gets the sentence the tile shows for the same failure, not a socket
      // error such as "connect ECONNREFUSED 127.0.0.1:51515". The code stays on
      // the new error.
      this.error('Brew failed:', safeText(err.message, LOG_TEXT_MAX));
      const friendly = new Error(safeText(friendlyPollError(err), UNAVAILABLE_TEXT_MAX));
      if (err.code !== undefined) friendly.code = err.code;
      throw friendly;
    }
    const { isBrewAccept } = require('../../lib/juraClient');
    // Held in a local: a late failure of this client must not reset a client
    // that has been made since (see _resetClient).
    const client = this._client;
    let reply;
    try {
      reply = await client.brew(productName, finalOverrides, {
        retry: true,
        timeoutMs: BREW_TIMEOUT_MS,
        reportNotSent: true,
        sendBy: deadlineAt,
        refuseInBrewPhase: true,
      });
    } catch (err) {
      // JuraClient.brew() throws a coded BrewError for every failure while
      // talking to the machine (other errors, such as an unknown product,
      // are passed on as-is) -- log the raw message (useful in a
      // diagnostics report) and surface a plain-language reason to the
      // user instead of the technical one.
      this.error('Brew failed:', safeText(err.message, LOG_TEXT_MAX));
      if (err.code === 'BREW_NO_REPLY') {
        this._lastUncertainBrewAt = monotonicMs();
        throw new Error(
          `The machine did not respond to the brew command within ${BREW_TIMEOUT_MS / 1000} seconds. It may only have woken up from energy saving: check the machine before trying again, so you don't get a second drink.`
        );
      }
      if (err.code === 'BREW_REFUSED') {
        throw new Error(
          `The machine refused the brew command (reply: ${safeText(err.reply)}). It may be busy or need attention: check water, beans and the drip tray.`
        );
      }
      if (err.code === 'BREW_CONNECTION_LOST') {
        // Noted before the reset below awaits: a brew queued behind this one
        // can fail in that time and is worded by it (see _brewNotSentText).
        this._lastUncertainBrewAt = monotonicMs();
        // The connection itself is gone, so this client is of no use any more
        // (the next brew connects afresh). Not done for the codes above: the
        // machine answered or may still answer, and the connection is fine.
        await this._resetClient('connection lost during a brew', client);
        throw new Error('The connection to the machine dropped during the brew command. Check whether it started before trying again.');
      }
      if (err.code === 'BREW_DEADLINE' || err.code === 'BREW_NOT_SENT') {
        // Nothing was sent in this call. No _resetClient: with a dead
        // connection the next _connectIfNeeded throws the client away itself,
        // and with a live one (the deadline) it is fine as it is.
        throw new Error(this._brewNotSentText(err.code, othersRunning, deadlineMs));
      }
      if (err.code === 'BREW_BUSY') {
        // Nothing was sent: the machine is busy with a brew or a rinse (see
        // JuraClient.inBrewPhase). The connection is fine and nothing is in
        // doubt, so no _resetClient and no _lastUncertainBrewAt.
        throw new Error('The machine is busy (a drink or a rinse is running), so this brew command was not sent. Try again when it is done.');
      }
      throw err;
    }
    // Defensive: JuraClient.brew() should never resolve with anything
    // other than an accepted reply (see its own doc comment) -- but if
    // that contract ever slips, still refuse a not-accepted reply here
    // rather than reporting a brew that didn't actually happen as a
    // success.
    if (!isBrewAccept(reply)) {
      throw new Error(
        `The machine refused the brew command (reply: ${safeText(reply)}). It may be busy or need attention: check water, beans and the drip tray.`
      );
    }
    this.log(`Brew accepted (${safeText(reply)})`);
    return reply;
  }

}

// The timing every device runs on, see TIMING. It sits on the prototype, so a
// test can put a scaled copy on one instance, before or after onInit, without
// the production values ever changing.
JuraMachineDevice.prototype._timing = TIMING;

// The clock every wait and duration of this device is measured on, see
// monotonicMs in lib/juraClient.js: a step of the wall clock (an NTP
// correction, a manual change) does not move it. It sits on the prototype for
// the same reason as `_timing`: a test puts a steerable clock on one instance.
// Only differences between two readings mean anything.
JuraMachineDevice.prototype._monotonicNow = monotonicMs;

module.exports = JuraMachineDevice;
// Next to the class, so a test can read the production values.
module.exports.TIMING = TIMING;
