# Validation — "Contract & Vehicle details_Aug month.xlsx"

Checked **11 August 2026** against the real `Code.gs` + `Billing.gs`. Every figure below was produced by
running the code over the file, not by reading it. Three tabs: **Local** (72 vehicle rows),
**Contract_Info** (10 contracts), **Revised zonal** (7 RFQ rows).

---

## Verdict

**One blocker, and it is the same column as last time.** `fixed_monthly_value` is now populated — but it
is **wrong on 7 of the 10 contracts**, so `runGates()` returns **BLOCK for 3 of the 4 vendors** and
menu 10 will refuse to generate their MIS.

Everything else that was broken on 7 August is fixed. Measured:

| 7 Aug finding | now |
|---|---|
| duplicate `contract_id` `RJK17-13551` double-counting ₹3,33,720 | **fixed** — split into `RJK14-13551-20260801-01`, 1 vehicle, ₹90,640, `ex_km_rate` 13.39 |
| `contract_start_date` = 8 Jan | **fixed** — 1 Aug 2026 on all 10, and a real date, not text |
| `contract_end_date` = text `'31-08-2026'` | **fixed** — 31 Aug 2026, parses cleanly |
| Shivay's two contracts crossed on four fields | **fixed** — `RJK10` is now 10FT/5/11,000/11.33 and `RJK8` is 8FT/6/13,000/10.30 |
| `fixed_monthly_value` blank on all 10 | **populated, but 7 of 10 are wrong** — see §1 |
| Krushiv's excess rates shifted one band | **unchanged** — see §2 |

The vendor's Duration now renders correctly as **"1 Aug – 31 Aug 2026"**. `no_of_vehicles` and
`total_km_slab` reconcile **exactly** with the vehicle rows on all 10 contracts, and 10 of the 11 gates
are clear for every vendor.

```
════ MENU 9 — VALIDATION GATES, as the file stands ════
18838  Krushiv Enterprise    payable Rs 24,09,170   1 of 11 gates not clear
   [BLOCK] Σ monthly_rate = Contract_Info.fixed_monthly_value
        RJK10-18838 (Σ 1881810 vs CI 367401); RJK17-18838 (Σ 83430 vs CI 1974716);
        RJK8-18838 (Σ 346080 vs CI 121540)
13551  Shiv Roadlines        payable Rs  8,60,050   1 of 11
   [BLOCK] RJK10-13551 (Σ 519120 vs CI 531480); RJK17-13551 (Σ 250290 vs CI 264710)
20077  Shivay Transport      payable Rs  6,21,090   1 of 11
   [BLOCK] RJK8-20077 (Σ 296640 vs CI 305910); RJK10-20077 (Σ 324450 vs CI 336810)
18635  Balaji Road Wizards   payable Rs  7,13,790   0 of 11   ← the only clean vendor
```

---

## 1 · BLOCKER — `fixed_monthly_value` disagrees on 7 of 10 contracts

| contract_id | veh | `fixed_monthly_value` says | Σ `monthly_rate` of its vehicle rows | error |
|---|---:|---:|---:|---:|
| RJK10-18838-20260801-01 | 29 | 3,67,401 | **18,81,810** | −15,14,409 |
| RJK17-18838-20260801-01 | 1 | 19,74,716 | **83,430** | +18,91,286 |
| RJK24-18838-20260801-01 | 1 | 97,850 | 97,850 | ✓ |
| RJK8-18838-20260801-01 | 7 | 1,21,540 | **3,46,080** | −2,24,540 |
| RJK10-13551-20260801-01 | 8 | 5,31,480 | **5,19,120** | +12,360 |
| RJK17-13551-20260801-01 | 3 | 2,64,710 | **2,50,290** | +14,420 |
| RJK14-13551-20260801-01 | 1 | 90,640 | 90,640 | ✓ |
| RJK8-20077-20260801-01 | 6 | 3,05,910 | **2,96,640** | +9,270 |
| RJK10-20077-20260801-01 | 5 | 3,36,810 | **3,24,450** | +12,360 |
| RJK10-18635-20260801-01 | 11 | 7,13,790 | 7,13,790 | ✓ |

**No money is mis-billed.** `localPayable` is built from Σ `monthly_rate` in the vehicle rows, never from
this column — so the fixed fee that actually pays is correct at **₹46,04,100** across the four vendors. The
column's only job is the reconciliation gate, and it is stopping the run. (For the record, anyone reading
`Contract_Info` alone would total **₹48,04,847** — overstated by **₹2,00,747**.)

### Four of the seven are arithmetically impossible, which settles which side is wrong

All five vehicle rates share a common factor of **₹1,030**:

```
8FT 49,440 = 1030 × 48    10FT 64,890 = 1030 × 63    17FT 83,430 = 1030 × 81
14FT 90,640 = 1030 × 88   24FT 97,850 = 1030 × 95
```

So **any** sum of vehicle rates must be a multiple of ₹1,030. Testing every possible combination:

| contract | CI value | a multiple of 1,030? | reachable as *any* combination of the 5 rates? |
|---|---:|---|---|
| RJK10-18838 | 3,67,401 | **no** | **impossible** |
| RJK17-18838 | 19,74,716 | **no** | **impossible** |
| RJK8-18838 | 1,21,540 | yes | **impossible** |
| RJK8-20077 | 3,05,910 | yes | **impossible** |
| RJK10-13551 | 5,31,480 | yes | reachable (but not by *these* 8 vehicles) |
| RJK17-13551 | 2,64,710 | yes | reachable (but not by *these* 3) |
| RJK10-20077 | 3,36,810 | yes | reachable (but not by *these* 5) |

Four of the seven values **cannot be a vehicle-rate total at all**, whatever the fleet. Combined with
`no_of_vehicles` and `total_km_slab` reconciling exactly on all 10 contracts, the vehicle rows are right
and this one column is wrong.

### The two Krushiv values are on the wrong rows

Divide each `fixed_monthly_value` by its own size's rate and you get the vehicle count it implies:

| contract | CI value implies | vehicle rows say |
|---|---:|---:|
| RJK10-18838 (10FT) | **5.66 vehicles** | 29 |
| RJK17-18838 (17FT) | **23.67 vehicles** | 1 |

The 29-vehicle contract carries the small number and the 1-vehicle contract carries the ₹19.7 lakh one.
Not a clean swap — ₹19,74,716 is not ₹18,81,810 — so please have whoever filled these re-derive both from
the contract rather than moving the cells.

### The other three are small, consistent overs — possibly deliberate

| contract | over by | ÷ ₹10.30 |
|---|---:|---:|
| RJK8-20077 | ₹9,270 | 900 km |
| RJK10-13551 | ₹12,360 | 1,200 km |
| RJK10-20077 | ₹12,360 | 1,200 km |
| RJK17-13551 | ₹14,420 | 1,400 km |

Each over is an exact whole number of kilometres at ₹10.30/km. That is too tidy to be a typing slip — it
looks like a **KM allowance folded into the fixed value**. If that is intentional it belongs somewhere
other than `fixed_monthly_value`, because the gate compares that cell to the vehicle rows and will block
every month. **Please confirm with commercial before I change these four.**

**Fix:** set `fixed_monthly_value` to the Σ column above on all 7. The corrected file attached does exactly
that and all 44 gates then come back clear.

---

## 2 · HIGH — Krushiv's excess rates are still shifted one band

Unchanged from 7 August. Set side by side with every other vendor:

| size | everyone else | Krushiv | Krushiv's rate is actually the… |
|---|---:|---:|---|
| 8FT | 10.30 | **21.63** | nothing — appears nowhere else in the sheet |
| 10FT | 11.33 | **10.30** | 8FT rate |
| 17FT | 15.45 | **11.33** | 10FT rate |
| 24FT | — | **15.45** | 17FT rate |

Three of the four are exactly one band low. And Krushiv's 8FT is the **only** contract in the file whose
excess rate exceeds its own contracted rate per km — ₹21.63 against ₹20.97 (₹49,440 ÷ 2,357 km) — which
would make extra KM dearer than contracted KM:

```
RJK8-18838-20260801-01   8 FT   ex=21.63  base=20.97   <<< excess DEARER than contracted
```

Also note `RJK24-18838` (24FT) and `RJK17-13551` (17FT) both sit at 15.45, so a 24-footer's excess KM costs
the same as a 17-footer's.

This could be a genuinely different commercial deal, so it stays a **question, not a defect** — but it is
the second month it has been raised, so please settle it against the RFQ. I have **not** changed these in
the corrected file.

---

## 3 · MEDIUM — the `Revised zonal` tab has three problems that will break RFQ matching

A zonal trip has no `contract_id`; its **`rfq_id` is the contract reference**, and the panel keys each
zonal card on `ZONAL::<rfq_id>`. So an `rfq_id` that does not match the trip row exactly gets its own
card, its own line on the MIS, and its own subtotal.

### a · A non-ASCII arrow inside an `rfq_id`

```
MIG-FM-Aug-Zonal-EMG→ENH-RFQ-001
                    ^ U+2192, not a hyphen
```

The same row's `Route` column uses ASCII `EMG -> ENH -> RJKS`, so the two spellings already disagree
inside one row. Run through the real card builder:

```
rate card  -> "ZONAL::MIG-FM-Aug-Zonal-EMG→ENH-RFQ-001"
ascii form -> "ZONAL::MIG-FM-Aug-Zonal-EMG->ENH-RFQ-001"
same card?  false
```

If the data engine writes the ASCII form on the trip row, the vendor gets **two cards for one route** and
the money splits across them. URL-encoded it becomes `MIG-FM-Aug-Zonal-EMG%E2%86%92ENH-RFQ-001`, and it
will not survive any ASCII-only CSV round trip. **Use a plain hyphen.**

### b · `FRQ` instead of `RFQ`

```
MIG-FM-Aug-Zonal-EGZ-RTS-FRQ-002        <- the only one of the 7 spelt FRQ
```

Not fatal on its own — the code does not pattern-match the id — but it defeats any search or filter for
`RFQ` and will be typed correctly by someone downstream, at which point it stops matching.

### c · Row 3 is an exact duplicate of row 2

Both are `RYL-RTS · Shiv Roadlines · 10FT · 226 km · ₹3,750 · MIG-FM-Aug-Zonal-RYL-RTS-RFQ-004`, identical
in every column. **This is the same shape as last month's duplicated `contract_id`**, which
double-counted ₹3,33,720. If this tab is ever used as a rate lookup keyed on `rfq_id`, the duplicate
double-counts. If it is meant to represent two vehicles on the route, the rate card is the wrong place to
say so — it is one rate per RFQ.

### Minor, same tab

- `Vehicle size` is spelt four ways across 7 rows: `10FT`, `17FT`, `22 FT`, `8 FT`. Cosmetic (nothing
  joins on it) but worth normalising.
- **`22FT` appears nowhere else** — the local fleet ladder is 8 / 10 / 14 / 17 / 24 FT. Fine if zonal genuinely
  runs a 22-footer, since zonal bills a flat RFQ amount and needs no ladder entry.
- **No `vendor_oracle_id` column.** The tab names vendors only as text (`Shiv Roadlines`,
  `Krushiv Enterprise`). Both happen to match `Contract_Info` exactly today, but zonal attribution in the
  panel runs on `transporter_oracle_id` from the trip row — so add the oracle id here, or the rate card
  cannot be joined to anything programmatically.
- `monthly_rate`, `day_15_rate` and `vendor remarks` are blank on all 7 rows. Fine if unused; delete the
  columns if they are not going to be filled.
- `vendor_rate` vs `reg_rate × round trip km`: two rows match to the rupee, five are rounded up by ₹28–134.
  `vendor_rate` is presumably the negotiated figure and `reg_rate` indicative — worth one confirmation
  that `vendor_rate` is what pays.

  | route | km | reg_rate | km × rate | vendor_rate | diff |
  |---|---:|---:|---:|---:|---:|
  | RYL-RTS | 226 | 16 | 3,616 | 3,750 | +134 |
  | RDB-RKS | 390 | 20.5 | 7,995 | 7,995 | ✓ |
  | RDE-RJKS | 232 | 21 | 4,872 | 4,900 | +28 |
  | REB-RJKS | 250 | 24 | 6,000 | 6,000 | ✓ |
  | EMG→ENH | 402 | 14.5 | 5,829 | 5,900 | +71 |
  | EGZ-RTS | 245 | 15 | 3,675 | 3,800 | +125 |

- `dist_band` is correct on all 7 rows, though `REB-RJKS` sits exactly on 250 km and both bands
  (`0-250`, `250-500`) include it. Worth making the bands non-overlapping.
- These RFQ ids (`MIG-FM-Aug-Zonal-…`) use a different scheme from what is in the sheet today
  (`FM-Zonal-REB-RFQ-0005`). Not an error in this file — just confirm the engine will write **these exact
  strings** into `Trip_Level.rfq_id`, because that is the only thing the panel matches on.

---

## 4 · LOW — `day1_order` on `RJK17-13551` starts at 2

After the 14FT vehicle was correctly split out, the three remaining rows are numbered **2, 3, 4** — order 1
is unused:

| row | plate | day1_order | default_vehicle_id |
|---|---|---:|---|
| 49 | GJ03BZ2348 | 2 | `…RJK17-13551-20260801-01_2` |
| 50 | GJ03BY2547 | 3 | `…_3` |
| 51 | GJ27TD5428 | 4 | `…_4` |

The code only ever *sorts* on `day1_order`, so no money moves — but the panel labels defaults **V1, V2, V3**
by position, so the vendor sees **V1** next to a `default_vehicle_id` ending `_2`. That will generate a
support question during a dispute. Renumber to 1, 2, 3 — `default_vehicle_id` is a `CONCAT(A,"_",C)`
formula, so it follows automatically.

---

## 5 · LOW — a stray pivot table sits beside the data

Rows 5–16 of the **Local** tab carry a `contract_id / Count of vehicle_number` pivot in columns **M:N**,
outside the 9 real columns. `_readTab()` is header-based and row 1 is blank there, so it is ignored by the
code — but it will be pasted into the Google Sheet as junk next to live data, and the next person to widen
the tab will trip over it. Delete columns J:N before pasting.

---

## What passed

- **`Local`, all 72 rows, zero findings.** No orphan contract references, no blank plates, no duplicate
  `(contract_id, vehicle_number)`, **no plate on more than one contract**, no duplicate
  `default_vehicle_id`, every plate in the standard format, `pegged_km_slab` and `monthly_rate` populated
  throughout, `start_date` = 2026-08-01 / `end_date` = 2026-08-31 / `active_days` = 31 on every single row.
- **The rate ladder is exact and self-consistent:** 8FT ₹49,440 · 10FT ₹64,890 · 14FT ₹90,640 ·
  17FT ₹83,430 · 24FT ₹97,850, no exceptions across all 72 rows.
- **`vehicle_size` agrees with the id prefix on all 10 contracts** — the mismatches from last month are gone.
- **`no_of_vehicles` and `total_km_slab` reconcile exactly** with the vehicle rows on all 10.
- **No duplicate `contract_id`.** All 10 unique, all `Active`, all `Rajkot`, all `12hr`.
- **All dates are real date values**, not text — both tabs, all rows. `_toDate` parses every one, so
  `_misInPeriod` closes properly and `_projFields` gets a true 31-day window.
- **10 of the 11 gates are clear for every vendor**, and Balaji is clean on all 11.

---

## The corrected file

`Contract_Vehicle_details_Aug_CORRECTED.xlsx` applies the **17 mechanical fixes** and nothing else. A new
**Corrections** tab lists every one as *tab / cell / field / was / now / why*, and each changed cell is
tinted, so nothing is silent.

After it, the real gates return:

```
════ MENU 9 — VALIDATION GATES, corrected file ════
18838  Krushiv Enterprise    payable Rs 24,09,170   0 of 11 gates not clear
13551  Shiv Roadlines        payable Rs  8,60,050   0 of 11
20077  Shivay Transport      payable Rs  6,21,090   0 of 11
18635  Balaji Road Wizards   payable Rs  7,13,790   0 of 11
════ 0 BLOCK, 0 WARN ════
```

**Deliberately NOT changed** — these need a human decision, not a mechanical fix:

- Krushiv's four `ex_km_rate` values (§2) — possibly a different commercial deal.
- The four small `fixed_monthly_value` overs (§1) — they look like an intentional KM allowance. The
  corrected file sets them to Σ `monthly_rate` so the gate clears; **revert those four if commercial
  confirms the allowance is real**, and tell me where it should live instead.
- The `MIG-FM-Aug-Zonal-…` RFQ naming scheme itself — only the arrow, the `FRQ` typo and the duplicate row
  are corrected.

## Fix order

1. **`fixed_monthly_value` on the 7 contracts** — unblocks MIS generation for three vendors (§1).
   Re-derive the two Krushiv values from the contract rather than accepting Σ blindly.
2. **The three `Revised zonal` id problems** — arrow, `FRQ`, duplicate row (§3). Do this before the engine
   starts writing `rfq_id` onto trip rows, because after that a mismatch splits a vendor's money across
   two cards.
3. **Confirm Krushiv's four excess rates** against the RFQ (§2).
4. **Renumber `day1_order` on `RJK17-13551`** to 1–3 (§4).
5. **Add `vendor_oracle_id` to `Revised zonal`** so the rate card can be joined (§3).
6. **Delete columns J:N of the Local tab** before pasting (§5).

Then run **menu 9** and confirm `Validation_Gates` is clear for all four vendors. `Trip_Level` still holds
no real vendor trips, so this is still the free window to get the master data right.
