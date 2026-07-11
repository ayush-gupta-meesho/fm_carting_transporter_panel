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

## Month-end billing — out of this panel's scope
Billing (per-contract payable + per-contract vehicle-usage patterns) is computed in a **separate sheet**, not in this panel. The reference formula is `fixed_monthly_value + max(0, Σ regular non-RTO total_trip_km − total_km_slab) × ex_km_rate + Σ adhoc_amount`, sourced from `Trip_Level` (final columns) + `Contract_Info`, using only settled (Confirmed/Reconfirmed) trips per `Confirmation_Status_View`. Not built here.

## Date filter removed
The Trip-MIS and Vehicle-Level "Date" dropdowns were non-functional placeholders from the v5 mock and have been removed from both panels. (The contract *duration* in the L2 header is still shown from `Contract_Info`.)
