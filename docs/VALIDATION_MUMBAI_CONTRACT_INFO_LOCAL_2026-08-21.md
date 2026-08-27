# Mumbai contract details — `Contract_Info` + `Local` re-check, 21 Aug 2026

Sheet `1jqIL15Wu097FVfFbOq6fR-NBTVM-rfQ2UtkQpcOxN70` ("Mumbai contract details"),
**last modified 2026-08-21 09:30 IST**. Third pass on these two tabs (previous: 18 Aug, 19 Aug).

Method: rebuilt both tabs as CSV, ran the **real `Billing.gs` engine** — `_misReadSource` →
`buildBillingModel` → `runGates` — for all 11 oracle IDs, plus independent checks on plate uniqueness,
`day1_order`, `active_days` vs the date window, and the rate card.

Scripts: `/root/work/mum3/check.js`, `/root/work/mum3/zonal.js`, `/root/work/mum3gates_all.js`.

---

## Verdict

**Almost clean. Six of the seven things flagged on 19 Aug are fixed. Two problems left, one of which
still blocks every vendor.**

| | 19 Aug | 21 Aug |
|---|---|---|
| Contract_Info ↔ Local reconciliation (count / km / amount) | 27 of 27 clear | **27 of 27 clear** |
| `Contract_Info` totals | 84 veh / 110,367 km / ₹22,59,883 | **84 veh / 110,434 km / ₹22,61,466** |
| Real gates, all 11 vendors | 10 of 11 clear | **11 of 11 clear** *(header neutralised)* |
| `fixed_monthly_value(15days)` header | blocks 11 vendors | **still blocks 11 vendors** |

---

## 1 · BLOCKER — the column is still called `fixed_monthly_value(15days)`

This is the one item from 19 Aug that has **not** moved, and it is the only thing standing between this
file and a load.

`_readTab()` matches columns by **header name**. `fixed_monthly_value(15days)` is not
`fixed_monthly_value`, so the engine reads **₹0** for every contract. Re-run with the live header:

```
Σ monthly_rate = Contract_Info.fixed_monthly_value    0 clear / 11 not
  Yah Yah  : MUM10-19434-20260817-31 (Σ 35500 vs CI 0); MUM7-… (Σ 254500 vs CI 0); …
  Buraq    : MUM10-18764-20260817-31 (Σ 207500 vs CI 0); …
  … all 11 vendors, all 27 contracts
```

Rename the header to exactly **`fixed_monthly_value`**. The `(15days)` note belongs in a cell comment or
a `Terms` line, not in the header. With the header corrected, **all 11 gates clear for all 11 vendors** —
nothing else in either tab fails.

## 2 · HIGH — Drivetech's part-period row says three different things

`MUM8-20682-20260817-31` (Drivetech, 8 FT, MH04MR9976) is now Active with real money on it — good, the
zeroed/Inactive state from 19 Aug is gone. But the three fields disagree about how long it ran:

| field | value | implies |
|---|---|---|
| `start_date` … `end_date` | 2026-08-17 … 2026-08-19 | **3** days (inclusive) |
| `active_days` | **2** | 2 days |
| `pegged_km_slab` / `monthly_rate` | **67 km / ₹1,583** | **1** day |

The money is priced at one day. On the 8 FT `two_thousand` tier (₹47,500 / 2,000 km) under the file's own
`tier × active_days / 30` convention:

```
1 day  ->    67 km   Rs 1,583    <- what the sheet actually pays
2 days ->   133 km   Rs 3,167    <- what active_days claims
3 days ->   200 km   Rs 4,750    <- what the date window claims
```

Every other part-period row in the file is internally consistent on the **inclusive** reading, which is
what makes `2` wrong here:

| contract | window | days (incl.) | `active_days` | km | ₹ | checks out |
|---|---|---:|---:|---:|---:|:-:|
| MUM7-18764-20260820-31 | 20–31 Aug | 12 | 12 | 1,200 | 18,800 | ✅ 3000×12/30, 47000×12/30 |
| MUM8-18764-20260820-31 | 20–31 Aug | 12 | 12 | 800 | 19,000 | ✅ 2000×12/30, 47500×12/30 |
| MUM8-20517-20260819-31 | 19–31 Aug | 13 | 13 | 867 | 20,583 | ✅ 2000×13/30, 47500×13/30 |
| **MUM8-20682-20260817-31** | **17–19 Aug** | **3** | **2** | **67** | **1,583** | ❌ **priced at 1 day** |

**Decide how many days Drivetech actually ran and set all three fields to it.** If it is 3 days,
Drivetech is under-paid by **₹3,167** and 133 km. If it ran only on the 17th, the `end_date` should be
`2026-08-17` and `active_days` `1`.

The engine will not catch this on its own: `Contract_Info` and `Local` agree with each other (both say
₹1,583), so the reconciliation gate passes. Only the rate-card cross-check finds it.

---

## What got fixed since 19 Aug

- **`MH04LY5943` duplicate resolved.** It has moved off `MUM8-20517-20260817-31` (day1_order 3 is now
  `MH04KU1882`) and onto the new `MUM8-20517-20260819-31`. **84 rows, 84 unique plates, zero duplicates
  anywhere in the file** — and no plate on two contracts with overlapping windows.
- **Drivetech un-zeroed and set Active.** The `Vendor has at least one Active contract in the period`
  gate now clears for oracle 20682 (it was the one BLOCK on 19 Aug).
- **The Drivetech tab mismatch is gone.** Its `Local` row now ends 19 Aug, matching `Contract_Info`;
  on 19 Aug the vehicle row still ran to 31 Aug with `active_days 15`.
- **`day1_order` fixed on all three part-period contracts** — was 2 / 11 / 7, now `1`. All 27 contracts
  have contiguous `1..N`.
- **Zonal `rfq_id`s no longer contain the U+2192 arrow** and now use one prefix (`MIG-FM-Aug-Zonal-…`).
  All three are distinct strings.
- **The ÷2 vs 15/31 contradiction is settled** in favour of a 30-day month. `day_15_rate = monthly ÷ 2`
  on zonal and `tier × 15/30` on local are the same convention. Consistent throughout.
- **The schema is now complete.** `cluster`, `ex_km_rate`, `contract_start_date`, `contract_end_date`,
  `contract_status` are all on `Contract_Info`; `day1_order`, `active_days`, `default_vehicle_id`,
  `start_date`, `end_date` are all on `Local`. Dates are real date cells, not `dd-mm-yyyy` text.

---

## What passed, in full

Run with the header neutralised, all 11 oracle IDs:

```
19434  Yah Yah Transcarrier            Rs 5,19,750   all 11 clear
18764  Buraq Transcarriers             Rs 5,36,800   all 11 clear
20517  Ajay Enterprise                 Rs 4,19,083   all 11 clear
20426  Ssk Roadlines                   Rs 3,18,500   all 11 clear
20226  Fedfox Logistics                Rs 1,86,750   all 11 clear
19252  Sk Transport                    Rs   89,750   all 11 clear
20882  Bharat Enterprises              Rs   77,500   all 11 clear
18722  Shree Sadguru Krupa             Rs   45,000   all 11 clear
20703  Apex Business Solutions         Rs   43,000   all 11 clear
19280  Pune Logistics                  Rs   23,750   all 11 clear
20682  Drivetech                       Rs    1,583   all 11 clear
                                       -----------
                                       Rs 22,61,466   = Contract_Info sum, exactly
```

Also verified independently:

- **All 27 contracts reconcile** Contract_Info ↔ Local on vehicle count, `total_km_slab` and
  `fixed_monthly_value`. Zero mismatches. Totals agree to the rupee: 84 / 110,434 km / ₹22,61,466.
- **All 84 rows match the rate card** on `tier × active_days / 30`, for both km and amount, on the 12hr
  and 24hr cards — **except Drivetech** (§2). Nothing sits on a tier that doesn't exist.
- **`ex_km_rate` matches the card's `extra_km`** on all 27 contracts (7 FT → 8, 8 FT → 10, 10 FT → 12,
  14 FT → 14).
- **`contract_id` is internally consistent** on all 27: the size prefix matches `vehicle_size`, the
  oracle inside the ID matches `vendor_oracle_id`, the date inside the ID matches
  `contract_start_date`, and the `-24H` suffix appears exactly when `hours_slab = 24hr`.
- **Every vehicle window equals its contract window** on all 84 rows.
- **Every oracle maps to exactly one vendor name and back** within `Contract_Info`.
- No orphan `contract_id` in `Local`, no `Contract_Info` row without vehicles.

---

## MEDIUM / hygiene

**a · The in-sheet pivot is now stale.** It still shows Drivetech at `0 km / 0` and a Grand Total of
`84 / 110,367 km / ₹22,59,883`. `Contract_Info` now reads `84 / 110,434 km / ₹22,61,466` — the gap is
exactly Drivetech's 67 km and ₹1,583. Refresh the pivot or delete it; as it stands the two blocks in the
same file quote different totals.

Also note the pivot is **Local only** — zonal is not in it. Local ₹22,61,466 + zonal ₹2,58,375 =
**₹25,19,841** for 17–31 Aug.

**b · Vendor name mismatch between tabs.** The zonal tab says **`Ajay Enterprises`** (plural);
`Contract_Info` says **`Ajay Enterprise`** (singular). The pivot says `Fedfox Logistics Pvt. Ltd`
(no trailing period) against `Fedfox Logistics Pvt. Ltd.` in `Contract_Info`. Zonal has no
`vendor_oracle_id` column at all, so a name is the only join key available — and one of the three
does not join.

**c · Zonal still bills a km figure that isn't the measured distance.**

| route | `round trip km` | `vendor_km` billed | band label | effect |
|---|---:|---:|---|---|
| EJN→MIS (Ajay) | 478 | **500** | 250-500 | +22 km/day = **₹4,620** over 15 days |
| EAG→QCT→MIS (Pune) | 310 | 310 | 250-500 | ✅ consistent |
| EBR→MIS (Shree) | 247 | **260** | **0-250** | +13 km/day = **₹2,633**, and the band label is wrong for the billed km |

`vendor_rate` is `vendor_km × reg_rate + toll` on all three (tolls ₹1,110 / ₹590 / ₹520, ₹33,300 over
15 days), so the pricing arithmetic is self-consistent — it just runs off `vendor_km`, not
`round trip km`. **Decide which of the two columns is contractual and delete the other**, and re-band
EBR: it is billed at 260 km, which is the `250-500` band, not `0-250`.

**d · All three zonal `rfq_id`s still end `-RFQ-0001`.** They are distinct strings today only because
the route is embedded in the ID. The sequence number is doing no work, and any future truncation or
"last 8 characters" match collapses all three onto one card. Number them 0001 / 0002 / 0003.

**e · The Active-contract gate has no date guard.** Drivetech's window closed on 19 Aug but
`contract_status` reads `Active` — correct for billing August, and the gate only reads the status text.
It will need flipping to Inactive once August closes, or Drivetech reappears in September.

**f · Three km cell formats.** `"1,500 km"` (83 rows), a bare `6000` on
`MUM7-19434-20260817-31-24H`, and `67km` with no space on Drivetech. All parse, but pick one.

**g · Zonal vehicle size is `8FT` / `7FT`; local is `8 FT` / `7 FT`.**

---

## Fix order

1. **Rename `fixed_monthly_value(15days)` → `fixed_monthly_value`** — nothing loads until this is done (§1)
2. **Settle Drivetech's day count** and set window, `active_days` and money to the same number (§2)
3. **Refresh or delete the stale pivot** (§a)
4. **Fix `Ajay Enterprise` / `Ajay Enterprises`**, and add `vendor_oracle_id` to the zonal tab (§b)
5. **Pick `round trip km` or `vendor_km`** as contractual and re-band EBR (§c)
6. **Renumber the zonal RFQ IDs** 0001 / 0002 / 0003 (§d)
