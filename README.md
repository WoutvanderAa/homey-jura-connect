# Jura Connect — Homey App

Homey-app (SDK v3) voor Jura-koffiemachines met de **WiFi Connect**-module —
lokaal, geen cloud, geen Jura-account. Praat rechtstreeks met de
WiFi-dongle op TCP-poort 51515. Momenteel ondersteuning voor de E8
(dat is wat we in huis hebben), maar de architectuur is generiek:
protocol-laag en Homey-driver kennen geen enkel E8-specifiek ding,
alleen de productcatalogus per model is data die je erbij plugt —
zie "Uitbreiden naar andere modellen" hieronder.

> Deze app is niet gemaakt door, verbonden met, of goedgekeurd door
> Jura Elektroapparate AG. "Jura" is een merknaam van Jura Elektroapparate
> AG; deze app is een onafhankelijk, community-gedreven project.

**Bestaat dit al voor Homey?** Nee — op het Homey-forum wordt hier
sinds 2020 naar gevraagd (zie bv.
[deze topic](https://community.homey.app/t/j-o-e-app-van-jura-koffieapparaat/33873)),
zonder dat er ooit een werkende app kwam.

## Attributie

Dit is een JavaScript-port van het reverse-engineering-werk in het
Python-package **[`jura_connect`](https://pypi.org/project/jura-connect/)**
door **makefu** (`jura-connect-hass` op GitHub), zelf weer afgeleid van
de J.O.E. Android-app. Zonder dat werk was dit er niet — alle credits
voor het uitpluizen van het handshake-protocol, de cipher, en de
machine-XML-catalogus gaan daarheen. Deze repo is een port naar
Node.js/Homey, geen originele reverse-engineering. Beide projecten zijn
MIT-licensed (zie `LICENSE`).

## Ondersteunde modellen

| Model | EF-code(s) | Status |
|---|---|---|
| Jura E8 | `EF533`, `EF533V2` | ✅ **live geverifieerd** (art. 15336, hwId `EF538M V01.05`) — pairen, status, brewen |
| Jura E6 | `EF532`, `EF532V2` | data gebundeld, zelf niet getest (geen E6 in huis) |
| Jura S8 (EB) | `EF1091` | data gebundeld, meest live-geverifieerde profiel in de bronbibliotheek zelf |

Zie **`lib/profiles/README.md`** voor de exacte stappen om een nieuw
model toe te voegen — het protocol-fundament (`crypto.js`,
`protocol.js`, `discovery.js`, `juraClient.js`) hoeft daarvoor niet
aangepast te worden, alleen `lib/models.js` en een nieuw
`lib/profiles/<EF_CODE>.js`-bestand.

Tijdens pairing wordt het model automatisch herkend aan het
artikelnummer uit de discovery-reply. Herkent de app het artikelnummer
niet, dan toont de pair-flow een handmatige keuzelijst i.p.v. stilzwijgend
te gokken.

## Wat is al geverifieerd, wat niet

Alles hieronder is **geverifieerd tijdens het bouwen**, niet gegokt —
door de daadwerkelijke `jura_connect`-Python-package te installeren en
de JS-poort byte-voor-byte tegen de echte implementatie te testen, en
sinds v0.1.1 ook live tegen een fysieke machine:

| Onderdeel | Status |
|---|---|
| `lib/crypto.js` (cipher) | ✅ 88 testvectoren, byte-identiek aan Python, incl. alle edge cases |
| `lib/discovery.js` (UDP-discovery) | ✅ Synthetisch getest én live (vindt echte machines op het LAN) |
| `lib/profile.js` (recept-encoder, model-onafhankelijk) | ✅ Byte-exact tegen Python's encoder, voor meerdere modellen |
| `lib/profiles/EF533*.js`, `EF532*.js`, `EF1091.js` | ✅ Productdata komt letterlijk uit de J.O.E.-app zelf |
| `lib/protocol.js` + `lib/juraClient.js` (handshake/status/brew) | ✅ Mock-server, én live: pairen, status pollen en brewen werken tegen een echte Jura E8 |
| **Homey pair-flow** (`driver.js`, `pair/*.html`) | ✅ **Live geverifieerd** — zie "Bugs gevonden tijdens live testen" hieronder |
| **Alles tegen de echte machine** | ✅ **Live geverifieerd** — E8 (art. 15336, hwId `EF538M V01.05`), pairen + status + brewen (espresso) |

Nog niet live geverifieerd: de E6- en S8-profielen (`EF532*`, `EF1091`)
— die data is nog steeds "gebundeld, niet zelf getest" zoals in de
tabel hieronder, en het model-niet-herkend-pad (handmatige profielkeuze
tijdens pairing) is wél live bevestigd te werken, maar dan met een
E8-profiel gekozen.

### Bugs gevonden tijdens live testen (opgelost)

Puur protocol-giswerk was er niet meer, maar de Homey-pairflow zelf
bleek drie losse, elkaar maskerende bugs te bevatten — pas zichtbaar
zodra je 'm tegen een échte Homey en machine draait:

1. **Race condition in `start.html`**: `Homey.showView('connect')` werd
   aangeroepen vóórdat de `select_machine`-emit was bevestigd, waardoor
   de volgende view soms met een lege selectie laadde. Fix: navigeren
   pas in de `.then()` van de emit.
2. **Overbodige systeem-"Volgende"-knop**: `app.json`'s pair-view
   `start` had `"navigation": {"next": "connect"}` staan, wat Homey een
   eigen knop laat tonen die de custom rij-klik-handler volledig
   omzeilde (en zo de selectie leegliet). Verwijderd — deze pair-flow
   regelt navigatie zelf.
3. **`Homey.setNavigationCloseable` bestaat niet** in deze Homey
   CLI/runtime-versie (v4.4.1, software 13.4.0) en gooide een synchrone
   fout vóórdat de klik-handler ooit bij `Homey.emit()` kwam — leek van
   buitenaf alsof klikken niets deed. Fix: `typeof`-check eromheen.

Daarnaast, geen bugs maar netwerk-realiteit:

- **UDP-broadcast-discovery steekt niet over VLAN-grenzen**, ook niet
  met een firewall-*allow*-regel (dat is hoe L3-routing werkt, geen
  policy-ding). Toegevoegd: een **handmatige IP-invoer** in
  `start.html` als fallback voor cross-VLAN-setups.
- De machine wordt na een korte periode van inactiviteit **fysiek
  onbereikbaar** (auto-off/slaap) — de WiFi-module gaat dan volledig
  offline. `device.js` toont dan een leesbare "Machine appears to be
  off or unreachable" i.p.v. een rauwe socket-foutcode. Er is geen
  protocol-commando om de machine in die staat op afstand wakker te
  maken (zie "Bekende beperkingen").

## Setup

1. **WiFi Connect-module** moet al gekoppeld zijn aan je netwerk via de
   J.O.E.-app (dat is al het geval bij jullie).
2. `npm install` — **geen dependencies nodig**, alleen Node's ingebouwde
   `net`/`dgram`/`crypto`.
3. `homey app validate`
4. `homey app run` — vereist Docker. Draai je tegen een Homey Pro (of
   Self-Hosted Server) zonder Docker lokaal geïnstalleerd, gebruik dan
   `homey app run --remote`: dat bouwt en installeert de app direct op
   de Homey zelf, geen container nodig.
5. **Pair het device**: de app scant je netwerk (UDP-broadcast poort
   51515), toont het gedetecteerde model (of een handmatige keuzelijst
   als dat niet lukt), en dan moet je **op de machine zelf op OK
   drukken** binnen 60 seconden — exact zoals de J.O.E.-app dat ook
   doet. De auth-hash wordt opgeslagen; daarna hoeft dat niet meer.
   Staat Homey op een ander VLAN/subnet dan de machine? UDP-broadcast
   steekt daar niet overheen — gebruik dan het handmatige IP-veld
   onderaan het pair-scherm.

## Volgende stappen

- **E6- en S8-profielen live verifiëren** zodra die hardware
  beschikbaar is — nu nog "gebundelde data, ongetest".
- **Homey App Store-publicatie** is een apart traject: Athom's eigen
  review, strengere icoon-richtlijnen dan het huidige ontwerp, en een
  `author.email` in `app.json` (nu alleen een naam).
- Icoon (`assets/icon.svg`) is een eerste polish-slag, kan nog verder
  verfijnd worden.

## Structuur

```
app.json / app.js                    — manifest + flow-actie "brew_product"
lib/crypto.js                        — cipher (geverifieerd, model-onafhankelijk)
lib/protocol.js                      — TCP-framing + FrameReader
lib/discovery.js                     — UDP-discovery
lib/profile.js                       — recept-blob-encoder (model-onafhankelijk)
lib/models.js                        — model-registry: HIER voeg je een nieuw model toe
lib/profiles/EF533*.js, EF532*.js, EF1091.js  — gebundelde product-/alert-data per model
lib/profiles/README.md               — stap-voor-stap: nieuw model toevoegen
lib/juraClient.js                    — handshake/pair, status, brew
drivers/jura-machine/driver.js       — custom pair-flow (discovery + model-detectie/-keuze)
drivers/jura-machine/device.js       — polling, capabilities, brew-methode
drivers/jura-machine/pair/*.html     — pair-UI
drivers/jura-machine/assets/alarm_generic.svg — eigen icoon voor de alarm_generic-capability i.p.v. Homey's standaardbel
assets/icon.svg, assets/banner.svg   — bron-SVG's voor de app-iconen (small/large.png zijn hiervan gerenderd)
```

## Bekende beperkingen (bewuste scope-keuzes voor v0.1)

- Vijf profielen gebundeld (E8×2, E6×2, S8 EB) — niet de volledige
  88-apparaten-catalogus van de Python-lib. Uitbreiden is een kwestie
  van data toevoegen, zie `lib/profiles/README.md`.
- Geen maintenance counters / product-tellers / pmode-slots geport —
  wel aanwezig in de Python-lib, voor v0.1 bewust weggelaten.
- Machine kan niet op afstand **aan** gezet worden (het protocol heeft
  daar geen commando voor, alleen standby); `device.js` geeft dat
  duidelijk terug i.p.v. het stil te negeren.
