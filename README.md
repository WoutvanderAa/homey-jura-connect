# Jura Connect — Homey App

A Homey app (SDK v3) for Jura coffee machines fitted with the
**WiFi Connect** module — local, no cloud, no Jura account. Talks
directly to the WiFi dongle on TCP port 51515. Currently ships support
for the E8 (that's what we have at home), but the architecture is
generic: the protocol layer and the Homey driver have no E8-specific
code at all — only the per-model product catalogue is data you plug
in, see "Extending to other models" below.

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

| Model | EF code(s) | Status |
|---|---|---|
| Jura E8 | `EF533`, `EF533V2` | ✅ **live-verified** (article 15336, hwId `EF538M V01.05`) — pairing, status, brewing |
| Jura E6 | `EF532`, `EF532V2` | data bundled, not personally tested (no E6 at home) |
| Jura S8 (EB) | `EF1091` | data bundled, the most live-verified profile in the source library itself |

See **`lib/profiles/README.md`** for the exact steps to add a new
model — the protocol foundation (`crypto.js`, `protocol.js`,
`discovery.js`, `juraClient.js`) doesn't need to change for that, only
`lib/models.js` and a new `lib/profiles/<EF_CODE>.js` file.

During pairing the model is auto-detected from the article number in
the discovery reply. If the app doesn't recognise the article number,
the pair flow shows a manual picker instead of silently guessing.

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
| `lib/profiles/EF533*.js`, `EF532*.js`, `EF1091.js` | ✅ Product data comes verbatim from the J.O.E. app itself |
| `lib/protocol.js` + `lib/juraClient.js` (handshake/status/brew) | ✅ Mock-server tested, and live: pairing, status polling and brewing all work against a real Jura E8 |
| **Homey pair flow** (`driver.js`, `pair/*.html`) | ✅ **Live-verified** — see "Bugs found during live testing" below |
| **Everything against the real machine** | ✅ **Live-verified** — E8 (article 15336, hwId `EF538M V01.05`), pairing + status + brewing (espresso) |

Not yet live-verified: the E6 and S8 profiles (`EF532*`, `EF1091`) —
that data is still "bundled, not personally tested" as in the table
above. The model-not-recognised path (manual profile picker during
pairing) has been live-confirmed to work, but with an E8 profile
selected.

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

- **Live-verify the E6 and S8 profiles** once that hardware is
  available — currently still "data bundled, untested".
- **Homey App Store publishing** is a separate track: Athom's own
  review, stricter icon guidelines than the current design, and an
  `author.email` in `app.json` (currently just a name).
- The icon (`assets/icon.svg`) is a first polish pass and can still be
  refined further.

## Structure

```
app.json / app.js                    — manifest + "brew_product" flow action (autocomplete picker, filled from the paired device's own profile)
lib/crypto.js                        — cipher (verified, model-agnostic)
lib/protocol.js                      — TCP framing + FrameReader
lib/discovery.js                     — UDP discovery
lib/profile.js                       — recipe blob encoder (model-agnostic)
lib/models.js                        — model registry: ADD a new model HERE
lib/profiles/EF533*.js, EF532*.js, EF1091.js  — bundled product/alert data per model
lib/profiles/README.md               — step-by-step: adding a new model
lib/juraClient.js                    — handshake/pair, status, brew
drivers/jura-machine/driver.js       — custom pair flow (discovery + model detection/picker)
drivers/jura-machine/device.js       — polling, capabilities, brew method
drivers/jura-machine/pair/*.html     — pair UI
drivers/jura-machine/assets/alarm_generic.svg — custom icon for the alarm_generic capability, replacing Homey's default bell
assets/icon.svg, assets/banner.svg   — source SVGs for the app icons (small/large.png are rendered from these)
```

## Known limitations (deliberate scope choices for v0.1)

- Five profiles bundled (E8×2, E6×2, S8 EB) — not the full 88-device
  catalogue from the Python library. Extending it is a matter of
  adding data, see `lib/profiles/README.md`.
- No maintenance counters / product counters / pmode slots ported —
  present in the Python library, deliberately left out for v0.1.
- The machine cannot be turned **on** remotely (the protocol has no
  command for that, only standby); `device.js` reports that clearly
  instead of silently failing.
