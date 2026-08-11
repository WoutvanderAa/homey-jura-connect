# Adding support for another Jura model

This app's protocol layer (`crypto.js`, `protocol.js`, `discovery.js`,
`juraClient.js`, the recipe encoder in `profile.js`) is model-agnostic —
it works against whatever profile object it's handed. The only
model-specific pieces are the bundled profile data files in this
folder, and their registration in `../models.js`.

## Currently bundled

All 72 EF codes from `jura_connect`'s `JOE_MACHINES.TXT` are bundled
here, one file per code — see `../models.js`'s `MODELS` array for the
full list (label, EF code, every known article number). Two are
live-verified against real hardware so far, both with the `verified:
true` flag set in `models.js`:

| EF code | Model | Verified via |
|---|---|---|
| `EF538` | Jura E8 | our own machine — pairing, status, brewing, maintenance %, alarms |
| `EF1013` | ENA 4 (EA/EB/etc. — same EF code across regional variants) | an external tester's [GitHub issue #1](https://github.com/WoutvanderAa/homey-jura-connect/issues/1) — pairing, brewing, all five alarms at the time |

Every other bundled profile is untested against real hardware and
labelled accordingly in the pairing/settings UI.

## Adding a new one

1. **Find the EF code(s)** for the model. Install the `jura_connect`
   PyPI package locally (`pip install jura_connect`) and check its
   bundled `data/JOE_MACHINES.TXT` — it maps every article number
   Jura has shipped to a model name and EF code, e.g.:
   ```
   15480;S8 (EB);EF1091;13
   ```
   The same file also lists every article number for that EF code —
   collect all of them for step 3.

2. **Extract the profile** with the same script used to generate every
   file in this folder:
   ```python
   import json
   from jura_connect import profile

   p = profile.load_profile("EF_CODE_HERE")
   out = {"code": p.code, "products": [], "alerts": []}
   for prod in p.products:
       params = [{
           "kind": pm.kind, "argument": pm.argument, "offset": pm.offset,
           "default": pm.default, "min": pm.minimum, "max": pm.maximum,
           "step": pm.step,
           "items": [{"name": it.name, "value": it.value} for it in pm.items],
       } for pm in prod.params]
       out["products"].append({
           "code": prod.code, "name": prod.name, "rawName": prod.raw_name,
           "active": prod.active, "params": params,
       })
   for bit, alert in sorted(p.alert_by_bit.items()):
       out["alerts"].append({"bit": bit, "name": alert.name,
                              "severity": alert.severity, "rawName": alert.raw_name})
   json.dump(out, open(f"{p.code}.json", "w"), indent=2)
   ```
   Wrap the resulting JSON as `module.exports = {...}` in
   `lib/profiles/<EF_CODE>.js` (see any existing file here for the
   exact wrapper format).

3. **Register it** in `../models.js`:
   - add `EF_CODE: require('./profiles/EF_CODE')` to `PROFILE_FILES`
   - add an entry to the `MODELS` array with a friendly `label` and
     every `articleNumbers` value for that EF code from step 1

4. **Add it to the pairing dropdown** in `app.json`
   (`drivers[0].settings[0].children[1].values`) so it's selectable
   when auto-detection doesn't recognise a machine's article number.

Nothing in `driver.js`, `device.js`, or `juraClient.js` needs to
change — they all already read models generically through
`lib/models.js`.

## Verification checklist (do this before trusting a new profile)

The recipe blob encoding (`buildRecipeHex` in `../profile.js`) is a
protocol-level constant confirmed across multiple models by the
upstream `jura_connect` project, so it should be correct by
construction. Still worth checking on real hardware:

- [ ] Pairing handshake completes and returns an auth hash
- [ ] `@HU?` status reads back a plausible `@TF:` frame (not an error)
- [ ] The alert names shown for known machine states (e.g. "no beans",
      "heating up") actually match what the machine is doing — this is
      where a wrong EF code would show up first, since alert bit
      *positions* differ between machines
- [ ] A cheap/low-risk product (e.g. hot water) brews correctly before
      trying anything with milk or an expensive bean blend

## Alert-name survey (all 72 bundled profiles, 2026-08-09)

Alert bit *positions* differ between machines, but alert *names* turn
out to be far more consistent -- this is what `alarm_water` and
`alarm_beans` in `device.js` rely on. Coverage across every
bundled `lib/profiles/*.js` file's `alerts` array:

| Alert name | Coverage | Notes |
|---|---|---|
| `fill_water`, `no_beans`, `insert_tray`, `empty_tray`, `empty_grounds`, `insert_coffee_bin`, `fill_system`, `error_status`, `please_wait` | 100% (72/72) | Safe to key off by name for any bundled model |
| `outlet_missing`, `rear_cover_missing`, `milk_alert`, `heating_up`, `close_powder_cover`, `fill_powder` | 96-99% | Near-universal, a handful of profiles lack them |
| `close_front_cover`, `left_bean_alert`, `right_bean_alert`, `empty_grounds_rtc` | 44-49% | Roughly half the catalogue -- likely a hardware-generation split |
| `open_tap`, `coffee_eye_cup_detected` | 8-13% | Rare, probably specific to hot-water-tap or cup-detecting models |

Re-run this by requiring every file in this folder and tallying
`profile.alerts[].name` -- it's a five-line script, not worth
committing as a permanent tool, but worth re-deriving if the bundled
profile set changes materially.
