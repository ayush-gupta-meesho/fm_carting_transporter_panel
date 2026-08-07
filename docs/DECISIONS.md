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
