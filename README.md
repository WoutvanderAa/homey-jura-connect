# Jura Connect — Homey App

A Homey app (SDK v3) for Jura coffee machines fitted with the
**WiFi Connect** module — local, no cloud, no Jura account. Talks
directly to the WiFi dongle on TCP port 51515. Ships with profiles for
all 72 Jura models in the source library's catalogue; the E8 (what we
have at home) is the one that's actually been run against real
hardware. The protocol layer and the Homey driver have no
model-specific code at all — only the per-model product catalogue is
data, see "Supported models" below.

> This app is not made by, affiliated with, or endorsed by Jura
> Elektroapparate AG. "Jura" is a trademark of Jura Elektroapparate AG;
> this app is an independent, community-driven project.

**Does this already exist for Homey?** No — the Homey forum has been
asking for this since 2020 (see e.g.
[this thread](https://community.homey.app/t/j-o-e-app-van-jura-koffieapparaat/33873)),
without a working app ever showing up.

## Attribution

This is a JavaScript port of the reverse-engineering work in the
Python package **[`jura_connect`](https://pypi.org/project/jura-connect/)**
by **makefu** (`jura-connect-hass` on GitHub), itself derived from the
J.O.E. Android app. Without that work this wouldn't exist — all credit
for figuring out the handshake protocol, the cipher, and the machine
XML catalogue goes there. This repo is a port to Node.js/Homey, not
original reverse-engineering. Both projects are MIT-licensed (see
`LICENSE`).

## Supported models

**All 72 models** from the `jura_connect` library's `JOE_MACHINES.TXT`
catalogue are bundled (`lib/profiles/*.js`, one file per EF code,
mechanically extracted the same way as documented in
`lib/profiles/README.md`). Only one has actually been run against
physical hardware:

| Model | EF code | Status |
|---|---|---|
| Jura E8 (EB) | `EF538` | ✅ **live-verified** (article 15336, hwId `EF538M V01.05`) — pairing, status, brewing, maintenance percent |
| Everything else (71 profiles) | see `lib/models.js` | data bundled from the source catalogue, product/recipe encoding is a proven protocol-level constant across models, but not personally run against that specific hardware |

During pairing the model is auto-detected from the article number in
the discovery reply. If the app doesn't recognise the article number
(shouldn't happen often now that all known article numbers are
bundled), the pair flow shows a manual picker — each entry's label
includes its EF code, which usually matches what the machine itself
reports (hwId / data plate), so you can match it up directly.

Found a model missing, or think an EF code needs a newer variant? See
**`lib/profiles/README.md`** for the extraction steps — the protocol
foundation (`crypto.js`, `protocol.js`, `discovery.js`,
`juraClient.js`) never needs to change for that, only `lib/models.js`
and a new `lib/profiles/<EF_CODE>.js` file.

### A mislabeling this caught

The E8 we tested against reported article 15336 / hwId `EF538M
V01.05` at pairing time. Before all 72 models were bundled, the
pairing dropdown only offered `EF533`/`EF533V2`, so `EF533V2` was
picked manually as the closest guess — and brewing worked fine with
it. Once the full catalogue went in, it turned out article 15336
actually maps to **`EF538`**, a distinct profile — the hwId string
said so all along. `EF533V2` happened to be close enough to brew
correctly, but `EF538`'s product list is the accurate one. If you
paired before this fix and your machine looks like an E8, check its
device settings — the correct EF code is right there in the hwId the
app already showed you during pairing.

## What's verified, what isn't

Everything below was **verified while building**, not guessed — by
installing the actual `jura_connect` Python package and testing the JS
port byte-for-byte against the real implementation, and since v0.1.1
also live against a physical machine:

| Part | Status |
|---|---|
| `lib/crypto.js` (cipher) | ✅ 88 test vectors, byte-identical to Python, incl. all edge cases |
| `lib/discovery.js` (UDP discovery) | ✅ Tested synthetically and live (finds real machines on the LAN) |
| `lib/profile.js` (recipe encoder, model-agnostic) | ✅ Byte-exact against Python's encoder, for multiple models |
| `lib/profiles/*.js` (72 profiles) | ✅ Product data comes verbatim from the J.O.E. app's own catalogue; only `EF538`'s data has been cross-checked against a real machine |
| `lib/protocol.js` + `lib/juraClient.js` (handshake/status/brew/maintenance) | ✅ Mock-server tested, and live: pairing, status polling, brewing and maintenance-percent (`@TG:C0`) all work against a real Jura E8 |
| **Homey pair flow** (`driver.js`, `pair/*.html`) | ✅ **Live-verified** — see "Bugs found during live testing" below |
| **Everything against the real machine** | ✅ **Live-verified** — E8 (article 15336, hwId `EF538M V01.05`), pairing + status + brewing (espresso) + maintenance percent |

Not yet live-verified: any of the other 71 bundled profiles. The
model-not-recognised path (manual profile picker during pairing) has
been live-confirmed to work.

**Maintenance percent** (`jura_maintenance_cleaning`/`_filter`/`_descale`
capabilities, reading `@TG:C0`) is live-confirmed to return real
numbers (cleaning 20%, descale 50%, filter reporting `0xFF` — this
particular machine has no water filter cartridge fitted, which the app
correctly treats as "not tracked" rather than showing a bogus 255%).
What's *not* independently confirmed yet: whether higher percent means
"closer to due" or "just serviced" — that needs watching a value
change across an actual cleaning/descaling cycle. Titles are kept
direction-neutral until that's confirmed.

### Bugs found during live testing (fixed)

There was no protocol-level guesswork left, but the Homey pair flow
itself turned out to have three separate, mutually-masking bugs —
only visible once you actually run it against a real Homey and
machine:

1. **Race condition in `start.html`**: `Homey.showView('connect')` was
   called before the `select_machine` emit had been acknowledged, so
   the next view sometimes loaded with an empty selection. Fix:
   navigate only inside the emit's `.then()`.
2. **Redundant system "Next" button**: `app.json`'s `start` pair view
   had `"navigation": {"next": "connect"}` set, which makes Homey
   render its own button that completely bypassed the custom
   row-click handler (leaving the selection empty). Removed — this
   pair flow handles navigation itself.
3. **`Homey.setNavigationCloseable` doesn't exist** in this Homey
   CLI/runtime version (v4.4.1, software 13.4.0) and threw
   synchronously before the click handler ever reached
   `Homey.emit()` — from the outside it looked like clicking did
   nothing. Fix: wrapped in a `typeof` check.

Also, not bugs but network reality:

- **UDP broadcast discovery doesn't cross VLAN boundaries**, even with
  a firewall allow rule (that's how L3 routing works, not a policy
  thing). Added: a **manual IP entry** field in `start.html` as a
  fallback for cross-VLAN setups.
- The machine becomes **physically unreachable** after a short period
  of inactivity (auto-off/sleep) — the WiFi module goes fully offline.
  `device.js` then shows a readable "Machine appears to be off or
  unreachable" instead of a raw socket error code. There's no protocol
  command to remotely wake the machine from that state (see "Known
  limitations").

## Setup

1. The **WiFi Connect module** must already be paired to your network
   via the J.O.E. app (already the case here).
2. `npm install` — **no dependencies needed**, only Node's built-in
   `net`/`dgram`/`crypto`.
3. `homey app validate`
4. `homey app run` — requires Docker. Running against a Homey Pro (or
   Self-Hosted Server) without Docker installed locally? Use
   `homey app run --remote` instead: it builds and installs the app
   directly on the Homey, no container needed.
5. **Pair the device**: the app scans your network (UDP broadcast on
   port 51515), shows the detected model (or a manual picker if that
   fails), and then you need to **press OK on the machine itself**
   within 60 seconds — exactly like the J.O.E. app does. The auth hash
   gets stored, so you won't need to do that again.
   Is Homey on a different VLAN/subnet than the machine? UDP broadcast
   doesn't cross that — use the manual IP field at the bottom of the
   pair screen instead.

## Next steps

- **Confirm maintenance-percent direction** by watching the numbers
  move across a real cleaning/descaling cycle.
- **Live-verify more of the 72 bundled profiles** as that hardware
  becomes available.
- **Homey App Store publishing** is a separate track: Athom's own
  review, stricter icon guidelines than the current design, and an
  `author.email` in `app.json` (currently just a name).
- The icon (`assets/icon.svg`) is a first polish pass and can still be
  refined further.
- Raw maintenance counters (`@TG:43`) and per-product brew counters
  (`@TR:32`) exist in the protocol (see `jura_connect`'s
  `read_maintenance_counter`/`read_product_counters`) but aren't
  ported yet — the percent bank (`@TG:C0`) covers the "do I need to
  clean/descale/change the filter soon" use case more directly.

## Structure

```
app.json / app.js                    — manifest + "brew_product" flow action (autocomplete picker, filled from the paired device's own profile)
lib/crypto.js                        — cipher (verified, model-agnostic)
lib/protocol.js                      — TCP framing + FrameReader
lib/discovery.js                     — UDP discovery
lib/profile.js                       — recipe blob encoder (model-agnostic)
lib/models.js                        — model registry: ADD a new model HERE
lib/profiles/*.js                    — bundled product/alert data, one file per EF code (72 total)
lib/profiles/README.md               — step-by-step: adding a new model
lib/juraClient.js                    — handshake/pair, status, brew, maintenance percent
drivers/jura-machine/driver.js       — custom pair flow (discovery + model detection/picker)
drivers/jura-machine/device.js       — polling, capabilities, brew method
drivers/jura-machine/pair/*.html     — pair UI
drivers/jura-machine/assets/alarm_generic.svg — custom icon for the alarm_generic capability, replacing Homey's default bell
assets/icon.svg, assets/banner.svg   — source SVGs for the app icons (small/large.png are rendered from these)
```

## Known limitations (deliberate scope choices)

- Raw maintenance counters and per-product brew counters (pmode
  slots) aren't ported — present in the Python library, only the
  maintenance-percent bank was ported so far (see "Next steps").
- The machine cannot be turned **on** remotely (the protocol has no
  command for that, only standby); `device.js` reports that clearly
  instead of silently failing.
