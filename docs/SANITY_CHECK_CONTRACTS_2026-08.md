# Sanity check — Contract_Info & Contract_Vehicles, "FM Carting - Panel"

Checked **2026-08-07** against the live sheet. Scope: the **10 real contracts** (oracles 18838, 13551,
20077, 18635) and their **72 Contract_Vehicles rows**. The 3 `ORC-4521` demo contracts and their 7 vehicle
rows are excluded throughout.

Every figure below was produced by running the real `Code.gs` + `Billing.gs` over the live sheet, not by
reading it.

---

## Verdict

**`Contract_Vehicles` is clean. `Contract_Info` has 5 problems, 2 of which are blockers.**

That asymmetry is itself the most useful finding: wherever the two tabs disagree, **Contract_Vehicles is
the one to trust**, because its `monthly_rate` forms an exact, self-consistent ladder that matches the
contract-id prefixes:

| id prefix | `monthly_rate` | implied size |
|---|---|---|
| `RJK8-…` | ₹49,440 | 8FT |
| `RJK10-…` | ₹64,890 | 10FT |
| `RJK17-…` | ₹83,430 | 17FT |
| `RJK24-…` | ₹97,850 | 24FT |

No exceptions across all 72 rows. So where `Contract_Info.vehicle_size` disagrees with the id prefix, the
id and the vehicle rows are right and the `vehicle_size` cell is wrong.

---

## 1 · BLOCKER — a duplicated `contract_id` is double-counting ₹3.34 L

`RJK17-13551-20260801-01` appears **twice** in `Contract_Info` — rows 10 and 11:

| Row | vehicle_size | no_of_vehicles | total_km_slab | ex_km_rate |
|---|---|---|---|---|
| 10 | 17FT | 3 | 7,000 | 15.45 |
| 11 | **14FT** | 1 | 3,000 | 13.39 |

Everything downstream groups by `contract_id`, so both rows resolve to the **same** 4 vehicle rows and the
**same** trips. Measured on the live data:

```
13551  Shiv Roadlines   rows=3  distinct ids=2  fixed=Rs 11,86,560
                        <<< DOUBLE-COUNTED Rs 3,33,720 and 10,000 km
```

Shiv Roadlines' fixed fee is inflated by **₹3,33,720** and its slab by **10,000 km**. It also shows as an
extra card on the vendor's panel.

**The 14FT contract has been given the 17FT contract's id.** It needs its own — presumably
`RJK14-13551-20260801-01`.

And its vehicle row is currently mis-tagged too. There are **4** vehicle rows under `RJK17-13551`, all at
₹83,430 (the 17FT rate), where `Contract_Info` declares only 3:

| Row | plate | day1_order | pegged_km_slab | monthly_rate |
|---|---|---|---|---|
| 55 | GJ14T3316 | 1 | 3,000 | 83,430 |
| 56 | GJ03BZ2348 | 2 | 2,000 | 83,430 |
| 57 | GJ03BY2547 | 3 | 3,000 | 83,430 |
| 58 | GJ27TD5428 | 4 | 2,000 | 83,430 |

3,000 + 2,000 + 2,000 = 7,000 — the 17FT slab. So **one of the two 3,000 km rows (55 or 57) is the 14FT
vehicle**, and it carries the 17FT rate of ₹83,430 rather than the 14FT rate.

**Fix — ops needs to tell us which plate is the 14FT.** Then:
1. change row 11's `contract_id` to `RJK14-13551-20260801-01`
2. move that plate's vehicle row to the new id
3. set its `monthly_rate` to the contracted 14FT rate (it is not ₹83,430)

---

## 2 · BLOCKER — `fixed_monthly_value` is blank on all 10 contracts

Every real contract has an empty `fixed_monthly_value`. The gate **`Σ monthly_rate = Contract_Info.fixed_monthly_value`** is a `BLOCK`, so **menu 10 will refuse to generate a vendor MIS for any of the four vendors.**

The money itself is safe — `localPayable` is built from `Σ monthly_rate` in `Contract_Vehicles`, not from
this column — so nothing is mis-billed. But the run is stopped.

**Fix — fill it from the vehicle rows:**

| contract_id | `fixed_monthly_value` should be |
|---|---|
| RJK10-18838-20260801-01 | 18,81,810 |
| RJK17-18838-20260801-01 | 83,430 |
| RJK24-18838-20260801-01 | 97,850 |
| RJK8-18838-20260801-01 | 3,46,080 |
| RJK10-13551-20260801-01 | 5,19,120 |
| RJK17-13551-20260801-01 | 2,50,290 *(3 vehicles, after finding 1 has been split out)* |
| RJK14-13551-20260801-01 | *the 14FT rate × 1* |
| RJK10-20077-20260801-01 | 3,24,450 |
| RJK8-20077-20260801-01 | 2,96,640 |
| RJK10-18635-20260801-01 | 7,13,790 |

---

## 3 · HIGH — `contract_start_date` is 8 January, not 1 August

All 10 rows read **`2026-01-08`**. The contract ids say `20260801`, the end date says `31-08-2026`, and
`Contract_Vehicles.start_date` says **`2026-08-01`** on all 72 rows. It is a day/month swap.

What it breaks:

- **`_misInPeriod`** gates a trip on `trip_date` inside the contract window. A window of 8 Jan – 31 Aug
  wrongly accepts anything from January onwards, so the "trip dated outside the contract period"
  exception can never fire.
- **`_projFields`** computes utilisation from `elapsed / totalDays`. With a 235-day window instead of 31,
  every projection and every OVER / UNDER / ON-TRACK badge on the admin view is wrong.
- The vendor sees **"8 Jan – 31 Aug 2026"** as their contract Duration.

**Fix — set all 10 to `2026-08-01`** and format the column as a date.

---

## 4 · HIGH — `contract_end_date` is text, and the code cannot read it

The cell holds the **string** `'31-08-2026'`, not a date. Proven against the live value:

```
Contract_Info end (TEXT)  "31-08-2026"  ->  *** UNPARSEABLE ***
Contract_Vehicles end     "2026-08-31"  ->  2026-08-31        (parses fine)
```

`_toDate()` returns nothing, so the contract has **no end date** as far as the code is concerned:
`_misInPeriod` cannot close the window, `_projFields` falls back to a 30-day default, and `_fmtRange`
gives up and prints the raw cell — the vendor's Duration currently renders as:

```
2026-01-08 00:00 – 31-08-2026
```

**Fix — retype all 10 as real dates: `2026-08-31`.** Select the column → Format → Number → Date. The
`Contract_Vehicles` dates are already correct, so copy that formatting.

---

## 5 · HIGH — Shivay Transport's two contracts have their details swapped

| Row | contract_id | CI says | Contract_Vehicles actually has |
|---|---|---|---|
| 12 | `RJK10-20077-…` | **8FT**, 6 veh, 13,000 km, ex ₹10.30 | 5 veh, 11,000 km, **₹64,890/veh (10FT)** |
| 13 | `RJK8-20077-…` | **10FT**, 5 veh, 11,000 km, ex ₹11.33 | 6 veh, 13,000 km, **₹49,440/veh (8FT)** |

Four fields — `vehicle_size`, `no_of_vehicles`, `total_km_slab`, `ex_km_rate` — are crossed between the two
rows. The rates in `Contract_Vehicles` settle it: `RJK10` is the 10FT contract and `RJK8` is the 8FT one,
exactly as the ids say.

**Fix — swap those four values between rows 12 and 13:**

| contract_id | vehicle_size | no_of_vehicles | total_km_slab | ex_km_rate |
|---|---|---|---|---|
| RJK10-20077-20260801-01 | **10FT** | **5** | **11,000** | **11.33** |
| RJK8-20077-20260801-01 | **8FT** | **6** | **13,000** | **10.30** |

After the swap, both contracts agree with their vehicle rows and both excess rates match every other
vendor's rate for that size.

---

## 6 · MEDIUM — Krushiv's excess rates look shifted one size band

Set against the rates every other vendor uses, Krushiv's four look displaced:

| size | rate elsewhere | Krushiv | matches the rate for… |
|---|---|---|---|
| 8FT | 10.30 | **21.63** | nothing — appears nowhere else |
| 10FT | 11.33 | **10.30** | 8FT |
| 17FT | 15.45 | **11.33** | 10FT |
| 24FT | — | **15.45** | 17FT |

Three of the four are exactly one band low. And Krushiv's 8FT is the **only** contract in the sheet whose
excess rate exceeds its own base rate — ₹21.63/km against a base of ₹20.97/km (₹49,440 ÷ 2,357 km), which
would make extra KM more expensive than contracted KM.

This may be a genuinely different commercial deal, so it is a **question, not a defect**. Please check the
four Krushiv rates against the RFQ. If they are correct as they stand, no change.

---

## 7 · LOW — vendor names differ between `Access_Control` and `Contract_Info`

| oracle | `Access_Control` | `Contract_Info` |
|---|---|---|
| 18838 | Krushiv enterprises | Krushiv Enterprise |
| 13551 | Shiv Road Line | Shiv Roadlines |

Cosmetic only — the join is on `vendor_oracle_id`, and the panel displays the `Contract_Info` name. Worth
aligning so an ops user searching either tab finds the same string.

---

## 8 · Note — no real trips have landed yet

`Trip_Level` currently holds **32 rows, all `ORC-4521` demo data**. None of the four real vendors has a
single trip:

```
Trip_Level rows by transporter_oracle_id: {"ORC-4521": 32}
```

So nothing is being mis-billed today. **This is the moment to fix the master data** — before the August
trips arrive and the errors above start moving money.

---

## What passed

`Contract_Vehicles`, all 72 rows, zero findings:

- no rows pointing at a contract that does not exist
- no blank vehicle numbers
- no duplicate `(contract_id, vehicle_number)` pairs
- **no plate appearing on more than one contract**
- `pegged_km_slab` and `monthly_rate` populated on every row
- `day1_order` complete, and unique within each contract
- `start_date` = 2026-08-01 and `end_date` = 2026-08-31 on every row, `active_days` = 31 throughout
- `default_vehicle_id` populated on all 72
- every plate matches the standard format

And on `Contract_Info`: `contract_status` is `Active` on all 10, `ex_km_rate` is populated everywhere, and
7 of the 10 contracts reconcile exactly against their vehicle rows on both vehicle count and slab.

---

## Fix order

1. **`fixed_monthly_value`** on all 10 — unblocks MIS generation (§2)
2. **`contract_start_date` → 2026-08-01** and **`contract_end_date` → a real date 2026-08-31** (§3, §4)
3. **Swap the four Shivay fields** between rows 12 and 13 (§5)
4. **Split the 14FT contract off `RJK17-13551`** — needs ops to name the plate (§1)
5. **Confirm Krushiv's four excess rates** against the RFQ (§6)
6. Align the two vendor names (§7)

Then run **menu 9** and confirm `Validation_Gates` comes back clear for all four vendors before any
August billing.
