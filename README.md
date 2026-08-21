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

Live on the Homey App Store, certified, no special permission needed:
**https://homey.app/a/nl.brokebyte.juraconnect/**

Got a Jura with WiFi Connect that's a different model than the E8 or
ENA 4? Pair it and let us know how it went via
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

**Driver image** (`drivers/jura-machine/assets/images/{large,small}.png`):
a photo of the author's own paired E8, no external license needed.

## Supported models

**All 72 models** from `jura_connect`'s `JOE_MACHINES.TXT` catalogue
are bundled (`lib/profiles/*.js`, one file per EF code). Two are
verified against real hardware so far: the **Jura E8 (EF538)** and
the **ENA 4 (EF1013)**, the latter via an external tester's GitHub
issue rather than our own machine. Every other model's label is
suffixed "— experimental, untested" in the pairing/settings UI
(`lib/models.js`'s `verified` flag) — that's a literal statement, not
a disclaimer for show. Found a bug, or got one working? [Open an
issue](https://github.com/WoutvanderAa/homey-jura-connect/issues) so
it can be flipped to verified.

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
| `alarm_outlet_missing` | `outlet_missing` | The removable coffee-dispensing spout isn't attached. ~97% profile coverage, not 100% — see below. |
| `alarm_rear_cover_missing` | `rear_cover_missing` | The removable rear access panel isn't attached. ~96% profile coverage. |
| `jura_maintenance_cleaning`/`_filter`/`_descale` | `@TG:C0` | 0-100%, **higher = more due**, resets to 0 right after that maintenance action. `_filter` is hidden (not set) on machines with no filter cartridge fitted (raw value `0xFF`). |
| `brew_coffee_button` / `brew_espresso_button` | — | Quick-access buttons on the device tile for the only two products **every** bundled profile has (100% coverage — see notes below). Same destructive, no-abort behaviour as any other brew call. Water amount can be overridden via the device's own `coffee_ml`/`espresso_ml` settings (0 = use the machine's built-in default). |
| `brew_product` (flow action) | — | Autocomplete picker filled from the paired device's own profile — the flexible route for anything beyond coffee/espresso, since product lists vary wildly per model (2 to 31 products). |

The five alert names behind the first four alarms above (`fill_water`,
`no_beans`, `insert_tray`, `empty_tray`, `empty_grounds`) were picked
by surveying every bundled profile's alert list — they're the ones
present, by name, in **all 72** profiles (see
`lib/profiles/README.md`), so they work for any paired model.
`insert_coffee_bin` and `fill_system` are also 100% but read as
mechanical faults rather than something worth a flow notification, so
they stay folded into `alarm_generic`. `outlet_missing`/
`rear_cover_missing` are the next tier down at 96-97% (70/72 and
69/72 profiles respectively) — not universal, but common enough to be
worth their own capability; on the handful of profiles that lack the
alert name entirely, these two simply never go `true`, same as any
other alarm on a machine that can't report it.

Every custom capability here uses the `alarm_` prefix on purpose:
Homey grants automatic device-tile grouping and a warning icon to
anything prefixed `alarm_`. **Flow cards are not automatic**, though
— that only applies to Homey's own built-in `alarm_*` capabilities
(like `alarm_water`, which ships with its own cards for free); custom
ones still need explicit `flow.triggers`/`flow.conditions` entries in
`app.json` (see the `<capability>_true`/`_false` trigger-id convention
there) plus a `registerRunListener` for each condition in `app.js`.
Learned this the hard way after assuming the prefix alone was enough.

Maintenance-percent direction is confirmed via
[`jura-connect-hass`](https://github.com/makefu/jura-connect-hass)'s
own docs ("percent-to-next-service" indicators), not guessed.

**Why only 2 quick buttons, not a full J.O.E.-style product menu on the
device tile:** checked this properly before deciding. Coverage falls
off a cliff past coffee/espresso (cappuccino 61/72, latte macchiato
59/72, then a long tail of 60+ products each on a handful of models),
and the biggest single profile has 31 products — nowhere near
button-tile territory. More fundamentally, Homey's capability enum
values are fixed per app manifest, identical for every device using
that capability; there's no per-device dynamic value list at the
capability level the way flow-card autocomplete arguments have
(`registerArgumentAutocompleteListener`, which `brew_product` already
uses). A true dynamic per-model menu isn't buildable as a device-tile
capability — `brew_product`'s flow-action autocomplete already *is*
Homey's equivalent of that, just one level up from the tile itself.

## What's verified

Verified by installing the real `jura_connect` Python package and
testing the JS port byte-for-byte against it, then live against a
physical E8:

| Part | Status |
|---|---|
| `lib/crypto.js` | ✅ 88 test vectors, byte-identical to Python |
| `lib/discovery.js` | ✅ Synthetic + live (finds real machines on the LAN) |
| `lib/profile.js` (recipe encoder) | ✅ Byte-exact against Python, multiple models |
| `lib/profiles/*.js` (72 profiles) | ✅ Data from the J.O.E. catalogue; `EF538` and `EF1013` cross-checked against real hardware |
| `lib/juraClient.js` (handshake/status/brew/maintenance) | ✅ Mock-server + live against a real E8, and against a real ENA 4 via an external tester |
| Homey pair flow (`driver.js`, `pair/*.html`) | ✅ Live-verified — see "Bugs fixed, and known limitations" below |
| Full stack against real hardware | ✅ E8 (article 15336, hwId `EF538M V01.05`): pairing, status, brewing, maintenance %, alarms. ENA 4 (article 15501, EF1013): pairing, brewing (coffee + espresso), all five alarms — tested by Dijker via [GitHub issue #1](https://github.com/WoutvanderAa/homey-jura-connect/issues/1) |

Not yet live-verified: any of the other 70 bundled profiles.

## Bugs fixed, and known limitations

The first group below is history — real bugs, all already fixed, kept
here as a record of what to watch for (some of these mistakes have a
habit of repeating). The second group is still true today: hardware
and protocol realities that no code change here can fix.

**Bugs found against real hardware, now fixed** (`homey app validate`
caught none of these — every one only showed up live):

- **Pair-flow race condition**: `start.html` called
  `Homey.showView('connect')` before the `select_machine` emit was
  acknowledged, sometimes loading the next view with an empty
  selection. Fixed by navigating inside the emit's `.then()`.
- **Redundant system "Next" button**: `app.json`'s `start` pair view
  had `navigation.next` set, which made Homey render its own button
  that bypassed the custom row-click handler entirely. Removed.
- **`Homey.setNavigationCloseable` doesn't exist** in this Homey
  CLI/runtime (v4.4.1, software 13.4.0) — threw synchronously before
  the click handler ever reached `Homey.emit()`. Wrapped in a `typeof`
  check.
- Before all 72 models were bundled, our own live E8 (article 15336,
  hwId `EF538M V01.05`) was paired manually as `EF533V2` since `EF538`
  wasn't in the list yet — it brewed fine, but `EF538` is the actually
  correct profile. If you paired before this fix, check your device
  settings against the hwId shown at pairing time.
- **Two unrelated icon bugs, both invisible until checked on a real
  device**:
  - The app icon's very first version was outline/stroke-only per a
    literal reading of Homey's "no filled illustrations" guideline
    text, and rendered as a blank circle live. Homey masks the app
    icon via CSS `mask-image`, which is luminance-based, not
    alpha-based — a mid-tone fill colour is nearly invisible against a
    dark `brandColor` backdrop regardless of how opaque it is. Fixed by
    using a filled shape (white, maximum luminance) with the bean's
    crease as a genuine cut-out (`fill-rule="evenodd"` compound path)
    instead of a stroke overlay.
  - Separately, every capability icon (`alarm_*.svg`) rendered as an
    empty/missing placeholder regardless of fill colour, for a
    completely different reason: a literal `--` inside an SVG
    `<!-- comment -->` body is invalid XML, and it silently broke every
    icon that had one — which, after several rounds of "fix the
    colour" guesses, turned out to be all of them (this exact mistake
    — a `--` inside a comment — had already happened twice earlier in
    this same project for the app/driver icon; watch for it). Also
    learned along the way: a capability's `icon` needs to be set in its
    **`app.json` definition** (`"icon": "/path/to.svg"` inside the
    `capabilities` block), not only via runtime
    `setCapabilityOptions()` — Homey appears to snapshot a capability's
    icon at the moment it's first added to a device, so already-paired
    devices need a one-time forced `removeCapability`/`addCapability`
    (see `device.js`'s `onInit`) to pick up an icon added after the
    fact.
- **`brew()` could report a genuinely successful brew as a failure**
  (`Machine did not accept the brew command (reply: @hu:800)`),
  confirmed on both a real E8 and a real E4 — so not model-specific.
  First suspected a poll cycle and the brew racing for the same reply
  on one connection, so `request()`/`connect()` were serialized
  through a per-client queue (`_enqueue` in `juraClient.js`) — a real
  latent bug worth having fixed regardless, but it turned out *not* to
  be the cause here: the exact same `@hu:800` reply came back again
  after that fix, identically, which a genuine race wouldn't reproduce
  so precisely. The actual pattern: it happened right as the machine
  woke from `energy_safe`, matching the code's existing "first `@TP:`
  just wakes the machine, resend" handling — except the retry fired
  instantly, before the wake-up had actually finished, so the second
  attempt got the same not-yet-ready reply too. Fixed two ways: a 3s
  pause before that retry, and — since there's no way to know what
  every one of the 72 profiles' wake-up reply looks like, or catalogue
  it as new ones turn up — a fallback in `device.js` that checks
  whether the machine is actually `heating_up` before giving up,
  regardless of what the reply text says.

**Still true today — hardware/network/protocol realities, not bugs:**

- **UDP broadcast discovery doesn't cross VLANs**, even with a
  firewall allow rule (L3 routing behaviour, not a policy setting).
  `start.html` has a manual IP-entry fallback for cross-VLAN setups.
- **The machine goes fully unreachable after its auto-off timer** —
  the WiFi module powers down too. `device.js` shows "Machine appears
  to be off or unreachable" instead of a raw socket error, but there's
  no way to remotely wake it.
- **The on-machine pairing confirmation isn't always an "OK" button** —
  the E8 has one, but a real ENA 4 confirms via its bean button
  instead. The pairing prompt text is model-agnostic ("confirm on the
  machine's display") to match.
- **Alarms (tray/water/etc.) can lag a physical change by 3-4
  minutes**, confirmed on both an E8 and an ENA 4 — a full, restart-free
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
- **No protocol command reads a machine's own personalised recipe
  settings** — `@TP:` always requires a complete explicit recipe, so
  without an override, every brew silently uses the bundled profile's
  factory-default water amount, not whatever you've dialled in on the
  machine itself. There's no fixing this from the client side either;
  the device's own `coffee_ml`/`espresso_ml` settings are the
  workaround, not a real fix.

## Setup

For running the app from source (contributing, adding a model, or
just poking around) — regular users don't need any of this, just the
App Store link in "Try it" above.

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
- Raw maintenance counters (`@TG:43`) and per-product brew counters
  (`@TR:32`) exist in the protocol but aren't ported — the percent
  bank (`@TG:C0`) already covers the main "do I need to
  clean/descale/refill soon" use case.

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
drivers/jura-machine/assets/icon.svg — driver icon (flow-card/capability-list icon-inner elements)
drivers/jura-machine/assets/alarm_*.svg — custom capability icons
drivers/jura-machine/assets/maintenance_*.svg — maintenance-percent capability icons
drivers/jura-machine/assets/button_*.svg — brew_coffee_button/brew_espresso_button icons
drivers/jura-machine/assets/images/{large,small}.png — driver image, a real photo of the E8
drivers/jura-machine/assets/machine.svg — old illustrated driver-image source, kept for reference only
assets/icon.svg                      — app icon source: filled coffee bean with a cut-out crease, transparent background
assets/images/{large,small}.png      — app store banner, a real photo (credited in "Attribution")
assets/banner.svg                    — old illustrated banner source, kept for reference only
README.txt / README.nl.txt           — plain-text App Store listing blurb (not this file)
```
