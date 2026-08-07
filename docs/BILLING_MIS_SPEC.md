# FM Carting — Billing MIS · architecture + build spec

**Status: BUILT.** `apps-script/Billing.gs` implements this spec; `apps-script/Code.gs` carries the
shared `_classifyTrip()` it depends on. Written 2026-08-06 against the live *FM Carting - Panel* sheet
(`134OJqrUPtpEdTE6-WbacjKMfvEtRsj6l7vzn5P4F52I`) and the `fm_carting_transporter_panel` code at
GitHub `main`.

Companion file: `mockups/FM_Carting_Billing_MIS_prototype.xlsx` — a sample of every tab below,
populated with real July data. It is a reference for what the output looks like; `Billing.gs` is what
actually produces it.

**Verification.** Both `Code.gs` and `Billing.gs` were executed in Node against the live sheet's data
and cross-checked against an independent Python reimplementation of the billing rules. All 9 billable
contracts agree on all 10 measured fields (regKm, slab, fixed, excessKm, excessAmt, adhoc, unattributed,
pending, RTO count, vehicle count). Grand payable ₹22,43,896.41 in both. Shiv Roadlines ₹3,97,047.89 in
both and in the prototype workbook.

---

## 1. Where the MIS is computed — recommendation

> **Compute the billing model ONCE, in the parent Apps Script project, in a new `Billing.gs`.
> The MIS spreadsheet is a pure render target: it holds no classification logic and no
> re-derivation of KM, RTO, default-vs-replacement or billing type.**

The requirement that decides this is yours: the MIS must be *"exactly on the basis of information in
the parent sheet and how it is being shown on the Vercel platform."* There is exactly one way to
guarantee that — the MIS and the panel must run the same code. Anything else is two
implementations of the same rules, and the day they drift is the day a vendor is paid the wrong amount.

### Why not the three alternatives

**(a) Formulas / a script inside the MIS sheet re-reading the parent tabs.** Rejected. It needs a
second copy of `billing_type_final || billing_type_system`, `startsWith('rto')`, the exact-string
default match, and the replacement fold. Four rules × two places = guaranteed divergence, and
sheet formulas cannot express the replacement fold cleanly at all.

**(b) An Apps Script Library.** Publish the parent project as a library, add it to the MIS
project by script ID, call `VALMOPanel.buildBillingModel()`. Academically the right answer, and it
does put a Generate button inside the MIS sheet. Rejected for now because of version friction: a
container-bound script used as a library must be deployed as a *numbered version*, and the consumer
pins that number — so every Code.gs edit needs a re-deploy plus a bump in a second project, or you
run in development mode and lose reproducibility. That is a real trap for a tool one person maintains.
Worth revisiting if ops ever needs to self-serve generation.

**(c) Rebuild billing from the Upstash payload.** Tempting — it would guarantee panel parity by
construction. Rejected because the payload is UI-shaped and lossy for billing: `km` is `null` on
every Adhoc trip, `amt` is `null` on every Regular trip, RTO trips are zeroed with the real distance
discarded, `vendor_status` is collapsed to four display buckets, dates are pre-formatted strings, and
`fixed_monthly_value` / per-vehicle `monthly_rate` / `adhoc_reason_system` are absent entirely.
Billing off a display format means reverse-engineering it. **But the payload is still useful as a
check — see §6.**

### Component layout

```
FM Carting - Panel  (parent sheet, source of truth)
└── Apps Script project
    ├── Code.gs      _buildVendorPayload / _buildAdminPayload   → Upstash → Vercel panel
    ├── Actions.gs   transfer / drain / resolutions / guards
    ├── Sync.gs      Upstash writes
    └── Billing.gs   ★ NEW
        ├── buildBillingModel(oracle, periodStart, periodEnd)  → pure JS object
        ├── runGates(model)                                    → [] or a list of blockers
        ├── writeMisSheet(model)                               → SpreadsheetApp.openById(MIS_SHEET_ID)
        └── menu: "VALMO Panel → 9 · Generate Billing MIS" (+10 refresh, +11 archive)

FM Carting - Billing MIS  (separate sheet — ops + finance read here)
└── Control · Local · Zonal · Adhoc · Summary · Cost_View_All · Validation_Gates · Exceptions
```

`Billing.gs` reuses the existing `_readTab`, `_s`, `_low`, `_num`, `_yes`, `_toDate`, `_projFields`
helpers, and — critically — the **same classifier functions** as `_buildVendorPayload`. The right
refactor is to lift the per-trip classification out of `_buildVendorPayload` into a shared
`_classifyTrip(t, defSet)` that both the payload builder and the billing builder call. That is the
single change that makes "the MIS agrees with the panel" a structural property rather than a hope.

**Button location.** The generate action lives in the **parent sheet's** existing VALMO Panel menu,
not in the MIS sheet, because generation is an admin act and ops/finance are readers. If you want it
in the MIS sheet, that is what pushes us to option (b).

**Performance is a non-issue** — you publish 4–5 days after the contract period ends, so nothing
runs inside the ~6-minute trigger window. One `Billing.gs` run reads each tab once and writes one
vendor's tabs.

---

## 2. The billing formula

Per contract:

```
payable = fixed_monthly_value
        + MAX(0, Σ local Regular non-RTO KM − grouped_km_slab) × ex_km_rate
        + Σ local Adhoc trip amounts
        + Σ Zonal trip amounts          (rfq_rate, fixed per trip)
        + Σ Zonal Adhoc trip amounts
```

Vendor payable = Σ over the vendor's contracts in the period, plus any `ADHOC-<oracle>` /
Other-Adhoc bucket as its own line.

**Excess is computed at grouped-contract level, never per vehicle** (your call). The vehicle
breakdown is presentational: a vehicle running 2,135 km against its own 1,000 km pegged slab creates
no excess charge as long as the contract total is inside the contract slab. July has a live example —
`RJK10-13551-20260717-01` vehicle V2 `GJ03CW5050` sits at 2,135 effective km against a 1,000 km peg,
while the contract as a whole is only 64 km over.

---

## 3. Classification rules — copied from the panel, not reinvented

```
billing   = billing_type_final || billing_type_system
isAdhoc   = lower(billing) == 'adhoc'
rto       = challan_type_final ? lower(challan_type_final).startsWith('rto')
                               : lower(challan_type).startsWith('rto')
                                 || (!yes(km_accumulated_flag) && km == 0 && !isAdhoc && km_accumulated_flag != '')
isDefault = (contract_id, vehicle_number) exists in Contract_Vehicles   — EXACT string match
foldTo    = replaced_default_vehicle_final || replaced_default_vehicle_system
period    = trip_date  (not trip_end_time — a trip ending 1 Aug still bills to July)
settled   = lower(vendor_status) in ('confirmed','reconfirmed')
```

Accumulation: a Regular non-RTO trip's KM enters the **contract** total regardless of whether its
vehicle is a default. It enters a **vehicle row** only if the vehicle is a default, or is a
replacement whose `foldTo` names a real default of that contract.

**This is why the unattributed-KM case is a reporting hole, not a money hole.** Such KM is already
inside the slab and already inside the payable; it is only missing from the vehicle breakdown. The MIS
shows it as an explicit `UNATTRIBUTED — in slab, no vehicle mapped` line so the breakdown always foots
to the contract total. It never silently disappears. (Three July trips totalling 118 km were in this
state on 2026-08-05 and have since been resolved at source — the current count is zero.)

RTO trips appear as trip lines with their `challan_type`, KM rendered as 0 and marked
*not accumulated* — same as the panel.

Pending trips are **billable** and included in the payable, with the pending KM and pending ₹
called out separately on Summary. `Reconfirm` (awaiting vendor re-acceptance) counts as not-settled;
`Reconfirmed` counts as settled.

`ORC-4521` is excluded from the MIS by hardcoded oracle id. It stays visible on the admin panel.

---

## 4. Two artefacts

**Working workbook (`MIS_SHEET_ID`) — ops + finance keep this open**

| # | Tab | Grain | Contents |
|---|---|---|---|
| 1 | `Cost_View_All` | contract + vendor | all vendors, all contracts: slab KM, reg KM, excess KM, rate, excess ₹, fixed ₹, adhoc ₹, **zonal ₹**, TOTAL, pending KM, projection, gate verdict. Plus one zonal row and one Other-Adhoc row per vendor. Grand total at the foot |
| 2 | `Zonal` | trip | the 17-column paste area (+ `source`), all vendors together. **INPUT — never cleared.** Read once in `_misReadSource()` and indexed by oracle |
| 3 | `Validation_Gates` | contract | `Contract_Vehicles` vs `Contract_Info`, three ways, with BLOCK verdicts |
| 4 | `Exceptions` | trip / issue | A unattributed · B cross-contract plates · C look-alike plates · D idle vehicles · E out-of-period |

No per-vendor MIS is written here.

**Vendor MIS — one standalone spreadsheet per vendor, sent as .xlsx**

| # | Tab | Contents |
|---|---|---|
| 1 | `Local` | per contract: vehicle breakdown (V#, plate, active period, days, contracted KM, KM run, used %, trips, replacement note) → replacements in grey → CONTRACT TOTAL → the grouped-KM billing block (slab, KM run, over/under, excess KM, rate, excess amount, fixed amount, LOCAL PAYABLE) → the local trip list with **trip ids**, challan type, KM billed and *KM counted against* |
| 2 | `Zonal` | zonal trip list + total. Always present, even when empty |
| 3 | `Adhoc` | adhoc trip list + total, including the Other-Adhoc bucket |
| 4 | `Summary` | per-contract payable with a separate **Zonal amount** column, TOTAL PAYABLE, and plain-English method notes |

Every trip in the period appears exactly once across Local, Zonal and Adhoc.

Withheld from the vendor MIS: `adhoc_reason_system`, projection/sizing signals, gate results, and every
other vendor's rows.

## 5. Zonal — built now, automatic later

Zonal trips are not in `Trip_Level` today and are not landing as Adhoc; they are tracked separately
and pasted in. To make the manual phase and the eventual automatic phase the same shape:

- The paste area uses your 17 headers verbatim: `transporter_oracle_id, transporter_id, billing_type,
  trip_id, rfq_id, vehicle_size, vehicle_number, transporter_name, driver_name, haul_type,
  placement_date, trip_start_time, trip_end_time, source_node, planned_route, actual_route, rfq_rate`.
- Everything downstream reads that block **by header name**, and only `billing_type` and `rfq_rate`
  drive money. Adding columns later cannot break it.
- `Summary` reads the Zonal tab's computed total, never the raw rows.
- When `route_scope` / `route_scope_final` / `zonal_amount` land in `Trip_Level`, `Billing.gs` starts
  writing `route_scope = zonal` trips into the same block, mapping `zonal_amount → rfq_rate`, and adds
  a `source` column (`manual_paste` | `trip_level`). No formula and no tab layout changes.
- Guard rule to carry forward: **the reclassification guard must exempt zonal trips**, and KM
  aggregation becomes "Local + Regular + non-RTO" everywhere.

Consequence to be aware of: a vehicle that spent days on zonal work still carries its **full**
local `pegged_km_slab`. Pro-ration is a manual `Contract_Vehicles` edit by ops — no system-side
adjustment, per your decision.

---

## 6. Gates — nothing is issued until these are clear

1. `COUNT(Contract_Vehicles rows) == Contract_Info.no_of_vehicles`
2. `Σ pegged_km_slab == Contract_Info.total_km_slab`
3. `Σ monthly_rate == Contract_Info.fixed_monthly_value`
4. Every Regular non-default trip maps to a valid default of its own contract
5. No duplicate `(contract_id, vehicle_number)`
6. The vendor has at least one `Active` contract overlapping the period

Gates 2 and 3 exist because you asked for exactly this: the contract is a culmination of
`Contract_Vehicles` **and** `Contract_Info` (the ex-KM rate lives only in `Contract_Info`), so the two
must agree before anyone bills. Today the panel silently prefers the `Contract_Vehicles` sum and
nobody sees the disagreement. **Three of nine live contracts currently fail.**

**Panel parity check (recommended, cheap).** After generating, have `Billing.gs` GET the `admin:all`
Upstash key and compare each contract's `regKm` against the MIS's Local Regular KM. Equal → write
"Panel parity ✓" on Summary. Unequal → refuse to issue. This turns "the MIS matches the panel" from
a code-review claim into an automatic assertion on every run.

---

## 7. Decisions taken (2026-08-06)

| # | Decision | Note |
|---|---|---|
| 1 | Generate button lives in the **parent sheet's** VALMO Panel menu (items 9/10/11) | Generation is an admin act; ops and finance only read the MIS sheet. Keeps us off the Apps Script Library route and its version-pinning friction. |
| 2 | `rfq_rate` **is the payable amount** for a zonal trip | No multiplication. Read straight into the zonal total. |
| 3 | Run-rate **projection is on** | Per vehicle on its own active period, per contract on the contract period, on Local, Summary and Cost_View_All. Reuses `_projFields`. |
| 4 | **One MIS per vendor**, all their contracts as rows | Krushiv has 4. Summary carries a vendor total. |
| 5 | Pending trips are **billable**, flagged separately | `Reconfirm` counts as not-settled; `Reconfirmed` counts as settled. |
| 6 | Plate exceptions are **reported, never auto-corrected** | See §8. |
| 7 | `trip_date` **flags, never drops** | `contract_id` scopes the bill and the panel applies no date filter, so a date test that excluded a trip would silently break parity. Out-of-window trips are billed and listed in Exceptions block E. |

### Where the MIS sheet's script lives
Nowhere. The MIS spreadsheet holds **no Apps Script at all**. `Billing.gs` sits in the parent sheet's
project (beside `Code.gs`) because it calls `_classifyTrip`, `_readTab`, `_projFields`, `_fmtVehPeriod`
and `_tz`, and reaches the MIS sheet with `SpreadsheetApp.openById(MIS_SHEET_ID)`.

### Still open
- **What are the valid `haul_type` values**, and does any of them change the amount source? Currently
  carried through as a label only.
- **Fix the three BLOCK contracts in `Contract_Info` or in `Contract_Vehicles`?** The Δ evidence points
  at `Contract_Info` — both ₹51,500 gaps equal 2 × 25,750, the pro-rated 10-day rate of the one
  late-joining vehicle on each contract.

## 8. Plate exceptions — why nothing is auto-corrected

Two distinct populations, and only one of them is a typo:

| Class | What it is | Scale (July) | Effect |
|---|---|---|---|
| **B · Cross-contract** | the plate is a genuine `Contract_Vehicles` default of a **different** contract | 13 plates · 30 trips · **2,593 km** | KM lands on the **wrong contract**, so the wrong slab. Real money. This is engine attribution — vehicle-match must beat cluster × size. |
| **C · Look-alike** | typo-shaped, within edit distance 2 of a default of the same contract, and not a default anywhere | 16 plates · 40 trips · **1,508 km** | KM stays in the right contract. 5 plates fold to the correct look-alike; 11 fold elsewhere, so per-vehicle utilisation is wrong. |

Auto-correction is deliberately not shipped. `RJK10-18838` alone holds four pairs of **genuine**
defaults within edit distance 2 of each other — `GJ03CU0690`/`GJ03CU0907`, `GJ03CU0907`/`GJ03CU3905`,
`GJ33T4580`/`GJ33T4620`, `GJ33T4580`/`GJ33T4788` — and on `RJK10-20077` both `GJ03CU1556` and
`GJ03CU2156` are real defaults two characters apart. Any fuzzy rule would move real KM onto the wrong
real vehicle. Whitespace, case and 0-vs-O were separately ruled out as causes, so normalisation would
fix a problem that does not exist.

The MIS raises these as **WARN**, not BLOCK: the KM is already inside the slab, so no money is missing.
Ground corrects the plate at source; the long-term fix is constraining trip creation to the
vendor-submitted vehicle master.

## 9. The vendor-facing pack (menu 12)

Vendors never receive the working MIS sheet — `Cost_View_All` holds every other vendor's rates and
payables. `issueVendorPackFromMenu()` renders a separate clean spreadsheet from the model (never by
copying and stripping the working sheet), which you then send via File → Download → Microsoft Excel.

| Tab | Contents |
|---|---|
| `Billing Summary` | per contract: size, contracted vehicles, grouped KM slab, KM run, excess KM, rate, excess amount, fixed amount, adhoc amount, **zonal amount**, total payable · TOTAL PAYABLE · plain-English method notes · an "awaiting your confirmation" line when anything is unsettled |
| `Vehicle Wise KM` | V#, plate, active period, days, contracted KM, KM run, used %, trips, replacement note · replacements listed below in grey · contract total |
| `Trip Details` | the raw list the bill is built from: Date, **Trip id**, Contract, Vehicle, Size, Route, Challan type, Billing type, KM billed, Adhoc amount, **KM counted against**, Completed, Status |
| `Zonal Trips` | only when zonal rows exist: date, trip id, RFQ id, vehicle, size, planned route, actual route, type, amount |

Withheld on purpose: `adhoc_reason_system`, projection/sizing signals, the gate table, the Zonal paste
area and its instructions, and every other vendor's rows. The pack reads the source directly, so it does
not require the MIS sheet to have been generated for that vendor first.

## 10. Runbook

**One-time**
1. Paste `Code.gs` over the existing `Code.gs` in the *FM Carting - Panel* Apps Script project.
2. Add `Billing.gs` as a new script file in the **same** project.
3. Create a Google Sheet named *FM Carting - Billing MIS*, share to ops + finance as Viewer, and paste
   its id into `MIS_SHEET_ID` at the top of `Billing.gs`.
4. Reload the parent sheet so the menu picks up items 9–11.

**Each cycle (4–5 days after the contract period ends)**
1. Clear the gates — `Validation_Gates` must show `clear` on every contract.
2. Paste the zonal extract into the `Zonal` tab (all vendors together, one row per trip). Never cleared
   by Generate. Check the "Every zonal row matches a known vendor" gate afterwards.
3. **VALMO Panel → 10** to refresh `Cost_View_All` / `Validation_Gates` / `Exceptions` and read the
   all-vendor position, including zonal.
4. **VALMO Panel → 9** per vendor to inspect one vendor in detail (`Control` must show no BLOCK).
5. Check `Exceptions` blocks B and C.
6. **VALMO Panel → 12** per vendor to issue the pack, then File → Download → Microsoft Excel (.xlsx)
   and send. Menu 12 reads the source directly, so steps 3–4 are for you, not prerequisites.

Note: menu 9 holds **one vendor at a time** — generating for the next vendor clears and rewrites
`Control` / `Local` / `Adhoc` / `Summary`. `Cost_View_All`, `Validation_Gates` and `Exceptions` are
always all-vendor; `Zonal` is never touched; the parent sheet is never written to.
