# Resolved product decisions (Stage 1)

Answers to the build-plan open items (§F, §H), and how the panel implements them.

## Adhoc visibility (build-plan §F)
- **Show `adhoc_amount` only for Adhoc trips, keyed on the FINAL billing type** (ground can change Regular↔Adhoc).
  → Implemented: billing is `billing_type_final || billing_type_system`; the amount renders only when final = Adhoc.
- **Pre- vs post-transfer:** N/A for the vendor panel. Vendors only ever see trips after `sent_to_vendor_flag = Yes`,
  so the final billing type + amount are already locked before the trip is visible.
- **Show the tag only, not the reason.** `adhoc_reason_system` is internal.
  → Implemented: the panel shows the "Adhoc" badge only; the reason is never rendered.

## Adhoc amount source (§H Q4)
- **Real rate card, computed in the data engine.** The engine writes a per-trip `adhoc_amount` directly.
  → The panel does no derivation — it displays `adhoc_amount` as-is. (Seed data uses illustrative numbers.)

## Multi-cluster vendor (§H Q7)
- **Aggregate across clusters, with the option to filter to one cluster.**
  → L1 shows all of the vendor's contracts across clusters; the header counts all clusters; the **Cluster filter**
    (now populated dynamically from the vendor's actual clusters) lets them narrow to one. Global MIS additionally
    has a Contract filter.

## UI fixes made alongside these decisions
- **Dynamic L1 filters:** Cluster / Vehicle Size / Hours dropdowns are now built from the vendor's real contracts
  (previously hardcoded to Surat/Ahmedabad/7ft… which would hide Rajkot, Morbi, etc.).
- **Filter reset on contract open:** opening a contract resets its Trip-MIS Billing/Vehicle/Show filters and the
  Vehicle-Level type filter to "All", so a selection (e.g. Vehicle = V1) no longer leaks across contracts.

## Deferred by scope (not gaps)
- Confirm / bulk-confirm, dispute capture, admin CSV resolution, reconfirmation, monthly archive (build-plan C4–C7).
- CSV download inside the Apps Script iframe may be blocked by the sandbox; it works on the Vercel deploy (to be verified there).

## Ownership: data engine vs Apps Script (confirmed)
- **Data engine** = static facts only. On trip completion it writes the `Trip_Level` row (ids, oracle, contract, vehicle, `total_trip_km`, billing classification, `trip_end_time`) and **leaves `sent_to_vendor_flag` blank**. It does not run any workflow.
- **Apps Script** = all workflow. The cycle (menu 4 manual, menu 6 auto) runs **transfer → drain vendor actions → sync**:
  - `transferReadyTrips()` derives `ground_review_deadline` (= `trip_end_time + GROUND_WINDOW_HOURS`, default 24h), and once past it: writes `Ground_Confirmation_Log`, opens the vendor dispute window (`dispute_window_end = now + DISPUTE_WINDOW_DAYS`, default 15), sets `vendor_status = Pending`, flips `sent_to_vendor_flag = Yes`.
  - `drainActions()` applies vendor confirm/dispute; the resolved-CSV import handles admin resolution → reconfirmation.
- Config knobs at the top of `Actions.gs`: `GROUND_WINDOW_HOURS`, `DISPUTE_WINDOW_DAYS`.

## Month-end billing — SUPERSEDED 2026-08-06: now built here
~~Billing is computed in a separate sheet, not in this panel. Not built here.~~

Billing **is** now built in this project, in `apps-script/Billing.gs`, writing into a separate MIS
spreadsheet. Two things changed from the note above:

- **The formula gained two zonal terms** and uses the grouped slab:
  `fixed_monthly_value + max(0, Σ local Regular non-RTO KM − grouped_km_slab) × ex_km_rate
   + Σ local adhoc_amount + Σ zonal rfq_rate + Σ zonal adhoc_amount`
- **Settled-only was reversed.** Pending trips ARE billable (see below), so billing no longer filters on
  `Confirmation_Status_View`.

Full spec: `docs/BILLING_MIS_SPEC.md`.

## Date filter removed
The Trip-MIS and Vehicle-Level "Date" dropdowns were non-functional placeholders from the v5 mock and have been removed from both panels. (The contract *duration* in the L2 header is still shown from `Contract_Info`.)


# ───────────────────────────── Billing MIS decisions (2026-08-06) ─────────────────────────────

## Where the MIS is computed
- **One classifier, in the parent Apps Script project.** `_classifyTrip(trip, defSet, defaultBilling)` in
  `Code.gs` is the single source of truth for billing type, RTO, default-vs-replacement, fold target and
  settled status. `_buildVendorPayload` (the panel) and `Billing.gs` (the MIS) both call it.
  → Rationale: the MIS must match the Vercel panel exactly. Shared code makes that structural, not a hope.
- **The MIS spreadsheet holds no script.** `Billing.gs` reaches it via `SpreadsheetApp.openById()`.
- **Rejected:** formulas/script inside the MIS sheet (two copies of four rules = guaranteed drift);
  an Apps Script Library (version-pinning friction for a single maintainer); rebuilding billing from the
  Upstash payload (it is UI-shaped and lossy — `km` null on Adhoc, `amt` null on Regular, RTO distance
  discarded, no `fixed_monthly_value`). The payload is still used as a parity CHECK.
- **Generate button sits in the parent sheet's VALMO Panel menu**, not the MIS sheet — generation is an
  admin act; ops and finance are readers.

## Billing mechanics
- **Excess at grouped-contract level, never per vehicle.** A vehicle over its own pegged slab creates no
  charge while the contract total is inside the contract slab. The vehicle breakdown is presentational.
- **Pending trips are billable**, flagged separately on Summary. `Reconfirm` = not settled;
  `Reconfirmed` = settled.
- **`trip_date` decides the period** — a trip ending next month still bills to this one. But the date is
  used to FLAG, never to drop: `contract_id` scopes the bill and the panel applies no date filter, so
  excluding a trip on a date test would silently break parity. Out-of-window trips are billed and listed
  in Exceptions block E.
- **A new `contract_id` is issued each month**; roll-up is by `contract_id`.
- **`ADHOC-<oracle>` / Other-Adhoc appears as its own line** in the MIS.
- **`ORC-4521` is excluded by hardcoded oracle id** in the MIS only. It stays visible on the admin panel.
- **Zonal `rfq_rate` is the payable amount** for the trip — no multiplication. Zonal KM never enters any
  slab. The Zonal tab is a manual paste area today, read by header name and filtered by
  `transporter_oracle_id`, so it needs no change when `route_scope` / `zonal_amount` reach `Trip_Level`.
- **Pro-ration stays manual** in `Contract_Vehicles` (`monthly_rate` / `active_days`). No system-side
  pro-ration. Consequence: a vehicle that ran zonal work still carries its full local `pegged_km_slab`.
- **Run-rate projection is on** — per vehicle on its own active period, per contract on the contract period.

## Gates — nothing is issued until BLOCK gates are clear
BLOCK: `Contract_Vehicles` row count = `no_of_vehicles`; `Σ pegged_km_slab` = `total_km_slab`;
`Σ monthly_rate` = `fixed_monthly_value`; no duplicate/blank `(contract_id, vehicle_number)`; at least one
Active contract in the period.
WARN: unattributed KM; look-alike plates; cross-contract plates; trip_date outside the contract window.
- **Rationale for the two sum gates:** a contract is a culmination of `Contract_Vehicles` AND
  `Contract_Info` (`ex_km_rate` lives only in `Contract_Info`), so the two must agree before anyone bills.
  The panel silently prefers the `Contract_Vehicles` sum today, which hides the disagreement.

## Unattributed KM
- A Regular non-RTO trip's KM enters the **contract** total whether or not its vehicle is a default, so
  unmapped replacement KM is a **reporting** hole, not a money hole. The MIS shows it as an explicit
  `UNATTRIBUTED — in slab, no vehicle mapped` line so the vehicle breakdown always foots to the contract
  total. Never silently dropped.

## Plate look-alikes — report, never auto-correct (reaffirms the earlier no-normalisation decision)
- Two distinct populations: **cross-contract** (the plate is a genuine default of a DIFFERENT contract →
  KM on the wrong contract and wrong slab; this is engine attribution) and **look-alike** (typo-shaped,
  within edit distance 2, not a default anywhere → KM in the right contract, possibly the wrong vehicle).
- **No auto-correction, ever.** `RJK10-18838` holds four pairs of GENUINE defaults within edit distance 2
  of each other (`GJ03CU0690`/`GJ03CU0907`, `GJ03CU0907`/`GJ03CU3905`, `GJ33T4580`/`GJ33T4620`,
  `GJ33T4580`/`GJ33T4788`), and on `RJK10-20077` both `GJ03CU1556` and `GJ03CU2156` are real defaults two
  characters apart. A fuzzy rule would move real KM onto the wrong real vehicle. Whitespace, case and
  0-vs-O were separately ruled out, so normalisation would fix a problem that does not exist.
- Ground corrects the plate at source; the long-term fix is constraining trip creation to the
  vendor-submitted vehicle master.

## One deliberate behaviour change in `Code.gs`
- The Other-Adhoc bucket now applies the `km_accumulated_flag` RTO fallback that the main path always had.
  Affects 0 rows today (the clause only fires on a Regular trip; the bucket holds only Adhoc ones).
  Unified rather than left divergent, so the MIS and the panel cannot disagree later.

## Vendor-facing MIS pack (menu 12) — added 2026-08-06
- **Vendors never receive the working MIS sheet.** `Cost_View_All` carries every other vendor's
  `ex_km_rate`, `fixed_monthly_value` and payable; `Validation_Gates` and `Exceptions` carry internal
  data-quality findings. Downloading the working sheet as .xlsx and sending it would leak all of it.
- **`issueVendorPackFromMenu()` builds a separate, clean spreadsheet per vendor**, rendered fresh from
  the model — NOT by copying the working sheet and deleting tabs. Strip-what-you-remember is how an
  internal row eventually reaches a vendor. The pack function never reads the internal tabs at all.
- **Pack contents:** `Billing Summary` (per-contract payable + total + plain-English method notes),
  `Vehicle Wise KM` (V#, plate, active period, days, contracted KM, KM run, used %, trips),
  `Trip Details` (every trip, date-sorted), `Zonal Trips` (only when zonal rows exist).
- **Deliberately withheld from the pack:** `adhoc_reason_system` (reaffirms the earlier internal-only
  decision), projection / sizing signals, the gate table, the Zonal paste area and its instructions,
  and any other vendor's rows.
- **Delivery:** open the pack, then File → Download → Microsoft Excel (.xlsx).
- The pack builds straight from the source sheet, so it does **not** require the MIS sheet to have been
  generated for that vendor first.

## Menu 11 archive must not use the Drive service — 2026-08-06
`archiveCurrentMisFromMenu()` uses `SpreadsheetApp.create` + `Sheet.copyTo`, never `DriveApp.makeCopy`.
Drive adds a new OAuth scope, and any scope change stops the simple `onOpen()` trigger firing until the
user re-authorises — which presents as "the VALMO Panel menu will not update". This cost us a debugging
cycle on 2026-08-06. Do not reintroduce the Drive service into this project without expecting that.

## Zonal must reach Cost_View_All — fixed 2026-08-06
`Cost_View_All` originally carried no zonal at all, and `buildBillingModel` left `model.zonal` empty
unless the caller read it — which only menus 9 and 12 did. The page ops and finance read for current
cost therefore understated it by the entire zonal spend. Fixed structurally:
- The Zonal tab is read **once, inside `_misReadSource()`**, and indexed by oracle onto `d.zonal`, so
  every consumer gets it without remembering to ask. Populating it per-caller is what caused the bug.
- `Cost_View_All` gains a **Zonal ₹** column and one `Zonal trips — fixed per trip (RFQ)` row per
  vendor, both flowing into TOTAL and GRAND TOTAL. The amount and trip count are live
  `SUMIFS`/`COUNTIFS` against the Zonal tab, so a later paste updates the page without regenerating.
- The Other-Adhoc bucket also now appears as its own row on `Cost_View_All`.

## Oracle ids must be normalised before joining — 2026-08-06
`Contract_Info` stores `18838` as a NUMBER while a pasted zonal extract or a CSV round-trip can produce
`"18838"` or `"18838.0"`, and `ORC-4521` is text. An unnormalised join silently zeroes the zonal amount,
which is the worst failure mode for a billing figure. All oracle comparisons now go through
`_misOrcKey()` (strip whitespace, upper-case, drop a trailing `.0`). Display always uses the
as-written value.

Paired with a gate: **"Every zonal row matches a known vendor"** BLOCKS when an oracle on the Zonal tab
matches no contract, and names the unbillable amount. A mistyped oracle can no longer vanish.

## Vendor pack carries the raw trip list — 2026-08-06
Vendors reconcile against trip ids, so `Trip Details` in the pack is a full extract, not a summary:
Date · **Trip id** · Contract · Vehicle · Size · Route · Challan type · Billing type · KM billed ·
Adhoc amount · **KM counted against** · Completed · Status. `KM counted against` is filled only for a
replacement vehicle and names the contracted vehicle its KM was folded into, so the vendor can verify
the fold themselves. `adhoc_reason_system` stays excluded.
`Billing Summary` gained a separate **Zonal amount** column — zonal was previously reported under
Adhoc amount, which is wrong on a vendor-facing document.

## MIS structure settled 2026-08-06 — two artefacts, not one sheet
The working workbook and the vendor bill are separate things and no longer share tabs.

**Working workbook (`MIS_SHEET_ID`) — 4 tabs, for ops + finance:**
`Cost_View_All` · `Zonal` (INPUT, never cleared) · `Validation_Gates` · `Exceptions`.
**No per-vendor MIS is written here any more.** `Control`, `Local`, `Adhoc` and `Summary` were removed
from this workbook: a per-vendor view sitting beside every other vendor's rates served no purpose once
the vendor MIS became a standalone file, and it was one more thing that could be sent by mistake.

**Vendor MIS — a standalone spreadsheet per vendor, downloaded as .xlsx.** Tabs in the order the
business asked for: **`Local` · `Zonal` · `Adhoc` · `Summary`**.
- `Local` — per contract: vehicle breakdown (V#, plate, active period, days, contracted KM, KM run,
  used %, trips), replacements, the grouped-KM billing block, then the local trip list with trip ids.
- `Zonal` / `Adhoc` — the trip list and total for each, always present even when empty so the bill has
  the same shape every month.
- `Summary` — per-contract payable, vendor total, and the plain-English method notes.
Every trip in the period appears exactly **once** across Local, Zonal and Adhoc, each with its trip_id.

**`Control` is gone.** Its gate results now surface where they are actually acted on: the
`Validation_Gates` tab, and a dialog at generate time that names each blocker and asks before
proceeding. A tab nobody opens is not a control.

**Menu simplified to two items** — `9 · Refresh cost view + gates (all vendors)` and
`10 · Generate vendor MIS → Excel`. The old in-sheet generate (9) and archive (11) were dropped: the
generated Excel *is* the frozen, issued artefact, so a separate archive step was redundant.

## Summary is tab 1 and carries a highlighted notice — 2026-08-06
- **Tab order in the vendor MIS is `Summary` · `Local` · `Zonal` · `Adhoc`.** Summary moved to first
  because it is the page a vendor lands on and it holds the number they care about; the other three are
  supporting detail.
- **A highlighted banner sits on Summary row 3**, merged across the table width, amber fill with navy
  bold text. Text lives in the `MIS_VENDOR_NOTICE` config var at the top of `Billing.gs` so the wording
  can be changed without touching the writer; set it to `''` to hide the banner.
  Current wording: *"This Summary is the main page — it carries the final payable for the period. The
  Local, Zonal and Adhoc tabs are the working detail (trip-by-trip backup) behind these numbers. If
  anything needs clarifying, please reach out to your AM or TM — happy to help."*
- "L2" was deliberately not used in the vendor-facing wording — it is internal panel vocabulary and
  means nothing to a transporter. "Working detail (trip-by-trip backup)" carries the same meaning.
- The Summary table now starts at row 5 and freezes 5 rows, so the banner stays visible while scrolling.

## Zonal panel fixes: card bifurcation and a scope-aware dispute modal — 2026-08-07
Two defects reached the vendor-facing panel because the zonal work reused local rendering paths
unchanged. Both are fixed together in `vercel-app/index.html` + `apps-script/Code.gs`.

**1. Two zonal cards in one cluster were indistinguishable.** A zonal card is created *per contract*,
so a vendor with `RJK7-…` (7ft/12hr) and `RJK10-…` (10ft/24hr) in Rajkot saw two cards both titled
"Rajkot · Zonal Routes". The name is now `<cluster> · <size> · <hours> · Zonal Routes`, the meta line
mirrors the local card, and the Trip-MIS Contract dropdown appends the source contract id. `size` and
`hours` are carried onto the zonal card from its parent contract so the L1 size/hours filters treat the
two consistently. The internal `::ZONAL` suffix is stripped everywhere a vendor can see it.

**2. Raising a dispute on a zonal trip showed "Current KM: null km".** The modal was built for the
local axis only. It is now scope-aware:
- categories become `Wrong billing type` / **`Wrong amount`** / **`Wrong RFQ ID`**;
- the amount panel reads `zamt` (or `adhoc_amount` on zonal adhoc), never `km`;
- an RTO trip of either scope reads `₹0 — RTO, not payable`, matching the ONE RTO RULE;
- the aggregate-against-default-vehicle dropdown is suppressed — zonal has no vehicle level;
- claims post `claim_zonal_amount` and `claim_rfq_id`, which `applyDispute()` already accepted but no
  UI could ever send;
- `Disputes_Log.categories` records `Wrong zonal amount` / `Wrong RFQ` on zonal so ops can read the log
  without joining back to `Trip_Level`.

`_buildDisputeMap()` in `Code.gs` was silently dropping all seven zonal dispute columns, so the
View-Dispute dialog could not have rendered a zonal dispute even once the UI sent one. Added.

**Validation is now automated, not eyeballed.** `vercel-app/_uitest.js` loads the real `index.html` in
headless Chromium against the real `Code.gs` payload and walks every trip kind (Local Regular / Adhoc /
Adhoc-RTO / Zonal Regular / Zonal Adhoc / Zonal RTO / zonal with no RFQ id / zonal with km+amt absent)
through the dispute modal, asserting the posted claim body field-by-field, plus confirm, bulk confirm,
View-Dispute, the table scroller and the CSV export. It fails on any `null`/`undefined`/`NaN` reaching
the screen. 134 assertions, all passing. Run it before any future panel push.

## A zonal trip has no contract_id — its rfq_id IS the contract id — 2026-08-07
The engine leaves `contract_id` blank on zonal rows. Zonal was being grouped per contract everywhere, so
this would have silently collapsed every zonal trip into one flat "Zonal Adhoc Trips" bucket on the panel
and dropped the per-contract zonal figure in the MIS. Rebuilt around the RFQ.

**Decisions taken (all three the recommended option):**

1. **One panel card per `rfq_id`**, built at vendor level, internal id `ZONAL::<rfq_id>`, label
   `<cluster> · <size> · Zonal · <rfq_id>`. Vendor attribution comes from `transporter_oracle_id`, which
   every Trip_Level row carries — so no contract join is needed. Rejected: one card per cluster (re-creates
   the ambiguity we just fixed) and one card per vendor (a vendor with 6 RFQs could not reconcile).
2. **No RFQ master tab.** Cluster, vehicle size, period and last-trip date are derived from the card's own
   trips (mode / min / max); the amount is whatever `zonal_rfq_amount` says. Zero ops overhead. The
   accepted cost: nothing validates a trip's amount against a contracted RFQ rate. Revisit with a
   `Zonal_RFQ_Info` tab if amounts start drifting.
3. **MIS Summary gets one line per `rfq_id` plus a `Zonal subtotal`.** The subtotal repeats the lines
   above it, so `TOTAL PAYABLE` sums to the row before it — otherwise zonal double-counts.

**Consequences that needed code, not just wiring:**

- `Code.gs` splits zonal out of `myTrips` *before* `tripsByContract` is built, so the per-contract loop
  never sees a zonal row. `_zonalByContract` and the `_zOrphan` fallback are gone — both existed only to
  cope with contract-keyed zonal.
- `Billing.gs` has ONE zonal source again (`_misReadSource`, vendor level). The per-contract zonal
  derivation, `c.zonalAmt/zonalAdhoc/zonalRows/zonalRfq`, and the `zTripCount ? contracts : paste`
  preference are all deleted. A `route_scope != Zonal` filter stays in the contract loop as belt-and-braces
  for the case where the engine *does* stamp a contract_id.
- `Actions.gs` gains `_billRef(ctx, ri)` — the one place that decides "contract_id on local, rfq_id on
  zonal". All three log tabs write it into their `contract_id` column, with `route_scope` alongside so ops
  can tell them apart. The `ZONAL_NOT_EDITABLE` message names the RFQ instead of a blank contract id.
- `resolved_rfq_id` now writes `Trip_Level.rfq_id` on a zonal row, mirroring `resolved_contract_id` →
  `contract_id` on local. The two are mutually exclusive.
- The dispute modal drops the separate contract-id field on zonal: one RFQ ID pair, since they are the
  same thing.
- New MIS gate: **"Every zonal trip carries an RFQ ID"** (`WARN`). A blank rfq_id used to be cosmetic;
  it is now a missing contract reference. Such trips still bill and still show, grouped under
  `(no RFQ id)`.

**Verification.** Every zonal `contract_id` in the demo set was blanked to match production, then both
harnesses were re-run: `testkit/_uitest.js` **153/153** and `testkit/_billtest.js` **22/22**. The MIS
zonal total is **₹47,100 across 6 RFQ lines**, matching an independent hand-rolled sum off the CSV and
matching the figure from before the change — so the restructure moved zero money. The billtest also
blanks an `rfq_id` at runtime to prove the new gate bites and that the money does not move when it does.

### Follow-ups the same day — the reference on the row, and the L2 header
Two things surfaced on review of the RFQ change:

**1. Each trip now names its own billing reference.** The trip table's Contract column was rendering the
*card's* id, so a trip inside the Zonal Adhoc bucket read `ORC-4521_Zonal_Adhoc_Trips` instead of the RFQ
it actually billed against, and inside a bucket L2 the column was hidden entirely — three trips from three
different RFQs with no way to tell them apart. Fixed at the source: `_classifyTrip()` now returns
`ref` (contract_id on local, rfq_id on zonal — the same rule as `_billRef()` in `Actions.gs`), every mapped
trip carries it, and the panel renders `t.ref`. The column is titled **Contract / RFQ ID**, tinted teal on
zonal rows, and shown on any panel whose trips span more than one reference — so on bucket cards and the
global MIS, hidden on a contract card and a zonal RFQ card where the header already names it. A local trip
with no contract_id reads `— no contract ID —` rather than borrowing the bucket's name.

Also: **Replacement is dropped on an all-zonal panel** (there is no default-vehicle notion on zonal, so the
column was a run of em dashes), and the RFQ is spelled out under the amount only where the reference column
is hidden, so it never appears twice on one row.

**2. The L2 header was misaligned.** The zonal explanation was crammed into the monospace `.csum-id` line,
so a full sentence rendered as code, and the two metric tiles read "Vehicles —" and "Actual KMs Run —" —
two dead dashes, because neither exists for zonal. The header now has three parts: the title, a short mono
id line (RFQ ID · Period), and a **full-width `.csum-note` band** in the body font for any explanation. The
two tiles are relabelled per card type — `Zonal Trips` / `Total Payable` on a zonal card, `Adhoc Trips` /
`Total Payable` on a bucket, `Vehicles` / `Actual KMs Run` on a contract — so they always carry a number.

Panel harness now at **172 assertions**, including header/body cell-count agreement on both a local and an
all-zonal panel. That check earned itself immediately: a `var _bkN` I first named `_bn` shadowed the
`breakupNote` element and broke `showL2` — the harness caught it before it left the container.

### "Zonal trips are not transferring / the Confirm buttons are gone" — 2026-08-07
Three reports, three different answers. Diagnosed against the live sheet (32 trips, 11 zonal), not guessed.

**1. The zonal trips WERE transferred — all 11.** Every zonal row already carried
`sent_to_vendor_flag = Yes`, so `transferReadyTrips()` skipped them, correctly, and menu 4 reported nothing
moved. Root cause: `sample-data/zonal_demo_rows.csv` shipped with `sent_to_vendor_flag = Yes` pre-set. That
also explains report 2 ("why am I seeing trips that have not been transferred") — the same fact from the
other side. The CSV now ships with `ground_review_deadline`, `sent_to_vendor_flag`,
`sent_to_vendor_timestamp`, `vendor_status` and `dispute_window_end` **blank**, so menu 4 does the real work
and stamps a live 15-day dispute window instead of a stale July one.

Side effect of the pre-flagged paste, worth knowing: 9 of the 11 never got a `dispute_window_end`, because
menu 4 is the only thing that writes it and menu 4 never ran on them.

**2. Confirm / Raise Dispute were being rendered but were unreachable.** Adding the Contract / RFQ ID
column pushed the table to 1463px; below ~1400px the `.tscroll` scroller kicked in and the Action column
sat past the right edge. Measured: 83px of overflow at 1440, 243px at 1280. **The Action column is now
pinned** (`position:sticky; right:0`), which required `.ttable` to drop `border-collapse:collapse` and its
own `overflow:hidden` — sticky cells are ignored under both — with `.tscroll` taking over the rounded
corners. Column min-widths were trimmed too, so 1440px now has zero overflow and nothing scrolls at all.
Verified visible at 1920 / 1600 / 1440 / 1280 / 1152.

**3. New: the panel no longer offers an action the backend will reject.** `applyDispute()` throws once
`dispute_window_end` has passed, but the row still showed a Raise Dispute link — the vendor would click it
and get an error. The payload now carries `winTs` (the raw timestamp) beside `win` (the display string), and
a closed window renders a muted "Dispute window closed" with the date in its tooltip. Confirm stays, because
confirming has no window. A blank window counts as open, matching the backend, which only enforces a window
it can read.

Panel harness now at **207 assertions**, including: the Action header and the Confirm button are on screen
*without scrolling* at five viewport widths; Confirm appears for every pending trip; Raise Dispute appears
for exactly those whose window is open; "Dispute window closed" for exactly the rest; and never both or
neither on one row.

### The dispute claim was being dropped by the API — 2026-08-07
Ayush raised a zonal dispute claiming ₹5,500 against ₹5,300 and **the claimed amount did not appear
anywhere**. The dispute itself landed and the status flipped, so nothing looked broken.

**Root cause: `vercel-app/api/action.js` builds the queued action from an explicit field whitelist, and
`claim_zonal_amount` / `claim_rfq_id` were not in it.** The panel sent them, the API silently discarded
them, and `applyDispute()` received `undefined` and wrote blanks. `Disputes_Log` had all 7 zonal columns —
the schema was never the problem.

This is a third place a dispute field has to be named, and I had only checked two: the panel and
`Actions.gs`. `_uitest.js` asserts the POST **body** the browser sends, so it could never have caught this;
the drop happens one hop later, server-side.

**New harness `testkit/_apitest.js` closes the class of bug, not just this instance.** It extracts the
`claim_*` field sets from all three files — `index.html` `submitDispute()`, the `api/action.js` whitelist,
and `applyDispute()` — and fails if they are not identical, naming any field dropped or orphaned at either
boundary. Plus a live pass that actually invokes the handler with a stubbed Upstash and asserts
`claim_zonal_amount = 5500` reaches the queue. Verified non-vacuous: deleting the line from
`api/action.js` makes 3 assertions fail, including the live one.

Also this round:
- **An always-visible horizontal scrollbar** on `.tscroll` (styled thumb + track, `scrollbar-gutter:stable`)
  instead of the OS overlay bar that fades out, plus a hint line — *"Scroll the table sideways… the Action
  buttons stay pinned on the right"* — that appears only while the table actually overflows. The pinned
  Action column told a vendor nothing about the middle columns they were missing.
- The pinned column's shadow was softened to a 1px border plus a faint edge, so it reads as an edge
  rather than a bevel.

Harness totals: **_apitest 19 · _uitest 207 · _billtest 22.**

### Zonal adhoc has no RFQ id — and that must not read as a missing value — 2026-08-07
Ayush: *"Zonal Adhoc Trips will have no RFQ id attached to it. How are we handling it?"* Correctly the
answer was: badly, in three places, because the RFQ-as-contract-reference work treated all zonal alike.

A zonal **Regular** trip bills at its RFQ rate, so `rfq_id` is its billing reference. A zonal **Adhoc**
trip bills on `adhoc_amount` — **no RFQ rate applies, so `rfq_id` is blank by design.** With the demo data
carrying an RFQ on adhoc rows, none of this surfaced. Blanking them (matching production) exposed it:

1. **The MIS invented a phantom RFQ line.** `_misZonalRfq()` grouped on `rfq_id || '(no RFQ id)'`, so every
   adhoc trip collapsed into a Summary line reading `Zonal RFQ (no RFQ id)`. Adhoc now collects into a
   single trailing group flagged `isAdhoc`, rendered as **"Zonal adhoc trips — N trip(s), billed on amount
   (no RFQ rate applies)"**. The Zonal tab bands it separately too, always last, with an `ADHOC TOTAL`.
2. **The new gate would have WARNed forever.** "Every zonal trip carries an RFQ ID" counted adhoc rows as
   missing values. It is now **"Every zonal REGULAR trip carries an RFQ ID"**. Scoping it is not a
   softening — a warning that is always on is a warning nobody reads.
3. **The panel offered a dispute category with nothing behind it.** A zonal adhoc trip was shown
   "Wrong RFQ ID" with `Current RFQ ID: — not set —` and a required input. The category is now withheld
   when a zonal adhoc trip has no `rfq_id`, and the amount panel explains why: *"billed on its amount, not
   on an RFQ rate, so it carries no RFQ ID."*

Also: the Contract / RFQ ID column reads **`Zonal adhoc`** on those rows rather than `(no RFQ id)`, and
`_billRef()` writes the same into the log tabs. `(no RFQ id)` is now reserved for the one case that really
is a data problem — a zonal **Regular** trip with no RFQ.

**All of it keys off "is the rfq_id actually there", not a hard-coded assumption**, so if the engine does
stamp an RFQ on an adhoc trip, the column, the band and the dispute category all come back.

Harnesses: **_apitest 19 · _uitest 213 · _billtest 30.** The demo data now blanks `rfq_id` on every zonal
adhoc row, and `_billtest` asserts both directions — the gate stays clear with 3 RFQ-less adhoc rows, and
still fires when a zonal *Regular* row loses its RFQ.

## Closing two dead-end dispute loops — 2026-08-07
Ayush asked two questions that both turned out to be real holes, confirmed by running the classifier
rather than reading it (`testkit/_resolvetest.js`).

### 1. "How can a zonal Regular be disputed to zonal Adhoc?"
It could be raised and logged, and **nothing could action it** — the appliers ignored
`resolved_billing_type` on zonal, yet still flipped `vendor_status` to `Reconfirm`, telling the vendor it
was "Resolved" over a trip that had not changed.

**Decision (Ayush): an upheld resolution flips it, and the trip pays `adhoc_amount`.**

Implemented through a **new column, `billing_type_resolved`** — not `billing_type_final`. I tried sharing
`_final` first and the MIS harness caught it immediately: `TR-ZT-0006` carries a ground
`billing_type_final = Regular` (the deliberate rule-(iii) test row), and sharing the column moved **₹4,800**
and dropped the zonal total from ₹47,100 to ₹42,300. `_final` is a *ground* column; the `ZONAL_NOT_EDITABLE`
guard only runs at transfer, so any row the engine flags directly would bypass it. Two authorities need two
columns:

```
zonal :  billing_type_resolved || billing_type_system     // ground's _final still ignored
local :  billing_type_final    || billing_type_system     // unchanged
```

**Plus a money guard.** The engine populates `adhoc_amount` on every trip, so a flip normally has a value
to land on and this guard never fires. It is there for the case where it does not: the applier **refuses** a
flip to Adhoc when both `resolved_amount` and the existing `adhoc_amount` are empty, and logs why, rather
than silently turning a ₹5,300 trip into a ₹0 one. (I first read the blank `adhoc_amount` on the demo
fixture's zonal Regular rows as a production fact — Ayush corrected it. The guard is worth keeping on its
own merits; the demo fixture is simply what it is tested against.)

### 2. "How can a person ask for the amount/KM on an RTO trip?"
They could ask, and it could never work. `payable = rto ? 0 : …` and `km = rto ? 0 : km` are applied
*before* any resolved value, so writing `zonal_rfq_amount_final` or `total_trip_km` on an RTO trip is a
**no-op** — proven by execution, both scopes. `challan_type_final` is the only lever that clears RTO and
nothing in the panel, the API or the appliers could write it. (Its being blank across the sheet is correct
— it is an override column and blank is its resting state. The gap was the missing write path, not the
empty column.)

**Decision (Ayush): build it, but do not surface it as a separate "Not an RTO trip" category — the vendor
just claims the KM/amount.** So: on an RTO trip the ordinary Wrong KM / Amount panel explains that entering
a value is also a claim that this was not an RTO, and posts `claim_challan_type = 'Forward Only'` alongside
it. Ops answers with `resolved_challan_type`, which writes `challan_type_final` on **both** scopes — a
challan is a fact about the trip, not a classification the engine owns. Everything else follows through the
shared classifier.

Proven: zonal RTO ₹0 → ₹5,300 · local RTO 180 km enters the slab · local Adhoc RTO recovers ₹4,944 · and
writing the amount alone still changes nothing, which is what made the old path dead.

**Schema: 4 new columns.** `Trip_Level.billing_type_resolved`, and `Disputes_Log.claim_challan_type` /
`orig_challan_type` / `resolved_challan_type`.

Harnesses: **_apitest 22 · _uitest 225 · _billtest 30 · _resolvetest 15 (new).** `_resolvetest.js` runs the
real classifier over the sheet state each resolution would produce, and asserts both that the loop closes
*and* that ground is still locked out.

### `billing_type_resolved` made universal — 2026-08-07
Ayush: *"are we sure that is universally applicable both for local/zonal trips?"* It was not. Local
resolutions still wrote `billing_type_final` while zonal wrote `billing_type_resolved` — one
`resolved_billing_type` column in `Disputes_Log` landing in two different `Trip_Level` columns depending
on the trip's scope. Anyone reading `Trip_Level` would have had to check the scope first to know which
column carried the answer.

Now there is **one precedence, both scopes**:

```
billing = billing_type_resolved                       // resolution appliers only, BOTH scopes
       || (zonal ? '' : billing_type_final)           // ground — LOCAL only (rule iii)
       || billing_type_system                         // the engine
```

Both appliers write `billing_type_resolved` on both scopes. Ground keeps `billing_type_final` and still
reclassifies local trips exactly as before; a resolution simply outranks it. The only scope-dependent term
is ground's, and rule (iii) is now one skipped term in a single expression rather than two divergent ones.

Backwards compatible: `billing_type_final` is still read on local, so any local resolution already applied
under the old rule keeps working.

**Plus a new guard.** A resolution cannot predate a dispute, and a dispute cannot predate the transfer. So
`transferReadyTrips()` now clears any `billing_type_resolved` found on a row that has never been sent to a
vendor — on both scopes — sets `partial_edit_flag = Yes` and says so in
`Ground_Confirmation_Log.data_sent`. A hand-typed cell must never outrank the engine.

Harnesses: **_apitest 22 · _uitest 225 · _billtest 30 · _resolvetest 21 · _flowtest 10.** `_resolvetest`
gained a local block asserting the full precedence chain in both directions — ground still works on local,
a resolution outranks it, and on zonal ground is skipped in the identical expression.

---

## Thorough test sweep — 2026-08-11

Ayush: *"Can you do thorough testing of all the changes we had made. Do not want to miss out any use
case?"*

I started by mapping which functions had assertions behind them and which only had *coverage by
accident*, then built harnesses for the gaps. The sweep went from **5 harnesses / ~290 assertions** to
**11 harnesses / 658 assertions**, and it found one live money bug, one root cause, and one vacuous test
that was hiding the first.

### BUG (fixed) — ₹17,000 of zonal money was being billed twice

`_paritytest.js`, written for this sweep to assert that the panel and the MIS cannot disagree, reported
11 duplicated trips. Tracing it landed on `_misReadSource()` in `Billing.gs`:

```js
tl.forEach(function (t) {
  var cid = _s(t.contract_id);
  if (info[cid]) { (trips[cid] = trips[cid] || []).push(t); return; }
  var orc = _s(t.transporter_oracle_id);
  if (excl[_low(orc)] || !byOracle[orc]) return;
  (orphans[orc] = orphans[orc] || []).push(t);     // <-- every zonal trip landed here
});
```

A zonal trip has **no `contract_id`** by design — decision 2026-08-07, its `rfq_id` *is* the contract
reference. So every zonal row failed the `info[cid]` test, fell through to the Other-Adhoc orphan bucket,
and was counted a second time:

| | before | after |
|---|---:|---:|
| rows in the Other-Adhoc bucket | 14 (3 real + **11 zonal**) | 3 |
| `bucket.adhocAmt` | ₹27,500 | ₹10,500 |
| `totals.adhoc` | ₹39,150 | ₹22,150 |
| `totals.zonal` | ₹47,100 | ₹47,100 |
| **`totals.payable`** | **₹548,250** | **₹531,250** |

₹17,000 counted once in `totals.zonal` and again in `totals.adhoc`. The same 11 trips also appeared on
the MIS **Adhoc** tab as well as the **Zonal** tab, breaking the documented promise that every trip
appears exactly once — so a vendor reconciling line by line would have found their own trips listed
twice.

**The asymmetry was the bug.** `Code.gs` already filtered zonal out of its orphan bucket
(`localAll.filter(...)`); `Billing.gs` never did. The fix is the same filter, at the top of the loop:

```js
// ZONAL IS NOT A LOCAL TRIP. A zonal row carries NO contract_id by design (its rfq_id is the
// contract reference), so without this guard every zonal trip fails the info[cid] test, falls
// through to the orphan bucket, and gets billed a SECOND time as Other/Adhoc on top of
// totals.zonal. Code.gs already filters zonal out of its own orphan bucket (localAll); this is
// the same filter, and the two must stay identical or the panel and the MIS disagree.
if (_low(_s(t.route_scope) || 'Local') === 'zonal') return;   // handled by the zonal pass below
```

Verified non-vacuously: with the one line removed, `_billtest` fails 6 assertions and `_paritytest`
fails 1, naming `TR-ZT-0001…4`. With it in, all 658 pass.

### Why no existing test caught it

`_billtest.js`'s totals check was:

```js
const expect = m.totals.fixed + m.totals.excessAmt + m.totals.adhoc + m.totals.zonal;
ck(R(m.totals.payable) === R(expect), 'payable is the sum of its four parts');
```

Every term comes from the same object, so it holds **no matter how wrong `adhoc` is**. It had only ever
cross-checked *zonal* against the CSV independently, never adhoc — which is precisely the term the bug
inflated. `_billtest` now sums local adhoc and the orphan bucket independently off the raw CSV, asserts
no zonal row can appear in `d.trips` / `d.orphans` / the bucket, and asserts payable is **not** ₹548,250.

**The lesson, worth keeping:** a self-consistency check is not a test. Every total needs at least one
independent re-derivation, or it will agree with itself while being wrong.

### ROOT CAUSE found — the two live date findings are one bug

`_datetest.js` (new) established *why* the live sheet holds `contract_start_date = 2026-01-08` and an
unreadable `contract_end_date = "31-08-2026"`. They are the same typing mistake. If a date is stored as
**text** in the Indian `dd-mm-yyyy` format, JS reads it as `mm-dd-yyyy`:

| typed | day | `_toDate` reads | result |
|---|---|---|---|
| `01-08-2026` (1 Aug) | ≤ 12 | **8 January 2026** | parses, silently wrong |
| `31-08-2026` (31 Aug) | > 12 | **null** | no valid month — fails loudly |

The boundary is the 12th: **`dd ≤ 12` parses wrongly, `dd > 12` fails loudly.** One mistake, two
different silent failures, which is why they looked like two findings. The fix is unchanged — retype both
columns as real dates — but the rule to remember is: never store a date as text in this sheet.

### `_rtotest.js` converted from prints to assertions

It had **zero** `ck()` calls, so it could never fail and protected nothing. Now 75 assertions, including
six independent statements of the ONE RTO RULE: no `resolved_*` value pays an RTO trip, because
`payable = rto ? 0 : …` runs first. `resolved_challan_type` is the only lever.

Two facts it pins that are worth knowing before resolving one:

- On **LOCAL REGULAR**, lifting the RTO alone earns the vendor nothing — the KM is still 0, so
  `resolved_km` is required too. On the other three combinations the amount is already on the row.
- The RTO test is `startsWith('rto')`, not `contains`. `"RTO cancelled"` still reads as an RTO and still
  pays ₹0. `"Not RTO"` and `"Forward Only"` are safe.

### New harnesses

| harness | assertions | the gap it closed |
|---|---:|---|
| `_matrixtest.js` | 23 | `_classifyTrip` was tested only on the shapes the demo data happened to contain. Now the **full cross product** of the 8 fields that influence classification — **12,960 combinations** — each compared against an independent oracle written from `ZONAL_LOCAL_SCHEMA.md`, not from the code |
| `_paritytest.js` | 35 | nothing asserted that the panel and the MIS agree, which is the promise the whole shared-classifier design rests on. Per contract, per RFQ, per trip, and both grand totals. **Found the ₹17,000 bug** |
| `_guardtest.js` | 81 | every **refusal** path in `Actions.gs` — the ground window, `ZONAL_NOT_EDITABLE`, the hand-typed `billing_type_resolved` clear, the incomplete-reclassification bounce, and ownership / locking / closed-window on both `applyConfirm` and `applyDispute`. None of these had a single assertion |
| `_importtest.js` | 60 | the **CSV** resolution door was completely untested although it writes the same `Trip_Level` columns as the in-sheet door. Includes an **equivalence** section running six scenarios through both doors and requiring a byte-identical `Trip_Level` snapshot |
| `_datetest.js` | 69 | `_toDate` / `_misInPeriod` / `_projFields` had no tests at all, and dates are the one failure mode that never shouts. **Found the root cause above** |

### Two guard behaviours confirmed as correct, not bugs

Both looked wrong until executed:

- A `ZONAL_NOT_EDITABLE` or `NEEDS_ATTRIBUTION_FIX` trip **still transfers.** The bad *edit* is dropped,
  not the trip. Dropping the trip would hide money from the vendor to punish a ground mistake.
- A blank `dispute_window_end` does **not** lock the vendor out. Blank means *not yet closed*, not
  *closed*. A trip transferred before the window logic existed must still be disputable.

### Final state

**11 harnesses, 658 assertions, all passing.**

```
_uitest      225      _billtest    37      _apitest     22
_guardtest    81      _paritytest  35      _resolvetest 21
_rtotest      75      _matrixtest  23      _flowtest    10
_datetest     69      _importtest  60
```

`testkit/README.md` ends with a **"What is still not covered"** section naming the four remaining gaps
(the Upstash sync hop, real Sheets I/O, the menu wrappers, and live master data) so they are known gaps
rather than blind spots.

**One file changed in production code:** `apps-script/Billing.gs`, one line. Everything else in this
sweep is tests and documentation.
