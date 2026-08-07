# Zonal / Local route scope — schema and rules

**Status: agreed 2026-08-07, not yet built.** Decisions 1–8 confirmed by Ayush. This document is the
contract between the data engine, the Apps Script backend, the Vercel panel and the Billing MIS.

Route scope is a **second axis alongside Regular/Adhoc**, not a third billing type. Every trip has
both a `route_scope` and a `billing_type`.

---

## 1. New columns — the complete set

Column **position is irrelevant to the code**: `_readTab()` finds columns by header name, and
`Actions.gs` writes via a header lookup (`_setCell`). So the order below is Ayush's chosen order,
placed for readability, and nothing breaks by inserting mid-table.

### `Trip_Level` — 4 new columns (39 total)

| Position | Column | Type | Written by | Values / notes |
|---|---|---|---|---|
| 9 (after `trip_cluster`) | `route_scope` | varchar | **engine (system)** | `Local` \| `Zonal`. Blank reads as `Local`. |
| 10 | `rfq_id` | varchar | **engine (system)** | the zonal RFQ this trip billed against. Blank for Local. |
| 25 (after `replaced_default_vehicle_system`) | `zonal_rfq_amount` | decimal | **engine (system)** | fixed payable for a Zonal + Regular trip. Blank/0 for Local. |
| 31 (after `challan_type_final`) | `zonal_rfq_amount_final` | decimal | **dispute resolution only** | written by the resolution appliers when an amount dispute is upheld. Ground can never type here. |

**No `route_scope_final`** — scope is system-defined (rule i). The ground-editable set stays at four:
`ground_confirmed`, `billing_type_final`, `replaced_default_vehicle_final`, `challan_type_final`.

**No `rfq_id_final`** — a corrected RFQ id is recorded in `Disputes_Log.resolved_rfq_id`. The amount is
what bills, so `zonal_rfq_amount_final` is sufficient on the trip row.

Zonal adhoc cost uses the existing **`adhoc_amount`** (rule ii). The live column is `adhoc_amount`,
not `adhoc_cost`.

### `Disputes_Log` — 7 new columns

Vendors can dispute billing type, amount and RFQ (decision 5), and the panel must be able to render
"was X, you claim Y" — which needs the original snapshotted, exactly as `orig_total_km` and
`orig_adhoc_amount` already are for local trips.

| Column | Type | Notes |
|---|---|---|
| `claim_zonal_amount` | decimal | what the vendor says the amount should be |
| `claim_rfq_id` | varchar | what the vendor says the RFQ should be |
| `orig_route_scope` | varchar | snapshot — written by `applyDispute()` |
| `orig_rfq_id` | varchar | snapshot |
| `orig_zonal_rfq_amount` | decimal | snapshot — without this the dispute card cannot show the before-value |
| `resolved_zonal_amount` | decimal | ground's answer → applied to `Trip_Level.zonal_rfq_amount_final` |
| `resolved_rfq_id` | varchar | ground's answer, audit only |

New `categories` values (no schema change): **`Wrong zonal amount`**, **`Wrong RFQ`**.

### `Ground_Confirmation_Log` — 1 new column

| Column | Type | Notes |
|---|---|---|
| `route_scope` | varchar | so a `ZONAL_NOT_EDITABLE` entry is self-explanatory and the log can be filtered by scope. `billing_before` / `billing_after` / `data_sent` / `partial_edit_flag` already exist and need no change. |

### `Confirmation_Status_View` — 1 new column

| Column | Type | Notes |
|---|---|---|
| `route_scope` | varchar | lets acceptance % be reported local vs zonal without joining back to `Trip_Level`. |

**Total: 13 new columns across 4 tabs.** Add them in one pass.

## 2. The amount matrix — scope × billing × RTO

| Route scope | Billing | RTO | Amount paid | KM into slab |
|---|---|---|---|---|
| Local | Regular | no | — (KM aggregates into the slab) | **Yes** |
| Local | Regular | yes | — | No (shown at 0 km) |
| Local | Adhoc | no | `adhoc_amount` | No |
| Local | Adhoc | yes | `adhoc_amount` | No |
| Zonal | Regular | no | `zonal_rfq_amount_final \|\| zonal_rfq_amount` | No |
| Zonal | Regular | **yes** | **₹0 — nothing is paid** (rule 8) | No |
| Zonal | Adhoc | no | `adhoc_amount` | No |
| Zonal | Adhoc | **yes** | **₹0 — nothing is paid** (rule 8) | No |

**Only Local + Regular + non-RTO KM ever aggregates into the grouped KM slab.** Zonal KM never
touches a slab, a vehicle row, or a utilisation %.

Billing formula per contract, unchanged in shape:

```
payable = fixed_monthly_value
        + MAX(0, Σ Local Regular non-RTO KM − grouped_km_slab) × ex_km_rate
        + Σ Local  adhoc_amount
        + Σ Zonal  zonal_rfq_amount   (non-RTO only)
        + Σ Zonal  adhoc_amount       (non-RTO only)
```

---

## 3. Classification — the shared classifier

`_classifyTrip()` in `Code.gs` gains the scope axis. On a zonal trip ground's `billing_type_final` is
ignored outright, so rules (i) and (iii) hold by construction rather than by guard alone:

```
scope    = route_scope || 'Local'                       // system only, no _final
isZonal  = lower(scope) === 'zonal'
billing  = isZonal ? billing_type_system                // ground edits ignored on zonal
                   : (billing_type_final || billing_type_system)
isAdhoc  = lower(billing) === 'adhoc'
rto      = (challan_type_final || challan_type) startsWith 'rto'  [+ the zero-km fallback]
zonalAmt = rto ? 0 : (zonal_rfq_amount_final || zonal_rfq_amount)
amount   = isZonal ? (isAdhoc ? (rto ? 0 : adhoc_amount) : zonalAmt)
                   : (isAdhoc ? adhoc_amount : null)
kmToSlab = !isZonal && !isAdhoc && !rto
```

---

## 4. Guards — `Actions.gs`

1. **Zonal trips are EXEMPT from the reclassification guard.** Not optional: 11 of the 14 zonal
   vehicles seen in July are not contract defaults, so without the exemption every zonal trip would be
   reverted to Adhoc and stamped `NEEDS_ATTRIBUTION_FIX`.
2. **New guard `ZONAL_NOT_EDITABLE`.** On a zonal row, if ground has set `billing_type_final` or
   `replaced_default_vehicle_final`, clear it, write `partial_edit_flag = Yes`,
   `ground_action_state = ZONAL_NOT_EDITABLE`, and a `data_sent` hint naming the engine as the place to
   fix it. Scope and billing on zonal are system outcomes.
3. **`applyResolutionsFromSheet()` is exempt from guard 2** for the amount, and only for the amount: an
   upheld dispute writes `zonal_rfq_amount_final` / `rfq_id_final`. It must **not** write
   `billing_type_final` on a zonal row — a billing-type dispute on zonal is fixed in the engine, not in
   the sheet.
4. The vehicle-dropdown validation (menu 8) skips zonal rows — `replaced_default_vehicle` is
   meaningless there.

---

## 5. Panel layout

Zonal trips carry a `contract_id`, so they get their **own card per contract**, separate from that
contract's local card:

- **Card label** — `<contract_id> · Zonal`, with a teal badge. Internal id `<contract_id>::ZONAL`.
- **L2 lands straight on the Trip tab; the Vehicle tab is hidden.** There is no vehicle-level
  definition for zonal. This reuses the existing `isAdhocBucket` mechanism, so it is a flag, not new
  navigation code.
- **Zonal adhoc** goes to a vendor-level bucket card `<oracle>_Zonal_Adhoc_Trips`, mirroring the
  existing `ADHOC-<oracle>` Other-Adhoc badge.
- Trip rows show a teal `Zonal` badge next to the Regular/Adhoc badge — two axes, both visible.
- A **Route filter (All / Local / Zonal)** in the Trip MIS.
- Local cards show a one-liner outside the slab: *"Zonal: N trips · ₹X — fixed per trip, not part of
  the KM slab."*
- Vendors can confirm and dispute zonal trips exactly as they do local ones, with the two new dispute
  categories available.

---

## 6. Mixed-use vehicles — no change, by decision

Three July vehicles drew a local fixed fee **and** ran zonal: `GJ10TY4293` (default on
`RJK8-18838`, ₹24,720/mo, zero local trips, 17 zonal trips ₹1,00,300), `GJ03BY2262`
(`RJK17-13551`, ₹41,715/mo, 14 zonal), `GJ03CU2168` (`RJK10-18838`, ₹32,445/mo, 1 zonal). Total
₹1.91 L of zonal on vehicles already on a local fixed fee.

**Decision: keep the current logic.** Those vehicles are being paid for the replacements run against
them, so the local fixed fee is earned regardless. No pro-ration, no roster change, no slab
adjustment. Recorded here so the question is not re-opened.

Side effect worth knowing: this is what the MIS `Exceptions` block D
("contracted but ran zero trips under its own plate") was flagging on `GJ10TY4293`. Once
`route_scope` lands, that exception explains itself.

---

## 7. CSV exports — there are two, both need the new fields

| Function | In | Today | Change |
|---|---|---|---|
| `downloadCSV()` | `index.html` ~line 943 | vendor trip export, built from the in-memory payload | add `Route scope`, `RFQ id`, `Zonal amount` columns; RTO zonal rows must export ₹0, matching the screen |
| `downloadAdminCSV()` | `index.html` ~line 1163 | admin utilisation export | zonal is excluded from utilisation by design, so add contract-level `Zonal trips` and `Zonal ₹` columns rather than per-vehicle ones |

Both build rows from the payload, so they inherit whatever `Code.gs` puts in it — the payload change is
the real work and the exports are a column list each.

## 8. Dispute resolution workflow

Two appliers write resolutions into `Trip_Level`, both via `ow()` (overwrite only where a `resolved_*`
value is present): the CSV import (`Actions.gs` ~line 331) and `applyResolutionsFromSheet()` (~line 385).
Both need the same two changes:

1. **Add** `ow('zonal_rfq_amount_final', resolved_zonal_amount)`.
2. **Gate** `ow('billing_type_final', resolved_billing_type)` on `route_scope != Zonal`. Today it writes
   unconditionally, which would let a resolution reopen the door rule (iii) closes. A billing-type
   dispute on a zonal trip is recorded and answered by fixing the engine, not by writing the sheet.

`resolved_km` / `resolved_aggregate_vehicle` are meaningless on a zonal row (no slab, no vehicle
mapping) — gate both the same way, so an over-filled resolution CSV cannot corrupt a zonal trip.

`resolved_rfq_id` stays in `Disputes_Log` only. `resolved_at` remains the already-applied guard.

## 9. MIS changes

- The `Zonal` tab flips from **manual paste to reading `Trip_Level`**, writing `source = trip_level`.
  Layout, the `SUMIFS`/`COUNTIFS` and the Summary line are unchanged — that was designed in.
- Zonal is **grouped by `rfq_id`** (decision 7). That separates the migration set
  (`MIG-FM-Aug-Zonal-…`, 3 ids in July) from standard (`FM-Zonal-…`, 6 ids) with no prefix logic.
- **No exception handling for planned ≠ actual route** (decision 6). 12 of 96 July trips differ, mostly
  node-order flips; they bill at the RFQ rate and the fix stays at RFQ source.
- The vendor MIS `Zonal` tab gains `rfq_id` grouping and an RTO marker showing ₹0 where rule 8 applies.

---

## 10. One open item

**Local + Adhoc + RTO currently pays `adhoc_amount` in full.** Rule 8 says a zonal RTO pays nothing;
the same argument arguably applies locally. There is exactly one live case —
`TR-97835183-4747` on `RJK17-13551-20260717-01`, Adhoc, challan `RTO only`, **₹4,944 paid**. Confirm
whether local adhoc RTO should also pay ₹0, or stay as-is.
