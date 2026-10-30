'use strict';

const { Driver } = require('homey');
const discovery = require('../../lib/discovery');
const models = require('../../lib/models');
const { assertLocalAddress } = require('../../lib/address');
const { JuraClient, isMachineClosedError } = require('../../lib/juraClient');

class JuraMachineDriver extends Driver {

  async onInit() {
    this.log('Jura machine driver init');
  }

  /**
   * Custom two-screen pair flow (see pair/start.html + pair/connect.html):
   *  1. "start" broadcasts UDP discovery and lists machines found on the LAN.
   *  2. "connect" runs the interactive @HP: handshake against the chosen
   *     machine -- this is the step where the user has to confirm on the
   *     coffee machine's own display (button varies by model), so it
   *     needs live progress feedback
   *     rather than the generic list_devices/add_devices templates.
   */
  async onPair(session) {
    let discovered = [];
    let selectedMachine = null;
    // The client of the pairing that is running: client.pair waits up to 60 s
    // for the confirm on the machine, and the dongle allows one TCP session, so
    // a pair dialog that is closed (see 'disconnect' below) or a second 'pair'
    // must end it, or the next attempt is refused.
    let activeClient = null;

    session.setHandler('discover', async () => {
      this.log('Pair: broadcasting UDP discovery...');
      discovered = await discovery.discover({ timeoutMs: 4000, repeats: 3 });
      this.log(`Pair: found ${discovered.length} machine(s)`);
      // One line per machine, so a user with a model that is not in
      // lib/models.js yet can tell us its article number and hwId. Never the
      // name (can be a person's name) and never the address.
      for (const m of discovered) {
        const found = models.modelForArticle(m.articleNumber);
        this.log(
          `Pair: machine art. ${m.articleNumber || 'unknown'}, hwId ${m.hwId || 'unknown'}, fw ${m.fw || 'unknown'}: ${
            found ? found.label : 'not recognised'
          }`
        );
      }
      return discovered.map((m) => {
        const model = models.modelForArticle(m.articleNumber);
        return {
          address: m.address,
          name: m.name || m.hwId || m.address,
          fw: m.fw,
          hwId: m.hwId,
          articleNumber: m.articleNumber,
          ready: m.ready,
          standby: m.standby,
          // null when this exact article number isn't in lib/models.js yet --
          // the pair view then asks the user to pick a profile manually
          // instead of silently guessing (see connect.html).
          detectedModel: model,
        };
      });
    });

    // Available for the pair view's manual-picker fallback when a
    // machine's article number isn't recognised.
    session.setHandler('list_models', async () => models.listModels());

    // start.html calls this the moment the user taps a machine, then
    // navigates to the connect view -- storing the pick here (rather
    // than passing it through 'pair') because each pair *.html is a
    // fresh page load and doesn't retain JS state across showView().
    // Re-derives detectedModel from the matching *raw* entry in
    // `discovered` rather than trusting `selected` as-is: `discovered`
    // never carried detectedModel to begin with (only the mapped copy
    // the 'discover' handler above returned to the pair view did), so
    // without this, get_selected_machine below always came back with no
    // detectedModel even for an auto-detected machine -- connect.html
    // then always fell back to the manual picker instead of skipping
    // straight to the handshake.
    session.setHandler('select_machine', async (selected) => {
      const found = discovered.find((m) => m.address === selected.address);
      // Not one of the machines the scan found: the address was typed in
      // (start.html's manual field), so it must be one on the local network.
      if (!found) assertLocalAddress(selected.address);
      selectedMachine = found
        ? { ...found, detectedModel: models.modelForArticle(found.articleNumber) }
        : selected;
      return true;
    });

    // connect.html calls this on load to find out whether it needs to
    // show the manual model picker (selectedMachine.detectedModel is
    // null) or can go straight to the handshake.
    session.setHandler('get_selected_machine', async () => selectedMachine);

    // `manualProfileCode` is only sent when the pair view had to show
    // the manual picker (unrecognised article number); when the
    // article number matched lib/models.js, connect.html skips the
    // picker entirely and this is undefined. `pin` is normally empty --
    // only needed on a machine with a security PIN set via the J.O.E.
    // app (see connect.html's retry-with-pin UI). Pairing with the pin
    // prompt is confirmed working on a real Jura S8 (EF1151), reported
    // in GitHub issue #4. Resending the pin on every reconnect after
    // that is not explicitly confirmed.
    session.setHandler('pair', async ({ manualProfileCode, pin } = {}) => {
      if (activeClient) await activeClient.close().catch(() => {});
      const machine = selectedMachine;
      if (!machine) throw new Error('No machine selected, please go back and pick one');

      const profileCode =
        manualProfileCode || (machine.detectedModel && machine.detectedModel.profileCode);
      if (!profileCode) {
        throw new Error('No machine profile selected — please pick one from the list');
      }
      const profile = models.getProfile(profileCode);
      const connId = JuraClient.randomConnId();

      // The frame log runs during pairing too. The handler's own argument
      // ({ pin }) and its return value (the auth hash, the pin) are never
      // logged: the lines only come from FrameLog, which redacts the
      // handshake.
      const client = new JuraClient(machine.address, {
        connId,
        profile,
        pin: pin || '',
        logger: (line) => this.log('[frame]', line),
      });

      try {
        activeClient = client;
        const result = await client.pair(60000, (msg) => {
          session.emit('prompt', msg).catch(() => {});
        });
        if (result.state !== 'CORRECT') {
          const err = new Error(`Pairing rejected by machine: ${result.state}`);
          err.handshakeState = result.state;
          throw err;
        }
        if (!client.authHash) {
          if (result.hashLength !== undefined) {
            throw new Error(
              `Machine accepted pairing but sent an unusable token (length ${result.hashLength}). Please report this.`
            );
          }
          throw new Error('Machine accepted pairing but returned no auth hash — please retry.');
        }
        return {
          address: machine.address,
          name: machine.name || 'Jura Coffee Machine',
          connId,
          authHash: client.authHash,
          // Persisted so every later reconnect (device.js's _buildClient)
          // can keep sending it too -- @HP: includes the pin on every
          // handshake, not just the first, so a PIN-protected machine
          // needs it again on every future connection, not just pairing.
          pin: pin || '',
          profileCode,
          articleNumber: machine.articleNumber,
          hwId: machine.hwId,
          fw: machine.fw,
        };
      } catch (err) {
        // The machine reset or closed the connection while we waited for the
        // user to confirm on it (or to accept a first connection): the raw
        // text of the socket goes to the log, the user gets a sentence. A
        // PairingTimeout and the handler's own errors are passed on as they are.
        if (isMachineClosedError(err)) {
          this.error('Pair: the machine ended the connection:', err.message);
          throw new Error(
            'The machine ended the connection during pairing. Confirm the Connect prompt on the machine, close the J.O.E. app if it is connected, and try again.'
          );
        }
        throw err;
      } finally {
        if (activeClient === client) activeClient = null;
        await client.close().catch(() => {});
      }
    });

    // The pair dialog was closed: end the pairing that is still waiting, so the
    // dongle is free again for the next attempt at once.
    session.setHandler('disconnect', async () => {
      if (activeClient) await activeClient.close().catch(() => {});
    });

  }

}

module.exports = JuraMachineDriver;
