# Panel test kit — run this before every `vercel-app/index.html` push

Loads the **real** `vercel-app/index.html` in headless Chromium against a payload produced by the
**real** `apps-script/Code.gs`, and walks the vendor flows end to end. No hand-written fixtures: if
`Code.gs` and `index.html` drift apart, this catches it.

## Run

```bash
cd testkit
npm i playwright && npx playwright install chromium   # first time only
node _mkpayload.js      # runs Code.gs over demo-data/*.csv -> payload.json
node _apitest.js        # API: the dispute-claim contract across all three hops
node _resolvetest.js    # does an upheld resolution actually change what the trip pays?
node _flowtest.js       # does anyone have to type into Trip_Level to resolve a dispute?
node _uitest.js         # panel: drives a real browser
node _billtest.js       # MIS: runs Billing.gs vs an independent sum
```

PowerShell has no `&&` — run each line on its own:

```powershell
cd testkit
npm i playwright
npx playwright install chromium
node _mkpayload.js
node _apitest.js
node _uitest.js
node _billtest.js
node _resolvetest.js
node _flowtest.js
```

All three exit non-zero on any failure. Current state: **_apitest 22, _uitest 216, _billtest 30, _resolvetest 15, _flowtest 10 — all passing.**

## `_apitest.js` — the hop nothing else covers

A dispute claim has to survive **three** files, each naming its fields independently:

1. `vercel-app/index.html` `submitDispute()` builds the POST body
2. `vercel-app/api/action.js` copies the body into the queued Upstash action — **an explicit whitelist**
3. `apps-script/Actions.gs` `applyDispute()` writes the action into `Disputes_Log`

A field missing from hop 2 is dropped **silently**: the dispute still lands, the trip still flips to
Disputed, so it looks like it worked — the claim just arrives blank. That is exactly how
`claim_zonal_amount` and `claim_rfq_id` went missing after the zonal work, and neither `_uitest` (which
stops at the POST body) nor `_billtest` could see it.

| Area | Checks |
|---|---|
| Static contract | the `claim_*` field sets extracted from all three files must be **identical** — it names any field dropped or orphaned at either boundary |
| Live | actually invokes `api/action.js` with a stubbed Upstash and asserts the queued action carries `claim_zonal_amount = 5500` and `claim_rfq_id`, that a zonal claim never carries `claim_km` or `claim_aggregate_vehicle`, and that a local claim never carries a zonal amount |
| Gates | no category, no proof, and a trip belonging to another vendor are all still rejected |

**Any new `claim_*` field must be added in all three places.** This test is what tells you when it isn't.

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

## `_resolvetest.js` — does an upheld dispute actually change anything?

The subtlest failure in this system is a dispute that is raised, logged, resolved and reported to the
vendor as **Resolved** — over a trip that did not change. Two of those existed and neither was visible
from reading the code:

| Loop | The dead end | Now |
|---|---|---|
| Zonal Regular → Adhoc | the appliers ignored `resolved_billing_type` on zonal, yet still flipped the vendor to `Reconfirm` | a resolution writes **`billing_type_resolved`** (its own column — ground's `_final` is still ignored) and the trip pays `adhoc_amount` |
| Amount / KM on an RTO trip | `payable = rto ? 0 : …` is applied *before* any resolved value, so writing `zonal_rfq_amount_final` or `total_trip_km` on an RTO trip was a **no-op** | a value claim on an RTO trip carries `claim_challan_type`; `resolved_challan_type` writes `challan_type_final`, lifts the RTO, and the value comes back |

It runs the real `_classifyTrip` over the sheet state each resolution would produce, and asserts both
that the loop closes **and** that ground is still locked out — the case that caught sharing
`billing_type_final` and moving ₹4,800.

## `_flowtest.js` — nobody types into Trip_Level

Runs the real `applyResolutionsFromSheet()` against an in-memory sheet and **records every Trip_Level cell
it writes**, so "ops only ever edits Disputes_Log" is evidence rather than a claim. Covers a zonal
Regular→Adhoc flip, an RTO lifted on both scopes, a still-Open dispute that must stay untouched, and a
second run proving `resolved_at` makes it idempotent.

See `docs/DISPUTE_RESOLUTION_RUNBOOK.md` for the human-facing version of the same flow.
