# Panel test kit — run this before every push

Seventeen harnesses, **921 assertions**, all driving the **real** `Code.gs` / `Actions.gs` / `Billing.gs` /
`index.html` / `api/data.js` / `api/action.js` / `lib/core.js`. No hand-written fixtures anywhere: every number is produced by the real
code, and every expectation is either an independent re-derivation from `docs/ZONAL_LOCAL_SCHEMA.md` or a
comparison against the raw CSV. If any two files drift apart, one of these names the drift.

## Run

```bash
cd testkit
npm i playwright && npx playwright install chromium   # first time only
node _mkpayload.js      # runs Code.gs over demo-data/*.csv -> payload.json  (do this first)

node _matrixtest.js     # 12,960 classification combinations vs an independent spec oracle
node _paritytest.js     # the panel and the MIS cannot disagree
node _billtest.js       # MIS vs an independent CSV sum
node _guardtest.js      # every refusal path in Actions.gs
node _importtest.js     # the CSV resolution door, and its equivalence with the in-sheet door
node _datetest.js       # _toDate / _misInPeriod / _projFields — the quiet failure mode
node _rtotest.js        # the RTO resolution table
node _resolvetest.js    # does an upheld resolution change what the trip pays?
node _flowtest.js       # does anyone have to type into Trip_Level?
node _apitest.js        # the dispute-claim contract across all three hops
node _adminunsenttest.js # ADMIN: an untransferred trip is visible AND visibly marked
node _kmresolvetest.js  # does a RESOLVED km/amount actually reach the trip row and the bill?
node _resolveduitest.js # and does the panel still show it after the vendor accepts?
node _scheduledtest.js  # the scheduled run: does the Adhoc/RTO filter match anything at all?
node _pftest.js         # placement failure: deducted once, never twice
node _uitest.js         # panel: drives a real browser
```

PowerShell has no `&&` — run each line on its own:

```powershell
cd testkit
npm i playwright
npx playwright install chromium
node _mkpayload.js
node _matrixtest.js
node _paritytest.js
node _billtest.js
node _guardtest.js
node _importtest.js
node _datetest.js
node _rtotest.js
node _resolvetest.js
node _flowtest.js
node _apitest.js
node _pendingtest.js
node _adminunsenttest.js
node _uitest.js
```

Every harness exits non-zero on any failure.

| harness | checks | what it is for |
|---|---:|---|
| `_uitest.js` | 225 | the panel, in real Chromium |
| `_guardtest.js` | 81 | every refusal path in `Actions.gs` |
| `_rtotest.js` | 75 | the RTO resolution table |
| `_datetest.js` | 69 | dates — the failure mode that never shouts |
| `_importtest.js` | 87 | the CSV resolution door + door-equivalence + re-run contract |
| `_billtest.js` | 37 | the MIS vs an independent CSV sum |
| `_paritytest.js` | 35 | panel ↔ MIS parity |
| `_matrixtest.js` | 23 | the exhaustive classification matrix |
| `_apitest.js` | 22 | the `claim_*` contract across three files |
| `_resolvetest.js` | 21 | does an upheld resolution move money? |
| `_flowtest.js` | 13 | nobody types into `Trip_Level` |
| `_kmresolvetest.js` | 56 | a resolved KM / amount reaches the trip row and the bill |
| `_resolveduitest.js` | 26 | and the panel still shows it after the vendor accepts |
| `_scheduledtest.js` | 64 | the 14:30/18:30/22:30/03:30 run, and what it holds back |
| `_pftest.js` | 53 | placement failure becomes a deduction, charged once |
| `_pendingtest.js` | 16 | a vendor's confirm survives a reload before the sync runs |
| `_adminunsenttest.js` | 16 | admin sees untransferred trips, and can tell them apart |
| **total** | **921** | |

---

## `_matrixtest.js` — the exhaustive classification matrix

`_classifyTrip()` decides what every trip pays, and **both** the panel and the MIS call it, so a bug here
is a bug in both, silently and identically. This walks the **full cross product** of the eight fields
that can influence the answer —

```
route_scope(5) × billing_type_system(3) × billing_type_final(3) × billing_type_resolved(3)
  × challan_type(4) × challan_type_final(4) × total_trip_km(2) × km_accumulated_flag(3)
  = 12,960 combinations
```

— and compares each one against an **independent oracle** written from `docs/ZONAL_LOCAL_SCHEMA.md`
(§2 amount matrix, §3 classifier, §4c precedence) rather than from the code. When the code and the spec
disagree, it names the exact combination.

It also asserts that all eight outcome shapes are actually reached (Local/Zonal × Regular/Adhoc × RTO),
so the matrix cannot pass by never exercising a branch.

## `_paritytest.js` — the panel and the MIS cannot disagree

The vendor sees numbers from `_buildVendorPayload`. Finance pays numbers from `buildBillingModel`. The
whole design rests on those being incapable of disagreeing, and **nothing asserted it** until this file.
Per local contract, per RFQ, and in total: `regKm`, adhoc money, zonal money, trip counts, and both grand
totals. Plus: every trip the vendor sees is on some MIS tab, the MIS bills no trip the vendor was never
shown, and no trip appears twice on either side.

**This is the harness that found the ₹17,000 double-bill** (see `docs/DECISIONS.md`, 2026-08-11): all 11
zonal trips were landing in the MIS Other-Adhoc orphan bucket *as well as* the Zonal tab, because a zonal
row has a blank `contract_id` by design and `_misReadSource()` had no zonal filter where `Code.gs` did.

## `_billtest.js` — the MIS side

| Area | Checks |
|---|---|
| Zonal survives a blank contract_id | zonal is still read, nothing is orphaned (vendor comes from `transporter_oracle_id`) |
| No leakage | no zonal trip and no zonal field reaches a local contract record — no slab, vehicle row or utilisation % is touched |
| Per-RFQ lines | zonal groups into one line per `rfq_id`; the lines sum exactly to the Zonal subtotal |
| Independent zonal cross-check | every RFQ line and the zonal total are compared against a hand-rolled sum read straight off the CSV |
| **Independent adhoc cross-check** | `totals.adhoc` and the Other-Adhoc bucket are each summed independently off the CSV, and no zonal row may appear in `d.trips`, `d.orphans` or the bucket. **Added 2026-08-11** — the old check was `payable === fixed+excess+adhoc+zonal`, which is vacuous (every term comes from the same object) and held happily while ₹17,000 was billed twice |
| No double count | `payable` is compared against an independently summed payable, and asserted **not** to be the ₹548,250 the double-bill produced |
| The blank-RFQ gate | blanks an `rfq_id` at runtime and asserts the gate flips to `WARN`, that the message names the problem, that the trip still gets a visible `(no RFQ id)` line, and that the money does not move |

## `_guardtest.js` — every refusal path

The other harnesses test what happens when things go right. These are the paths that fire when they go
wrong, and they are the ones protecting the money. Every case runs the **real** function against an
in-memory sheet with a frozen clock.

| Area | Checks |
|---|---|
| `transferReadyTrips` — the ground window | a trip inside its window does not transfer but its derived `ground_review_deadline` **is** persisted; no `trip_end_time` means no transfer and no invented deadline; an already-flagged trip is skipped, not logged twice; an engine-set future deadline is respected even when `trip_end_time` is old |
| — the transfer itself | opens `dispute_window_end`, defaults `vendor_status = Pending`, stamps `sent_to_vendor_timestamp`, and writes `Ground_Confirmation_Log` **before** the flag so a log failure is retryable |
| — `ZONAL_NOT_EDITABLE` | a ground `billing_type_final` / `replaced_default_vehicle_final` on a zonal trip is cleared, the log names the **RFQ** (there is no contract_id), the row is flagged partial, and **the trip still transfers** — the edit is dropped, not the trip. Also asserts zonal is exempt from the reclassification guard, which would otherwise bounce every zonal trip |
| — the hand-typed `billing_type_resolved` clear | cleared on **both** scopes, logged, flagged — and asserted to matter, since that column outranks everything and would otherwise let someone pay a trip ₹9,999 by typing in a cell |
| — incomplete reclassification | a `Regular` edit on a non-default vehicle with no valid mapping is discarded and flagged `NEEDS_ATTRIBUTION_FIX`, with the message naming the contract the vehicle **actually** belongs to; a complete mapping is kept; `Regular` on an `ADHOC-` bucket is an attribution problem, not a billing one |
| `applyConfirm` | ownership (another vendor's trip is not touched and not even logged), locking (Confirmed / Disputed / Reconfirmed are inert), `Reconfirm → Reconfirmed`, zonal logs its RFQ as the reference, unknown ids and a blank oracle write nothing |
| `applyDispute` | ownership, locking, **the closed window throws** and writes nothing, a blank window is *open* not *closed*, and a `Reconfirm` trip can be re-disputed even though its window closed |
| the dispute row | `claim_zonal_amount` / `claim_rfq_id` / `claim_challan_type` all land; the originals are snapshotted so ops sees was-vs-claimed; an unfilled claim stays **blank**, it does not become `0` |

## `_importtest.js` — the CSV door, and door-equivalence

There are **two** ways a resolution reaches `Trip_Level`: the in-sheet applier (`_flowtest`) and the CSV
importer. They write the same columns, so a divergence would mean the same resolution pays differently
depending on how ops submitted it. Nothing tested the CSV path at all.

| Area | Checks |
|---|---|
| the header contract | empty / header-only / no-`dispute_id` CSVs are refused **and write nothing**; a header with stray spaces and mixed case still matches, because ops exports from Excel |
| unmatched rows | reported and **named** in the return message, never invented; a blank id is skipped |
| blank = unchanged | §G16: a blank `resolved_*` leaves the cell alone, but the trip still moves to `Reconfirm` and `resolved_at` is stamped |
| zonal | `resolved_km` and `resolved_aggregate_vehicle` are ignored *and said so*; `resolved_zonal_amount` applies; `resolved_rfq_id` corrects the reference; `resolved_contract_id` is **not** written to a zonal row |
| the refusal | a flip to Adhoc with a blank `adhoc_amount` and no `resolved_amount` is refused, and the trip keeps paying its ₹5,300 instead of dropping to ₹0. The same flip **with** an amount is accepted, writes `billing_type_resolved` (never `_final`), and pays ₹6,100 |
| the RTO lever | `resolved_challan_type` writes `challan_type_final` on **both** scopes |
| **equivalence** | six scenarios run through *both* doors, and the entire `Trip_Level` snapshot must be byte-identical, with the same payable, billing type, RTO state and slab treatment |
| idempotency | `resolved_at` makes the in-sheet applier inert on a second run (safe on a timer); an `Open` row is never applied, even with `resolved_km` already filled |

## `_datetest.js` — the quiet failure mode

Nothing in this system shouts when a date is wrong: `_toDate` returns `null`, the period gate opens
instead of closing, the projection divides by a 235-day window instead of a 31-day one, and every number
downstream is plausible and wrong.

**This harness found the root cause of the two live date findings — they are one bug wearing two faces.**
If ops types the Indian format as text, JS reads `dd-mm-yyyy` as `mm-dd-yyyy` whenever the day is ≤ 12:

- `"01-08-2026"` (1 August) parses **silently as 8 January** → the live `contract_start_date` of `2026-01-08`
- `"31-08-2026"` has no valid month to map to, so it returns **null** → the live unreadable `contract_end_date`

The boundary is the 12th: `dd ≤ 12` parses **wrongly**, `dd > 12` fails **loudly**. Never store dates as
text. The file also pins `_misInPeriod` (fail-open on an unreadable date so a trip is never silently
dropped, inclusive boundaries, `trip_end_time` fallback) and `_projFields` (the exact midpoint arithmetic,
the OVER/UNDER 2%/10% thresholds, a zero slab, a zero-KM contract, and a contract that has not started).

## `_rtotest.js` — the RTO resolution table

Was print-only, so it could never fail. Now 75 assertions covering the payable outcome of every
resolution lever on all four scope × billing combinations, including six statements of the **ONE RTO
RULE**: no `resolved_*` value pays an RTO trip. `resolved_challan_type` is the only lever, because
`payable = rto ? 0 : …` is applied first.

Two facts worth knowing before resolving one:

- On **LOCAL REGULAR**, lifting the RTO alone earns the vendor nothing — the KM is still 0, so
  `resolved_km` is required too. On the other three combinations the amount is already on the row, so
  `resolved_challan_type` alone is enough.
- The trap: the test is `startsWith('rto')`, not `contains`. `"RTO cancelled"` still reads as an RTO and
  still pays ₹0. `"Not RTO"` and `"Forward Only"` are safe.

It also asserts the vendor-facing shape: the RTO claim rides on the existing **"Wrong KM / Amount"**
reason rather than a category called "Not an RTO Trip", and `claim_challan_type` survives all three hops.

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

## `_uitest.js` — the panel

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
| Per-trip reference | the `Contract / RFQ ID` column shows each trip's **own** reference — never the bucket card's name — matches `t.ref` from the payload row for row, tints zonal teal, and is present on every panel whose trips span more than one reference |

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

## Adding a case

`_mkpayload.js` clones a few edge shapes the demo CSVs do not contain (Local Adhoc RTO, a zonal trip with
a blank `rfq_id`, a zonal trip with `km` and `amt` deleted entirely — the exact shape that printed
`Current KM: null km`). Add new shapes there; `_uitest.js` discovers trip kinds from the payload, so a new
kind is picked up automatically.

For a new **rule**, prefer `_matrixtest.js`: add the field to its axes and the rule to its `ORACLE()`, and
all 12,960 combinations re-check themselves.

## What is still not covered

Stated plainly, so it is a known gap rather than a blind spot:

- **`syncToUpstash` / `/api/data`** — the snapshot hop is exercised only through a stub. A sync that
  silently pushes a stale or truncated payload would not be caught here.
- **Google Sheets I/O itself** — `_readTab` and `_setCell` are replaced by in-memory equivalents in every
  harness, so a real range/permission/quota error is out of scope.
- **The Apps Script menu wrappers** (`syncNowFromMenu`, `drainAndSyncFromMenu`, `importResolvedDisputes`'s
  Drive fetch) — the UI prompt layer is stubbed; the functions they call are all covered.
- **Live master data.** These harnesses run on `demo-data/`. They prove the *code* is right; they cannot
  prove the *sheet* is. `docs/SANITY_CHECK_CONTRACTS_2026-08.md` is the live-data counterpart, and its
  five findings are still open.

## `_adminunsenttest.js` — the admin view must show what the vendor cannot

`_buildAdminPayload()` uses `allTrips: true`, so trips with `sent_to_vendor_flag != Yes` are included **on
purpose** — an admin needs to see the transfer backlog. But `vendor_status` reads `Pending` for those trips
exactly as it does for a trip the vendor can already act on, so until `sent` was carried into the payload
the two were pixel-identical and the backlog looked missing.

| Area | Checks |
|---|---|
| the payload | every admin trip carries a boolean `sent`; at least one is `false`; an untransferred trip still reports `status: 'pending'` — which is *why* the chip is needed |
| the header | names the backlog, and the number matches the payload exactly |
| the row | the amber "Not yet sent to vendor" chip renders on the right trip, with a tooltip naming `sent_to_vendor_flag` |
| the reverse direction | **no chip and no backlog line can ever reach a vendor** — asserted both from the DOM and from the payload (every vendor trip is `sent === true`) |
| logout | returns to the login screen and leaves no panel on screen. Also **records** that `logoutFn()` does not `location.reload()`, so 14 rows stay in the DOM — a future fix will surface here as a failure |

Runs the real `index.html` in Chromium against a real `_buildAdminPayload()`. If `sent` goes missing from
`Code.gs` the harness says so in words rather than crashing on an empty array.


## `_kmresolvetest.js` — a resolved KM / amount must reach the trip row and the bill

Added 27 Aug 2026, after finding that **166 of 166 resolved disputes on the live sheet had never reached
`Trip_Level`** — 1,974.216 km. `resolved_at` was the permanent "already applied" guard and it was stamped
at the top of the applier's loop, *before* any `resolved_*` value was read, so *mark Resolved → timer
fires → type the number* lost the number for good. Full account in
`docs/FIX_LOST_RESOLUTIONS_2026-08-27.md`.

What it pins:

- **Precedence with an explicit blank test, not `||`.** A dispute resolved to **0 km** is a real outcome
  and must not fall through to the system value — a `_num(a) || _num(b)` chain gets that wrong, and §1
  fails if anyone reintroduces one. Blank must still mean blank.
- **The system column is never written.** `total_trip_km` / `adhoc_amount` stay as the engine left them,
  so the original is auditable and a re-push of `Trip_Level` cannot revert a correction.
- **The exact live sequence**, replayed on the real dispute row: note-only first pass, `resolved_km`
  typed after the stamp, vendor already accepted. The late value must land, be reported as
  `RECONCILED`, and must NOT reopen the trip or re-notify the vendor. A third pass writes nothing.
- **`repairMissedResolutions()`** — dry run writes nothing, apply is idempotent, the `row_id` fallback
  finds the one live dispute whose `trip_id` holds the row_id, `vendor_status` is never touched, an Open
  dispute is never repaired, `resolved_km` stays ignored on zonal, and a **missing column is named** (via
  a `HIDE_TL_COLS` hook that removes it from the fake header) rather than silently no-op'ing.
- **`_sameCell()`** directly. The first cut of the idempotent write helper compared `_num()` on anything
  containing a digit, so `RJK7-X` and `RJK10-Y` both reduced to `0` and a `contract_id` correction was
  skipped as "already correct". §4 exists because `_importtest`'s door-parity check caught that.
- **The ONE RTO RULE still wins.** A resolved KM on a still-RTO trip contributes nothing; it takes both
  levers — `resolved_challan_type` *and* `resolved_km` — in one resolution.
- **Non-vacuity** (§6): reverts the classifier to `total_trip_km` only and asserts this harness fails;
  then simulates the old `resolved_at` gate and asserts the resolution is lost, i.e. the bug reproduces.

## `_resolveduitest.js` — and the panel must still show it after the vendor accepts

The data loss was invisible because of two panel defects, both driven here in real Chromium:

- The KM cell rendered `t.km` alone, so a corrected trip looked identical to an uncorrected one. It now
  carries a **"revised from 167.074 km"** chip off the new `kmWas` / `amtWas` payload field.
- **"View dispute" was gated on `status==='disputed'||'reconfirm'`.** The Resolution block in that dialog
  reads `resolved_km` live from `Disputes_Log` and was the *only* place the panel ever showed it — so it
  vanished at the exact moment the vendor pressed Accept. That is what made an accepted correction read
  as a revert. The link now shows whenever the trip has a dispute, and says "View resolution" once
  settled.

§2b also pins that a `reconfirm` trip is **not bulk-selectable** — the row checkbox renders only for
`status==='pending'`. This matters because `/api/action`'s `ACTIONABLE` map *does* accept `reconfirm`
inside a bulk confirm, so that render gate is the only thing preventing a bulk accept of resolutions no
one reviewed. §4 restores both old renderers and proves the bug reproduces.

## A test can encode a bug as a guarantee

`_importtest.js` section 7 used to assert *"a stamped row is skipped forever (safe on a timer)"*. That is
an accurate description of the defect, written as a promise, and it passed for weeks. It has been
rewritten to the new contract, with the old sequence kept as an explicit non-vacuity probe.

**When a fix requires deleting an assertion, that assertion is the thing to read hardest.**


## `_scheduledtest.js` — the scheduled run, and the filter that matched nothing

Added 27 Aug 2026 with the 14:30 / 18:30 / 22:30 / 03:30 IST job. It exists for one reason: **a filter
that matches nothing looks exactly like a filter that works.**

The requested rule was `challan_type = 'RTO Only'`. The live sheet stores **`RTO only`** with a
lowercase o on 145 rows — a case-sensitive test matches **0 of 3,911**. §5 builds the filter exactly as
worded and asserts that every Adhoc and RTO trip is sent to the vendor anyway. That assertion is the
whole point of the file.

What else it pins:

- **The exact live strings.** `RTO only`, `RTO`, `rto only` and `RTO cancelled` are held;
  **`Forward + RTO` (1,805 rows) is not** — the classifier does not treat those as RTO and they carry
  payable KM. Blank challan is not assumed to be RTO.
- **OR, not AND.** 451 rows held, not the 13 in the intersection. §5 measures the AND variant too.
- **A held trip is untouched.** Not one cell written, no `Ground_Confirmation_Log` row. That is what
  makes "release it later with menu 4" true rather than hopeful.
- **Menu 4 stays unfiltered.** `transferReadyTrips()` with no args, and with `{}`, transfers
  everything — including trips the scheduled run held on the previous line. If this ever fails, a held
  trip can never be sent at all.
- **Held trips stay eligible run after run**, and the count keeps being reported so the backlog cannot
  go silent.
- **Four triggers at 03:30 / 14:30 / 18:30 / 22:30**, daily, minute 30.
- **The timezone refusal.** Clock triggers fire in the Apps Script PROJECT timezone, not the
  spreadsheet's — the test sets the spreadsheet to IST and the project to `America/Los_Angeles`, which
  is exactly how this goes wrong silently, and asserts the installer refuses and names the fix.
- **Two-way mutual exclusion** with the 10-minute auto-apply, which transfers unfiltered and would
  undo the filter within ten minutes.
- **A failing step does not cost the sync.** With `drainActions` throwing, the report names it and the
  Upstash push still happens, so the panel does not go stale behind one bug.

Its trigger service is a fake that records what *would* be installed — hours, minutes, handler names —
so the schedule itself is asserted rather than eyeballed in the Apps Script UI.


## `_pftest.js` — placement failure is deducted once, never twice

Added 4 Sep 2026 with the `Placement Failure` tab. The decision it protects: the deduction **is** the
pro-rating, made visible. `active_days` and `monthly_rate` stay whole and this line is the only
reduction. Full account in `docs/PLACEMENT_FAILURE_2026-09-04.md`.

**§5 is the reason the file exists.** On Bharat's five real failures it asserts three things together:
the deduction gives ₹45,000; trimming the masters to the 25 honoured vehicle-days gives the *same*
₹45,000; and doing both would pay **₹36,000 against ₹45,000 owed**. So exactly one of the two may ever
be applied, and if someone later also trims `active_days`, this section fails.

It also caught a mistake in its own first draft: I asserted the net was "10 of 15 days" when the
contract is 2 vehicles × 15 days = **25 of 30 vehicle-days**. The code was right and the expectation
was wrong. The unit is the vehicle-day, and that only shows up on a multi-vehicle contract.

What else it pins:

- **The day rate is not a new number.** `monthly_rate / active_days` equals `tier / 30` on live
  figures (27,000/15 = 54,000/30 = 1,800). Both routes, same rupee — so there was never a basis to
  argue about.
- **`hours_slab` is required**, with the real case: oracle 19434 has a 12hr and a 24hr 7 FT contract
  on the same dates, both with 1,500 km vehicles, at ₹1,566.67 and ₹2,533.33 a day. A blank
  `hours_slab` is refused rather than guessed.
- **The string forms LH actually type** — `7FT`, `7 ft`, `  7 FT  ` all join to `7 FT`. The masters
  and the input agree on nothing as raw strings.
- **The date rule.** `dd-mm-yyyy` text is refused with a message naming the format, and the test
  demonstrates *why* by showing `_toDate('05-08-2026')` really does come back as **May**. Real date
  cells and `yyyy-mm-dd` are accepted. Third incident from this one format.
- **All three BLOCK gates**, each asserted to name its numbers: the unpriceable row (with its sheet
  row number), the duplicate paste (pointing at `vehicles_failed`), and the cap (40 failed vs 30
  available).
- **A missing tab deducts nothing and blocks nothing**, so billing keeps working before the tab is
  created.
- **Inconsistent masters are refused, not averaged** — two rates on one slab has no single day rate.
