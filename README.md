# Jura Connect — Homey App

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/woutvanderaa)

A Homey app (SDK v3) for Jura coffee machines fitted with the
**WiFi Connect** module — local, no cloud, no Jura account. Talks
directly to the WiFi dongle on TCP port 51515. The protocol layer and
Homey driver have no model-specific code; only the per-model product
catalogue is data (see "Supported models").

> This app is not made by, affiliated with, or endorsed by Jura
> Elektroapparate AG. "Jura" is a trademark of Jura Elektroapparate AG;
> this app is an independent, community-driven project.

**Does this already exist for Homey?** No — the Homey forum has been
asking for this since 2020 (see e.g.
[this thread](https://community.homey.app/t/j-o-e-app-van-jura-koffieapparaat/33873)),
without a working app ever showing up.

## Try it

Currently in Homey's Test/certification pipeline — install it via the
Test link, no special permission needed:
**https://homey.app/a/nl.brokebyte.juraconnect/test/**

Got a Jura with WiFi Connect that's a different model than the E8?
Pair it and let us know how it went via
[GitHub issues](https://github.com/WoutvanderAa/homey-jura-connect/issues)
— that's how untested profiles get flipped to verified for the next
person.

## Attribution

JavaScript port of the reverse-engineering work in the Python package
**[`jura_connect`](https://pypi.org/project/jura-connect/)** by
**makefu** (`jura-connect-hass` on GitHub), itself derived from the
J.O.E. Android app. All credit for the handshake protocol, the
cipher, and the machine XML catalogue goes there — this repo is a
port, not original reverse-engineering. Both projects are MIT-licensed
(see `LICENSE`).

**App Store banner photo** (`assets/images/{large,small}.png`): a real
Jura Z8 brewing coffee, by **coffee-rank**
([source](https://www.flickr.com/photos/189612330@N06/50330277776)),
licensed [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/),
cropped from the original.

## Supported models

**All 72 models** from `jura_connect`'s `JOE_MACHINES.TXT` catalogue
are bundled (`lib/profiles/*.js`, one file per EF code). Only the
**Jura E8 (EF538)** has been run against physical hardware; every
other model's label is suffixed "— experimental, untested" in the
pairing/settings UI (`lib/models.js`'s `verified` flag) — that's a
literal statement, not a disclaimer for show. Found a bug, or got one
working? [Open an issue](https://github.com/WoutvanderAa/homey-jura-connect/issues)
so it can be flipped to verified.

During pairing the model is auto-detected from the discovery reply's
article number. If it isn't recognised, the manual picker's labels
include the EF code, which usually matches the machine's own hwId —
useful for self-identifying. To add a model that's somehow still
missing, see `lib/profiles/README.md`; the protocol foundation
(`crypto.js`, `protocol.js`, `discovery.js`, `juraClient.js`) never
needs to change, only `lib/models.js` and a new profile file.

## Capabilities

| Capability | Source | Notes |
|---|---|---|
| `onoff` | `@HU?` status | Fully read-only — toggling either direction throws. There's no remote power-*on* command, and power-*off* (`@AN:02`) is a UART/Bluetooth-era command that `jura_connect`'s own command registry documents the WiFi dongle silently ignoring; confirmed on a real ENA 4. If it ever works on your firmware, that's worth reporting. |
| `alarm_generic` | any active error bit | Catch-all "needs attention", custom cup icon instead of Homey's bell. |
| `alarm_water` | `fill_water` | Homey's built-in water-alarm capability/icon. |
| `alarm_beans` | `no_beans` | Custom capability + icon. |
| `alarm_tray` | `empty_tray` / `empty_grounds` | Tray or grounds container present but **full**, needs emptying. |
| `alarm_tray_missing` | `insert_tray` | Tray not inserted **at all** — a genuinely different physical state from "full", not a duplicate. Machine won't run until it's back in. |
| `jura_maintenance_cleaning`/`_filter`/`_descale` | `@TG:C0` | 0-100%, **higher = more due**, resets to 0 right after that maintenance action. `_filter` is hidden (not set) on machines with no filter cartridge fitted (raw value `0xFF`). |
| `brew_product` (flow action) | — | Autocomplete picker filled from the paired device's own profile. |

The five alert names behind these alarms (`fill_water`, `no_beans`,
`insert_tray`, `empty_tray`, `empty_grounds`) were picked by surveying
every bundled profile's alert list — they're the ones present, by
name, in **all 72** profiles (see `lib/profiles/README.md`), so they
work for any paired model. `insert_coffee_bin` and `fill_system` are
also 100% but read as mechanical faults rather than something worth a
flow notification, so they stay folded into `alarm_generic`.
`outlet_missing`/`rear_cover_missing` (96-97%) would be reasonable
next additions on the same pattern.

Every custom capability here uses the `alarm_` prefix on purpose:
Homey grants automatic device-tile grouping and a warning icon to
anything prefixed `alarm_`. **Flow cards are not automatic**, though
— that only applies to Homey's own built-in `alarm_*` capabilities
(like `alarm_water`, which ships with its own cards for free); custom
ones like `alarm_beans`/`alarm_tray`/`alarm_tray_missing` still need
explicit `flow.triggers`/`flow.conditions` entries in `app.json` (see
the `<capability>_true`/`_false` trigger-id convention there) plus a
`registerRunListener` for each condition in `app.js`. Learned this the
hard way after assuming the prefix alone was enough.

Maintenance-percent direction is confirmed via
[`jura-connect-hass`](https://github.com/makefu/jura-connect-hass)'s
own docs ("percent-to-next-service" indicators), not guessed.

## What's verified

Verified by installing the real `jura_connect` Python package and
testing the JS port byte-for-byte against it, then live against a
physical E8:

| Part | Status |
|---|---|
| `lib/crypto.js` | ✅ 88 test vectors, byte-identical to Python |
| `lib/discovery.js` | ✅ Synthetic + live (finds real machines on the LAN) |
| `lib/profile.js` (recipe encoder) | ✅ Byte-exact against Python, multiple models |
| `lib/profiles/*.js` (72 profiles) | ✅ Data from the J.O.E. catalogue; only `EF538` cross-checked against real hardware |
| `lib/juraClient.js` (handshake/status/brew/maintenance) | ✅ Mock-server + live against a real E8 |
| Homey pair flow (`driver.js`, `pair/*.html`) | ✅ Live-verified — see "Quirks found" below |
| Full stack against real hardware | ✅ E8 (article 15336, hwId `EF538M V01.05`): pairing, status, brewing, maintenance %, alarms |

Not yet live-verified: any of the other 71 bundled profiles.

## Quirks found during live testing

Three Homey pair-flow bugs, only visible against a real Homey + machine:

- **Race condition**: `start.html` called `Homey.showView('connect')`
  before the `select_machine` emit was acknowledged, sometimes loading
  the next view with an empty selection. Fixed by navigating inside
  the emit's `.then()`.
- **Redundant system "Next" button**: `app.json`'s `start` pair view
  had `navigation.next` set, which made Homey render its own button
  that bypassed the custom row-click handler entirely. Removed.
- **`Homey.setNavigationCloseable` doesn't exist** in this Homey
  CLI/runtime (v4.4.1, software 13.4.0) — threw synchronously before
  the click handler ever reached `Homey.emit()`. Wrapped in a `typeof`
  check.

Network/hardware realities, not bugs:

- **UDP broadcast discovery doesn't cross VLANs**, even with a
  firewall allow rule (L3 routing behaviour, not a policy setting).
  `start.html` has a manual IP-entry fallback for cross-VLAN setups.
- **The machine goes fully unreachable after its auto-off timer** —
  the WiFi module powers down too. `device.js` shows "Machine appears
  to be off or unreachable" instead of a raw socket error, but there's
  no way to remotely wake it.
- Before all 72 models were bundled, our own live E8 (article 15336,
  hwId `EF538M V01.05`) was paired manually as `EF533V2` since `EF538`
  wasn't in the list yet — it brewed fine, but `EF538` is the actually
  correct profile. If you paired before this fix, check your device
  settings against the hwId shown at pairing time.
- **Alarms (tray/water/etc.) can lag a physical change by 3-4
  minutes**, confirmed on both an E8 and an ENA 4 — reported as a bug
  at first, but this is not this app's polling: a full, restart-free
  test showed `@HU?` replies coming back exactly every 10s the entire
  time, just with a stale-but-honest value until the machine's own
  status word caught up. `jura_connect`'s own simulator documents
  "periodic unsolicited `@TF:` status broadcasts" as a real protocol
  feature, and `jura-connect-hass`'s README notes "JURA dongles sleep
  regularly" — so the machine/dongle appears to refresh its internal
  status on its own multi-minute cycle, independent of how often
  anything asks. There's no faster read command to fall back on
  (`@HU?` is the only one, in this app and upstream), so this isn't
  fixable from the client side.

## Setup

1. The **WiFi Connect module** must already be paired to your network
   via the J.O.E. app.
2. `npm install` — no dependencies, only Node's built-in `net`/`dgram`/`crypto`.
3. `homey app validate`
4. `homey app run` — requires Docker. Without Docker (e.g. a remote
   Homey Pro/Self-Hosted Server), use `homey app run --remote`
   instead: builds and installs directly on the Homey.
5. **Pair the device**: UDP-broadcast scan, then confirm the "Connect"
   prompt on the machine's own display within 60 seconds — the exact
   button varies by model (often OK/checkmark, the bean button on the
   ENA line). Homey on a different VLAN than the machine? Use the
   manual IP field at the bottom of the pair screen — broadcast
   discovery can't cross that boundary.

## Next steps

- Live-verify more of the 72 bundled profiles as hardware becomes available.
- `outlet_missing`/`rear_cover_missing` alarms, on the same
  survey-then-add pattern as the current three.
- Raw maintenance counters (`@TG:43`) and per-product brew counters
  (`@TR:32`) exist in the protocol but aren't ported — the percent
  bank (`@TG:C0`) already covers the main "do I need to
  clean/descale/refill soon" use case.
- **Homey App Store publishing**: first certification submission was
  rejected on four points — description too long/implementation-heavy
  (fixed: now a one-line tagline), app icon and driver image being the
  same filled cup glyph rather than distinct outline art (fixed: app
  icon is now an outline coffee bean, no fill, no background colour,
  per Homey's guidelines), driver image needing to be a real product
  photo instead of an enlarged icon (fixed: real E8 photo), and the
  app banner needing to be a genuine lifestyle photo instead of an
  illustration (fixed: real photo, credited in "Attribution" above).
  All four addressed — ready to resubmit.

## Structure

```
app.json / app.js                    — manifest + "brew_product" flow action
lib/crypto.js                        — cipher (model-agnostic)
lib/protocol.js                      — TCP framing + FrameReader
lib/discovery.js                     — UDP discovery
lib/profile.js                       — recipe blob encoder (model-agnostic)
lib/models.js                        — model registry: ADD a new model HERE
lib/profiles/*.js                    — bundled product/alert data, one file per EF code (72 total)
lib/profiles/README.md               — step-by-step: adding a new model + alert-name survey
lib/juraClient.js                    — handshake/pair, status, brew, maintenance percent
drivers/jura-machine/driver.js       — custom pair flow (discovery + model detection/picker)
drivers/jura-machine/device.js       — polling, capabilities, brew method
drivers/jura-machine/pair/*.html     — pair UI
drivers/jura-machine/assets/alarm_*.svg — custom capability icons
drivers/jura-machine/assets/images/{large,small}.png — driver image, a real photo of the E8
drivers/jura-machine/assets/machine.svg — old illustrated driver-image source, kept for reference only
assets/icon.svg                      — app icon source: outline coffee bean, transparent background
assets/images/{large,small}.png      — app store banner, a real photo (credited in "Attribution")
assets/banner.svg                    — old illustrated banner source, kept for reference only
README.txt / README.nl.txt           — plain-text App Store listing blurb (not this file)
```
