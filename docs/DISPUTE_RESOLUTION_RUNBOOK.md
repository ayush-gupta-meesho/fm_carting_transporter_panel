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

**3. An RTO trip pays nothing until the RTO is lifted — but ONLY if it is Regular.** Since **08 Sep 2026**
the rule has two parts:

| the trip | RTO effect |
|---|---|
| **Regular** (either scope, replacement included) | pays **nothing**, and no KM reaches the slab. `resolved_km` or `resolved_zonal_amount` alone is a **no-op** — you must also set `resolved_challan_type`. |
| **Adhoc** (either scope) | **is paid** its `adhoc_amount`, RTO or not. Nothing needs lifting. |

So on an **adhoc** dispute, never set `resolved_challan_type` just to make the trip pay — it already
does. Setting it changes what the trip *was* in order to fix what it is *worth*, and the panel no longer
attaches that claim for adhoc rows precisely so this cannot happen by accident.

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

## Resolving an "RTO only" dispute — the one that needs its own page

An RTO trip pays **nothing**, whatever its scope or billing type, and the classifier applies that *before*
any resolved value. So there are only two real outcomes, and one of them needs a second field.

### You agree it was not an RTO

Set **`resolved_challan_type`** to the challan that actually applies — normally `Forward Only`. What that
alone restores, measured against the real classifier:

| The trip | Paid while still marked RTO? | After `resolved_challan_type = Forward Only` alone | Second field needed? |
|---|---|---|---|
| **Local Regular** | ₹0 | RTO lifted, but **km = 0 → still pays nothing** | **YES — also set `resolved_km`** |
| **Local Adhoc** | **its `adhoc_amount`** (₹4,944 in the live example) | unchanged — ₹4,944 either way | no, and no challan lift either |
| **Zonal Regular** | ₹0 | pays its `zonal_rfq_amount` again (₹5,300) | no |
| **Zonal Adhoc** | **its `adhoc_amount`** (₹6,100) | unchanged — ₹6,100 either way | no, and no challan lift either |

The middle column is the 08 Sep 2026 change. **Both adhoc rows used to be ₹0 while marked RTO**, which
is why ops were lifting the challan to release the money; that is no longer necessary and should stop.

**Only Local Regular needs a second field**, and it always does: the engine writes `total_trip_km = 0` on
an RTO row, so lifting the RTO gives you a trip that is *eligible* for the slab and contributes zero. Set
`resolved_km` in the same row.

```
dispute_status         = Resolved
resolved_challan_type  = Forward Only
resolved_km            = 180            <- LOCAL REGULAR ONLY, and always required there
resolution_note        = challan was wrong, GPS confirms the forward leg
resolved_by            = ops@valmo
```

### You agree it was an RTO — reject it

```
dispute_status   = Resolved
resolution_note  = RTO confirmed against the challan and the GPS trace; not payable
resolved_by      = ops@valmo
```

Leave every `resolved_*` blank. The trip keeps paying ₹0. The vendor sees your reason and can Accept or
Re-dispute. **This is a real resolution, not a non-action** — record the reason properly, because it is
the only thing the vendor gets.

### "It was an RTO, but a part-run is payable"

**On a REGULAR trip you still cannot pay it while it stays marked RTO.** With the RTO in place,
`resolved_zonal_amount = 5300` or `resolved_km = 900` both still pay **₹0**.

Since 08 Sep 2026 there are two ways out, and the second is usually the honest one:

**(a) It really was a forward run — lift the RTO.** Use this only when the challan was wrong.

```
dispute_status         = Resolved
resolved_challan_type  = Forward Only
resolved_km            = 180            <- LOCAL REGULAR ONLY
resolution_note        = challan was wrong, GPS confirms the forward leg
resolved_by            = ops@valmo
```

**(b) It WAS an RTO and a part-run is payable — flip it to Adhoc and leave the RTO alone.** An adhoc
trip is paid whether or not it is an RTO, so this pays the agreed figure while keeping the record
truthful about what the vehicle actually did.

```
dispute_status         = Resolved
resolved_billing_type  = Adhoc
resolved_amount        = 2500
resolution_note        = returned from RJKS, part-run agreed at Rs 2,500; trip stays recorded as RTO
resolved_by            = ops@valmo
```

Prefer **(b)**. Option (a) rewrites the challan type, which is a statement about the run itself, and it
is what ops reached for on 03 Sep when they typed a rupee figure into `resolved_challan_type` — an
amount landing in a type column, and `resolved_amount` left blank, so the trip paid its original system
figure instead of the settled one. The challan column is not a payment switch.

Verified: that combination pays exactly ₹2,500 and keeps the KM out of the slab.

### The trap — a value that still begins with "RTO"

RTO is detected as *"the challan starts with `rto`"*, case-insensitively. So:

| `resolved_challan_type` | Result |
|---|---|
| `Forward Only` | RTO lifted ✓ |
| `Not RTO` | RTO lifted ✓ |
| `Forward + RTO` | RTO lifted ✓ (does not *start* with rto) |
| **`RTO cancelled`** | **still RTO — pays ₹0** |
| **`rto reversed`** | **still RTO — pays ₹0** |

If you write anything beginning with "RTO", the resolution silently does nothing. **Use `Forward Only`.**

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
