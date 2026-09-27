# Jura Connect for Homey

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/woutvanderaa)

A Homey app (SDK v3) for Jura coffee machines fitted with the WiFi Connect
module, talking directly to the dongle over TCP port 51515. Fully local:
no cloud, no Jura account.

> This app is not made by, affiliated with, or endorsed by Jura
> Elektroapparate AG. "Jura" is a trademark of Jura Elektroapparate AG;
> this app is an independent, community-driven project.

## Install

Available on the Homey App Store:
**https://homey.app/a/nl.brokebyte.juraconnect/**

Requirement: the WiFi Connect dongle must already be paired to your
network via the J.O.E. app.

## Supported models

All 72 models from the J.O.E. app's own catalogue are bundled, one
profile per EF code. Verified so far:

| Model | Profile | Verified | Source |
|---|---|---|---|
| E8 (EB) | EF538 | Full: pairing, status, brewing, maintenance percentages, alarms | Maintainer's own machine |
| ENA 4 (EA) | EF1013 | Pairing, coffee, espresso, water alarm, tray-missing alarm | [GitHub issue #1](https://github.com/WoutvanderAa/homey-jura-connect/issues/1) |
| S8 (NAB) | EF1151 | Pairing only, with a security PIN | [GitHub issue #4](https://github.com/WoutvanderAa/homey-jura-connect/issues/4) |
| E8 (EC) | EF1092 | Alarms | [Homey forum](https://community.homey.app/t/158080) |

Every other bundled model shows as "experimental, untested" in the
pairing and settings picker. Does it work on your model, or not?
Report it via the "Model verification report" issue template, that's
how a model gets flipped to verified.

During pairing the app recognises your model automatically from the
discovery reply. If you enter the IP address manually instead, pick
the model yourself from the list.

## Features

| Capability | What it shows |
|---|---|
| `onoff` | On/off state, read-only |
| `alarm_generic` | Needs attention (any active error) |
| `alarm_water` | Water tank empty |
| `alarm_beans` | Out of beans |
| `alarm_tray` | Drip tray or grounds container full |
| `alarm_tray_missing` | Drip tray not inserted |
| `alarm_outlet_missing` | Coffee spout not attached |
| `alarm_rear_cover_missing` | Rear access panel not attached |
| `jura_maintenance_cleaning` / `_filter` / `_descale` | Percent until due, higher = sooner |
| `brew_coffee_button` / `brew_espresso_button` | Quick-brew buttons on the device tile |
| `brew_hotwater_button` | Same, only added on machines that actually have this product |

Flow cards: a "Brew a product" action covering any product your
specific machine has, with an optional strength argument; a trigger
and a condition for each alarm above; and a "crossed above X%" trigger
plus an "is above X%" condition for each maintenance type. "Total
brews" is available in the device settings, under Statistics.

## Settings

Water amounts (ml) for coffee, espresso and hot water. 0 uses the
default from the machine's own profile.

Strength for coffee and espresso is the level number your machine
itself shows, on whatever scale that machine uses: a numeric scale
(e.g. 1 to 10, or 3 to 10 on some E6/E8 models), or a named scale
where 1 is the mildest (e.g. 1 = mild, 2 = normal, 3 = strong). The
label above each field shows the numbers your specific machine has.
0 uses the default strength from the machine's profile, not whatever
you've dialled in on the machine itself (the app can't read that). A
value your machine doesn't have is rejected when you save.

## Known limitations

- UDP discovery doesn't cross VLANs: use the manual IP field and pick
  the model yourself.
- After the machine's own auto-off timer kicks in, the dongle goes
  unreachable too. There's no way to wake it remotely.
- Remote on/off isn't possible; the dongle ignores that command.
- The J.O.E. app can't connect while Homey is connected. The dongle
  only accepts one connection at a time.
- Alarms can lag the machine's actual state by a few minutes. The
  cause is in how this app processes status messages; a fix is
  planned for 0.13.0.
- There's no way to remotely abort a brew already in progress.

## Reporting a problem

Use the GitHub issue templates: bug report, feature request, or model
verification. Including a Homey diagnostics report ID helps a lot.

## Credits

JavaScript port of **[`jura_connect`](https://github.com/makefu/jura-connect)**
(PyPI package `jura-connect`) by **makefu**, and by extension of the
J.O.E. Android app it was itself derived from. The Home Assistant
integration **[`jura-connect-hass`](https://github.com/makefu/jura-connect-hass)**
is by the same author.

### Image credits

**App Store banner photo**: a real Jura Z8 brewing coffee, by
**coffee-rank** ([source](https://www.flickr.com/photos/189612330@N06/50330277776)),
licensed [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/),
cropped from the original.

**Driver image**: a photo of the maintainer's own paired E8.

## Development

```
npx homey app validate --level publish
npx homey app run --remote
```

No dependencies. Without `--remote`, the CLI asks for Docker instead.

- `lib/`: protocol layer (crypto, framing, discovery) and the bundled
  per-model profiles
- `drivers/jura-machine/`: the driver, device, and pairing views

## License

MIT, see `LICENSE`.
