'use strict';

const { Driver } = require('homey');
const discovery = require('../../lib/discovery');
const models = require('../../lib/models');
const { JuraClient } = require('../../lib/juraClient');

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

    session.setHandler('discover', async () => {
      this.log('Pair: broadcasting UDP discovery...');
      discovered = await discovery.discover({ timeoutMs: 4000, repeats: 3 });
      this.log(`Pair: found ${discovered.length} machine(s)`);
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
    session.setHandler('select_machine', async (selected) => {
      selectedMachine = discovered.find((m) => m.address === selected.address) || selected;
      return true;
    });

    // connect.html calls this on load to find out whether it needs to
    // show the manual model picker (selectedMachine.detectedModel is
    // null) or can go straight to the handshake.
    session.setHandler('get_selected_machine', async () => selectedMachine);

    // `manualProfileCode` is only sent when the pair view had to show
    // the manual picker (unrecognised article number); when the
    // article number matched lib/models.js, connect.html skips the
    // picker entirely and this is undefined.
    session.setHandler('pair', async (manualProfileCode) => {
      const machine = selectedMachine;
      if (!machine) throw new Error('No machine selected, please go back and pick one');

      const profileCode =
        manualProfileCode || (machine.detectedModel && machine.detectedModel.profileCode);
      if (!profileCode) {
        throw new Error('No machine profile selected — please pick one from the list');
      }
      const profile = models.getProfile(profileCode);
      const connId = JuraClient.randomConnId();

      const client = new JuraClient(machine.address, { connId, profile });

      try {
        const result = await client.pair(60000, (msg) => {
          session.emit('prompt', msg).catch(() => {});
        });
        if (result.state !== 'CORRECT') {
          throw new Error(`Pairing rejected by machine: ${result.state}`);
        }
        if (!client.authHash) {
          throw new Error('Machine accepted pairing but returned no auth hash — please retry.');
        }
        return {
          address: machine.address,
          name: machine.name || 'Jura Coffee Machine',
          connId,
          authHash: client.authHash,
          profileCode,
          articleNumber: machine.articleNumber,
          hwId: machine.hwId,
          fw: machine.fw,
        };
      } finally {
        await client.close().catch(() => {});
      }
    });

  }

}

module.exports = JuraMachineDriver;
