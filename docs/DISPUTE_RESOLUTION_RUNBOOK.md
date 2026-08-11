# Dispute resolution — who does what, step by step

**The rule this whole flow is built on: nobody ever types into `Trip_Level` to resolve a dispute.**
Ops fills the `Disputes_Log` row, runs menu 4, and the script writes `Trip_Level`. That is verified by
`testkit/_flowtest.js`, which runs the real `applyResolutionsFromSheet()` and records every cell it
touches.

---

## The four roles

| Who | Where they work | What they do |
|---|---|---|
| **Data engine** | writes `Trip_Level` system columns | classifies the trip: scope, billing type, KM, amounts, challan |
| **Ground / AM** | `Trip_Level`, **before transfer only** | may correct `ground_confirmed`, `billing_type_final`, `replaced_default_vehicle_final`, `challan_type_final`. On a **zonal** row all of these are cleared by the `ZONAL_NOT_EDITABLE` guard — zonal is system-owned |
| **Vendor** | the Vercel panel | Confirms, or raises a dispute with proof and a callback number |
| **Ops / Finance** | **`Disputes_Log` only** | reads the claim, decides, fills the `resolved_*` columns, sets `dispute_status = Resolved` |
| **The script** | menu 4 | reads `Disputes_Log`, writes `Trip_Level`, re-surfaces the trip to the vendor |

---

## Step by step

### 1 · The vendor raises it (panel)
Opens the trip, **Raise Dispute**, ticks one or more issues, enters the corrected value, attaches proof
and a callback number, submits. The panel posts the claim; nothing is written to the sheet yet.

### 2 · Ops runs menu 4
`transferReadyTrips → drainActions → applyResolutionsFromSheet → syncToUpstash`. The dispute lands as a
**new row in `Disputes_Log`** with `dispute_status = Open`, the vendor's `claim_*` values, and an
`orig_*` snapshot of what the trip looked like when they disputed it. `Trip_Level.vendor_status` becomes
`Disputed` and the trip locks — the vendor cannot act on it again.

### 3 · Ops decides — **this is the only manual step, and it is in `Disputes_Log`**
Find the row. Read `claim_*` against `orig_*`. Then fill the columns for what you are agreeing to:

| To change | Fill in `Disputes_Log` | The script writes into `Trip_Level` | Scope |
|---|---|---|---|
| **Lift an RTO** (make the trip payable) | `resolved_challan_type` = e.g. `Forward Only` | `challan_type_final` | both |
| Local KM | `resolved_km` | `total_trip_km` | local only |
| Adhoc amount | `resolved_amount` | `adhoc_amount` | both |
| **Zonal amount** | `resolved_zonal_amount` | `zonal_rfq_amount_final` | zonal only |
| **Zonal RFQ id** | `resolved_rfq_id` | `rfq_id` | zonal only |
| Local contract id | `resolved_contract_id` | `contract_id` | local only |
| **Billing type** | `resolved_billing_type` (+ `resolved_amount` if flipping to Adhoc) | `billing_type_resolved` | **both** |
| Aggregate against a vehicle | `resolved_aggregate_vehicle` | `replaced_default_vehicle_final` | local only |

Always also fill **`resolution_note`** and **`resolved_by`** — they show on the vendor's dispute card.

Then set **`dispute_status = Resolved`**. That word is the trigger. Leave `resolved_at` **blank** — the
script stamps it, and a stamped row is never applied twice.

### 4 · Ops runs menu 4 again
The script applies every `Resolved` row whose `resolved_at` is blank, sets
`Trip_Level.vendor_status = Reconfirm`, `reconfirm_status = Pending Reconfirmation`, and syncs.

### 5 · The vendor sees the answer
The trip reappears as **Pending Reconfirmation** with **Accept** / **Re-dispute**, and *View dispute*
shows the note, who resolved it, and the corrected values.

- **Accept** → `Reconfirmed`, closed.
- **Re-dispute** → a fresh `Disputes_Log` row with `reconfirm_status = Re-disputed`. No dispute window
  applies to a re-dispute.

---

## The three things that will trip you up

**1. `resolved_at` must be blank for a resolution to apply.** It is the already-applied guard. If you
edit a resolution after it has run, clear `resolved_at` before re-running — otherwise the row is skipped
silently.

**2. Some `resolved_*` columns are ignored on zonal, on purpose.** `resolved_km` and
`resolved_aggregate_vehicle` do nothing on a zonal trip — there is no KM slab and no vehicle level. The
run log names every one it ignored, so check the menu-4 alert.

**3. An RTO trip pays nothing until the RTO is lifted.** `payable = rto ? 0 : …` is applied *before* any
resolved value, so `resolved_zonal_amount` or `resolved_km` alone on an RTO trip is a **no-op**. If you
are agreeing the trip should pay, you must also set `resolved_challan_type`. Set both in the same row.

---

## Worked examples

**A zonal Regular trip should have been Adhoc**
```
dispute_status         = Resolved
resolved_billing_type  = Adhoc
resolved_amount        = 6100          <- required if adhoc_amount is empty; the flip is REFUSED without it
resolution_note        = agreed, this ran as an adhoc movement
resolved_by            = ops@valmo
```
→ `billing_type_resolved = Adhoc`, `adhoc_amount = 6100`. The trip now bills ₹6,100.
Note it writes `billing_type_resolved`, **not** `billing_type_final` — `_final` belongs to ground, and a
resolution must not be forgeable by a ground edit.

**A trip was marked RTO but actually ran**
```
dispute_status         = Resolved
resolved_challan_type  = Forward Only
resolved_km            = 180           <- local only; a zonal trip already carries its RFQ amount
resolution_note        = challan was wrong, GPS confirms the forward leg
resolved_by            = ops@valmo
```
→ `challan_type_final = Forward Only` (+ `total_trip_km = 180` on local). The trip stops being RTO and its
KM re-enters the slab, or its zonal amount becomes payable.

**The zonal amount is wrong**
```
dispute_status         = Resolved
resolved_zonal_amount  = 6200
resolution_note        = RFQ rate revised from 1 Jul
resolved_by            = ops@valmo
```
→ `zonal_rfq_amount_final = 6200`.

**Rejecting a dispute** — set `dispute_status = Resolved`, fill only `resolution_note` and `resolved_by`,
leave every `resolved_*` value blank. Nothing changes on the trip; the vendor sees the reason and can
Accept or Re-dispute.

---

## One `Trip_Level` column exists purely for this flow

`billing_type_resolved` is written **only** by the two resolution appliers — no human types it, and ground
cannot reach it. It works the same way on **local and zonal**, so `resolved_billing_type` always lands in
one place and you never have to check a trip's scope to read `Trip_Level`.

The precedence, both scopes:

```
resolution (billing_type_resolved)  >  ground (billing_type_final, LOCAL only)  >  engine (billing_type_system)
```

Ground keeps its column and still reclassifies local trips exactly as before — a resolution simply
outranks it. On zonal ground never counted and still does not, which is rule (iii).

It exists as a separate column because `billing_type_final` is ground's: sharing it means a stray ground
edit on any row the transfer guard never saw silently re-prices the trip. That was measured, not assumed —
sharing the column moved **₹4,800** on the demo set and dropped the zonal total from ₹47,100 to ₹42,300.
And because a resolution cannot predate a dispute, menu 4 **clears** any `billing_type_resolved` it finds
on a row that has never been transferred, and flags it in `Ground_Confirmation_Log`.
