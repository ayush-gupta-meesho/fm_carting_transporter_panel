# Panel test kit — run this before every `vercel-app/index.html` push

Loads the **real** `vercel-app/index.html` in headless Chromium against a payload produced by the
**real** `apps-script/Code.gs`, and walks the vendor flows end to end. No hand-written fixtures: if
`Code.gs` and `index.html` drift apart, this catches it.

## Run

```bash
cd testkit
npm i playwright && npx playwright install chromium   # first time only
node _mkpayload.js      # runs Code.gs over demo-data/*.csv -> payload.json
node _uitest.js         # panel: drives a real browser
node _billtest.js       # MIS: runs Billing.gs vs an independent sum
```

Both exit non-zero on any failure. Current state: **_uitest 207 assertions, _billtest 22 assertions,
all passing.**

## What it asserts

| Area | Checks |
|---|---|
| L1 cards | every card name is unique; no internal `ZONAL::` id leaks |
| L2 | every card opens and renders with no `null` / `undefined` / `NaN` on screen |
| Dispute modal | opened for **every** trip kind — Local Regular / Local Adhoc / Local Adhoc RTO / Zonal Regular / Zonal Regular RTO / Zonal Adhoc / Zonal Adhoc RTO / zonal with no RFQ id / zonal with `km` and `amt` absent |
| Dispute claims | the posted `/api/action` body is checked field-by-field against what `Actions.gs applyDispute()` reads: zonal must send `claim_zonal_amount` + `claim_rfq_id` and must never send `claim_km` or `claim_aggregate_vehicle` |
| Validation | empty category, empty amount, non-numeric amount and missing callback number are all still blocked |
| View dispute | a local and a zonal dispute (open and resolved) render with their real categories |
| Confirm | single confirm and bulk confirm both post from a zonal card |
| Action reachability | at 1920 / 1600 / 1440 / 1280 / 1152px, the Action header **and** the Confirm button must be on screen with the scroller at `scrollLeft = 0`. This is the check that would have caught the buttons being pushed off the right edge |
| Dispute window | Confirm appears for every pending trip; Raise Dispute for exactly those whose `winTs` is still open; "Dispute window closed" for exactly the rest; never both and never neither on one row |
| Layout | the trip table sits in a `.tscroll` scroller and the page itself never scrolls sideways |
| CSV | `downloadCSV()` builds and carries the Route Scope column |
| Zonal identity | every zonal row in `demo-data/Trip_Level.csv` has a **blank `contract_id`**, matching production. Asserts cards are keyed `ZONAL::<rfq_id>`, one per RFQ, no duplicates, no internal id leaks, and no separate contract-id field in the dispute modal |
| Per-trip reference | the `Contract / RFQ ID` column shows each trip's **own** reference — never the bucket card's name — matches `t.ref` from the payload row for row, tints zonal teal, and is present on every panel whose trips span more than one reference. Header and body cell counts are checked to agree on both a local and an all-zonal panel |

## `_billtest.js` — the MIS side

| Area | Checks |
|---|---|
| Zonal survives a blank contract_id | zonal is still read, nothing is orphaned (vendor comes from `transporter_oracle_id`) |
| No leakage | no zonal trip and no zonal field reaches a local contract record — no slab, vehicle row or utilisation % is touched |
| Per-RFQ lines | zonal groups into one line per `rfq_id`; the lines sum exactly to the Zonal subtotal |
| Independent cross-check | every RFQ line and the zonal total are compared against a hand-rolled sum read straight off the CSV, so a bug in `Billing.gs` cannot hide behind itself |
| No double count | `payable = fixed + excess + adhoc + zonal`, with zonal counted once |
| The blank-RFQ gate | blanks an `rfq_id` at runtime and asserts the gate flips to `WARN`, that the message names the problem, that the trip still gets a visible `(no RFQ id)` line, and that the money does not move |


## Adding a case

`_mkpayload.js` clones a few edge shapes the demo CSVs do not contain (Local Adhoc RTO, a zonal trip
with a blank `rfq_id`, a zonal trip with `km` and `amt` deleted entirely — the exact shape that printed
`Current KM: null km`). Add new shapes there; `_uitest.js` discovers trip kinds from the payload, so a
new kind is picked up automatically.
