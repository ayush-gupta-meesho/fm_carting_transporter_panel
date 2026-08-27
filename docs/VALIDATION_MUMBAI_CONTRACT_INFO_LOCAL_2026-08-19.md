# Mumbai `Contract_Info` vs `Local` — re-check, 19 Aug

Re-run against the live sheet (`1jqIL15Wu097FVfFbOq6fR-NBTVM-rfQ2UtkQpcOxN70`) after this week's edits.
Compared against my 18 Aug check. Every figure produced by running the real `Code.gs` + `Billing.gs`.

## What changed since 18 Aug

| | 18 Aug | 19 Aug |
|---|---:|---:|
| Contract_Info rows | 24 | **27** |
| Local rows | 81 | **84** |
| Contracted KM (15d) | 1,08,500 | **1,10,367** |
| Fixed value | ₹22,25,250 | **₹22,59,883** |

Three new part-period contracts, and one contract closed:

```
MUM7-18764-20260820-31   Buraq  7FT  1 veh  1,200 km  Rs 18,800   20-31 Aug (12 days)
MUM8-18764-20260820-31   Buraq  8FT  1 veh    800 km  Rs 19,000   20-31 Aug (12 days)
MUM8-20517-20260819-31   Ajay   8FT  1 veh    867 km  Rs 20,583   19-31 Aug (13 days)
MUM8-20682-20260817-31   Drivetech    1 veh      0 km  Rs      0   17-19 Aug  INACTIVE
```

`Node_Cluster_Map` also gained `ZB2`, `YE2`, `WE7` — two with `go_live_date` 20 Aug, matching the new
contracts. That lines up.

## Verdict

**The reconciliation is perfect — all 27 contracts, on vehicle count, slab and value.** Totals agree at
**84 vehicles · 1,10,367 km · ₹22,59,883** from both directions, and match the sheet's own pivot exactly.

**Two of last week's items are fixed. One is not, and it still blocks every vendor.**

| 18 Aug finding | 19 Aug |
|---|---|
| `MH04MR2302` on two vendors' contracts (Fedfox + Pune) | **fixed** — Pune now holds `MH16CD5065`; no cross-vendor duplicate remains |
| ÷2 vs 15/31 pro-rating | **resolved, and I was wrong** — see §2 |
| `fixed_monthly_value(15days)` header | **unchanged — still blocks all 11 vendors** |

---

## 1 · BLOCKER (unchanged) — the column is still named `fixed_monthly_value(15days)`

```
════ MENU 9, as the sheet stands ════
19434 Yah Yah    Rs 5,19,750   [BLOCK]      20882 Bharat     Rs   77,500   [BLOCK]
18764 Buraq      Rs 5,36,800   [BLOCK]      18722 Shree      Rs   45,000   [BLOCK]
20517 Ajay       Rs 4,19,083   [BLOCK]      20703 Apex       Rs   43,000   [BLOCK]
20426 Ssk        Rs 3,18,500   [BLOCK]      19280 Pune       Rs   23,750   [BLOCK]
20226 Fedfox     Rs 1,86,750   [BLOCK]      20682 Drivetech  Rs        0   [BLOCK]
19252 Sk         Rs   89,750   [BLOCK]
════ 11 BLOCK, 0 WARN ════
```

`_readTab()` matches columns by header name. The schema column is `fixed_monthly_value`; the sheet says
`fixed_monthly_value(15days)`. The engine finds no such column, reads **0**, and the reconciliation gate
blocks. **The values are all correct** — they match Σ `monthly_rate` to the rupee.

Delete the `(15days)` suffix and re-run: **11 BLOCK → 1 BLOCK** (the remaining one is Drivetech, §3).

## 2 · CORRECTION to my 18 Aug note — the pro-rating is right

On 18 Aug I flagged ÷2 as **3.33% richer than a true 15/31** and put ₹71,782 on it. **That was wrong, and
the new part-period rows prove it.** Every row in the sheet is `rate-card tier × active_days / 30`:

| row | active_days | tier | ÷30 gives | ÷31 would give | sheet says |
|---|---:|---:|---|---|---|
| any 15-day row | 15 | 2,000 km @ ₹47,500 | 1,000 km · ₹23,750 | 967.7 km · ₹22,984 | **1,000 km · ₹23,750** |
| Ajay 19–31 Aug | 13 | 2,000 km @ ₹47,500 | 866.7 km · ₹20,583 | 838.7 km · ₹19,919 | **867 km · ₹20,583** |
| Buraq 20–31 Aug 8FT | 12 | 2,000 km @ ₹47,500 | 800 km · ₹19,000 | 774.2 km · ₹18,387 | **800 km · ₹19,000** |
| Buraq 20–31 Aug 7FT | 12 | 3,000 km @ ₹47,000 | 1,200 km · ₹18,800 | 1,161.3 km · ₹18,194 | **1,200 km · ₹18,800** |

**0 of 84 rows** fail the `tier × active_days / 30` test. So "divide by 2" was never a shortcut — it is
15/30, and the rate card is quoted per **30-day month**, which is the standard convention. Nothing to fix.
Ignore the ₹71,782 from the 18 Aug report.

## 3 · NEW — Drivetech's closed contract is inconsistent, and blocks its own MIS

`MUM8-20682-20260817-31` has been zeroed out and marked closed, but only in `Contract_Info`:

| | Contract_Info | Local |
|---|---|---|
| end date | **2026-08-19** | **2026-08-31** |
| active_days | — | **15** (the window is 3 days) |
| slab / value | `0 km` / `0` | `0.00` / `0` |
| status | **Inactive** | — |

Three separate problems:

- **The vehicle row still runs to 31 Aug** with `active_days = 15`, while the contract ended on the 19th.
  Any trip that vehicle runs from the 20th onward will still match this contract.
- **`contract_status = Inactive` trips its own gate** — *"Vendor has at least one Active contract in the
  period"* — so Drivetech BLOCKs even after the header fix. If the intent is "this vendor is out of the
  pilot", that is arguably the gate working. If the intent is "they ran 17–19 Aug and should be paid for
  it", then the slab and value should not be 0.
- **`pegged_km_slab` is `0.00`** where every other row is `"N,NNN km"`. Cosmetic, but it means the column
  now holds three different formats.

**Decide which it is:** vendor exited (leave it, accept the BLOCK, and shorten the vehicle row's end date),
or vendor ran three days (set slab and value to `tier × 3/30` and keep the contract Active).

## 4 · NEW — `MH04LY5943` is on two contracts

| contract | day1_order | slab | value | window |
|---|---:|---:|---:|---|
| `MUM8-20517-20260817-31` | 3 | 1,500 km | ₹27,000 | 17–31 Aug |
| `MUM8-20517-20260819-31` | 7 | 867 km | ₹20,583 | 19–31 Aug |

Both are Ajay, so this is **not** the cross-vendor leak we fixed this week — but it is still a problem:
**the two windows overlap 19–31 Aug**, so for 13 of the 15 days this vehicle is contracted twice, for
₹47,583 in total. Trip attribution keys on `vehicle_number`, so every trip it runs from the 19th matches
both contracts.

Either the new contract is a *different* vehicle whose plate was copied by mistake, or `MUM8-20517-20260817-31`
should be shortened to end on the 18th. It cannot be both as written.

## 5 · `day1_order` does not start at 1 on the three new contracts

```
MUM7-18764-20260820-31   [2]    <- one vehicle, numbered 2
MUM8-18764-20260820-31   [11]   <- one vehicle, numbered 11
MUM8-20517-20260819-31   [7]    <- one vehicle, numbered 7
```

The numbers look like they were carried over from the parent contract's sequence. No money moves —
`day1_order` is only used for sorting — but the panel labels defaults **V1, V2, V3…** by position, so the
vendor will see **V1** against a `default_vehicle_id` ending `_11`. Renumber each to `1`.

## 6 · Zonal — all three unchanged from 18 Aug, all three still wrong

```
MIG-FM-Aug-Zonal-EJN-MIS-RFQ-0001
MIG-FM-Aug-Zonal-EAG-QCT-MIS-RFQ-0001     <- same sequence number
MIG-FM-Aug-Zonal-EBR-MIS-RFQ-0001         <- and again
```

- **All three end `-RFQ-0001`.** A zonal trip has no `contract_id` — its `rfq_id` **is** the contract
  reference — so if the engine ever keys on the sequence number, three vendors' money merges onto one card.
  They are distinguishable only by the route text in the middle.
- **EBR: `round trip km` 247 is banded `0-250` but priced at ₹13.5**, which is the 250-500 rate for 7FT
  (0-250 is ₹14.0). The rate follows `vendor_km` (260); the band label follows `round trip km` (247).
- **EJN: `round trip km` 478 vs `vendor_km` 500** — 4.7% apart, and the ₹14.0 rate used is the 500+ tier,
  not the ₹14.5 for 250-500. Again the rate tracks `vendor_km`.

Zonal 15-day total is **₹2,58,375**, consistent with `vendor_km` throughout — so the money is internally
coherent. What is not settled is **which distance is contractual**, and the band labels contradict it.

---

## What passed

- **All 27 contracts reconcile exactly** to the 84 vehicle rows on count, `total_km_slab` and
  `fixed_monthly_value`, and the totals match the sheet's own pivot (84 / 1,10,367 km / ₹22,59,883).
- **All 84 rows conform to the rate card** at `tier × active_days / 30` — including the three new
  part-period rows and both the 12Hr and 24Hr cards. Zero exceptions.
- **`ex_km_rate` matches the card** on all 27 (7FT ₹8, 8FT ₹10, 10FT ₹12, 14FT ₹14).
- **No orphan vehicle rows**; no duplicate `contract_id`; `default_vehicle_id` unique across all 84.
- **All plates in standard format** — no placeholders.
- **Dates are real date values** on both tabs; `active_days` matches the window on 26 of 27 contracts
  (Drivetech is the exception, §3).
- **The cross-vendor plate duplicate is gone** — `MH04MR2302` now sits only on Fedfox.
- `MUM7-19434-…-24H` now stores `total_km_slab` as a plain `6000` rather than `"6,000 km"` — the right
  direction, though the other 26 are still text.

## Fix order

1. **Rename `fixed_monthly_value(15days)` → `fixed_monthly_value`** — one edit, 11 BLOCK → 1
2. **Resolve Drivetech** — exited, or paid for 3 days? Then align the vehicle row's end date and `active_days`
3. **Resolve `MH04LY5943`** — wrong plate on the new contract, or shorten the old one
4. **Renumber `day1_order` to 1** on the three new single-vehicle contracts
5. **Give the three zonal RFQs distinct sequence numbers**, and settle `round trip km` vs `vendor_km`
6. Retype the KM columns as numbers (`1500`, not `"1,500 km"` / `0.00`)

---

# ADDENDUM — re-check with the header blocker set aside

Re-run with `fixed_monthly_value(15days)` renamed, so the header issue stops masking everything behind it.
**This is where the real state of the data shows.**

## All 11 gates now clear for 10 of the 11 vendors

```
19434 Yah Yah      Rs 5,19,750   all 11 clear      20882 Bharat     Rs   77,500   all 11 clear
18764 Buraq        Rs 5,36,800   all 11 clear      18722 Shree      Rs   45,000   all 11 clear
20517 Ajay         Rs 4,19,083   all 11 clear      20703 Apex       Rs   43,000   all 11 clear
20426 Ssk          Rs 3,18,500   all 11 clear      19280 Pune       Rs   23,750   all 11 clear
20226 Fedfox       Rs 1,86,750   all 11 clear      20682 Drivetech  Rs        0   1 NOT CLEAR
19252 Sk           Rs   89,750   all 11 clear
                                       total Rs 22,59,883  (= the sheet's own pivot)
```

Gate by gate across all 11 vendors:

| gate | clear | not |
|---|---:|---:|
| Contract_Vehicles row count = `no_of_vehicles` | 11 | 0 |
| Σ `pegged_km_slab` = `total_km_slab` | 11 | 0 |
| Σ `monthly_rate` = `fixed_monthly_value` | 11 | 0 |
| Every Regular non-default trip folds to a valid default | 11 | 0 |
| No duplicate or blank (contract_id, vehicle_number) | 11 | 0 |
| **Vendor has at least one Active contract in the period** | 10 | **1 — Drivetech** |
| No look-alike plates needing review | 11 | 0 |
| No plate running against another contract | 11 | 0 |
| Every zonal row matches a known vendor | 11 | 0 |
| Every zonal REGULAR trip carries an RFQ ID | 11 | 0 |
| Every trip_date sits inside its contract window | 11 | 0 |

## NEW FINDING — two gates should have caught `MH04LY5943` and neither does

This is the more important discovery. `MH04LY5943` sits on two overlapping Ajay contracts:

| contract | window | active_days | slab | value |
|---|---|---:|---:|---:|
| `MUM8-20517-20260817-31` | 17–31 Aug | 15 | 1,500 km | ₹27,000 |
| `MUM8-20517-20260819-31` | 19–31 Aug | 13 | 867 km | ₹20,583 |

**One physical vehicle, ₹47,583 combined, contracted twice for 13 of the 15 days.** Yet both plate gates
report clear. Proven why:

**`No duplicate or blank (contract_id, vehicle_number)` is scoped WITHIN one contract.** `Billing.gs:997`
resets `seen = {}` per contract. Demonstrated by inserting the same plate twice on a *single* contract:

```
same plate twice on the SAME contract -> BLOCK: MUM8-20517-20260817-31 / MH04MH1268
same plate on TWO contracts           -> clear
```

**`No plate running against another contract` is TRIP-derived.** It reads `c.nearMiss[].homeOf`, which is
only populated by trips. Measured: `Trip_Level` has **0 rows**, `Σ nearMiss` = **0**, so the gate is
vacuously clear.

```
Trip_Level rows: 0
Σ nearMiss entries across Ajay contracts: 0
```

So the one window in which a master-data duplicate is cheap to fix — **before any trips exist** — is
exactly the window in which no gate can see it. Once Mumbai trips start landing the second gate will fire,
but by then the money has already moved.

**Worth adding: a master-data plate-uniqueness gate** that checks `(vehicle_number)` across all contracts
of a vendor whose windows overlap, independent of trips. Ten lines in `runGates`, and it would have caught
this today. It would also have caught last week's `MH04MR2302` cross-vendor duplicate before it was found
by hand.

## The contrast worth noting — Buraq did the same thing correctly

Both vendors added a vehicle mid-period. Same pattern, one right and one wrong:

```
18764 | 7 FT | 12hr
   MUM7-18764-20260817-31   17-31 Aug   MH05EL6309
   MUM7-18764-20260820-31   20-31 Aug   MH04LQ7801     -> distinct plates, genuine addition, fine
18764 | 8 FT | 12hr
   MUM8-18764-20260817-31   17-31 Aug   MH04KU7535 … MH04MH4534  (10 plates)
   MUM8-18764-20260820-31   20-31 Aug   MH04MH9429     -> distinct plate, fine
20517 | 8 FT | 12hr
   MUM8-20517-20260817-31   17-31 Aug   MH04MH1268, MH05FJ5752, MH04LY5943, …
   MUM8-20517-20260819-31   19-31 Aug   MH04LY5943     -> SAME PLATE, windows overlap
```

So the mid-period-addition mechanism itself works. Ajay's row is a copy-paste of an existing plate, not a
flaw in the approach.

## Everything else that passed

- **All 27 contracts reconcile to the 84 vehicle rows** on count, slab and value; vendor-level totals match
  the sheet's pivot on all 11 vendors; grand total **₹22,59,883** identical from both directions.
- **All 84 rows conform to the rate card** at `tier × active_days / 30` — zero exceptions across the 12Hr
  and 24Hr cards and all four part-period windows (15, 13 and 12 active days).
- **`ex_km_rate` correct on all 27** (7FT ₹8, 8FT ₹10, 10FT ₹12, 14FT ₹14).
- **Contract IDs fully self-consistent on all 27** — size prefix matches `vehicle_size`, the oracle inside
  the ID matches the `vendor_oracle_id` column, the `-24H` suffix matches `hours_slab`, and **the date
  embedded in the ID matches `contract_start_date`** on every row including the three new ones.
- **All 84 plates in standard format**; **84 distinct `default_vehicle_id`**; no orphan vehicle rows.
- **No contract window falls outside 17–31 Aug.**

## Still open, unchanged from the main report

- **Drivetech** — `Inactive`, ₹0, contract ended 19 Aug, but its vehicle row still runs to 31 Aug with
  `active_days = 15`. This is the one remaining gate failure. Decide: exited, or paid for 3 days.
- **`day1_order`** reads 2, 11 and 7 on the three new single-vehicle contracts.
- **Zonal** — all three RFQ ids end `-RFQ-0001`; EBR banded `0-250` at 247 km but priced at the 250-500
  rate; EJN `round trip km` 478 vs `vendor_km` 500.
- **`vendor_name`** is `Ajay Enterprise` in `Contract_Info` and `Ajay Enterprises` in the pivot.
- **KM columns hold two formats** — `"N,NNN km"` text on 83 rows and plain `0.00` on Drivetech's.
