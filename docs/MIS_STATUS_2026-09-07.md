# Re-check against the live sheet, 07 Sep 2026

Re-exported `FM Carting - Panel` fresh from Drive and re-ran the real engine (`Code.gs` + `Billing.gs`)
over it. 38 billable contracts, 16 vendors, 4,897 `Trip_Level` rows (271 zonal, 4,626 local).

## FIXED — the lost resolutions bug is closed, and the live data proves it

`Trip_Level` now carries `total_trip_km_resolved` and `adhoc_amount_resolved` at the end of the row,
and they are populated. Checked every resolved dispute against the trip row it belongs to:

| | |
|---|---:|
| disputes carrying a `resolved_km` | 373 |
| stored correctly in `Trip_Level.total_trip_km_resolved` | **373** |
| stored but with a different value | **0** |
| not stored at all | **0** |

371 of the 373 are a real revision (the resolved KM differs from the system KM); 2 resolved to the same
number. All 378 resolved disputes sit at `Pending Reconfirmation`, so the vendor is being asked to
reconfirm — and because `_classifyTrip` reads `total_trip_km_resolved` ahead of `total_trip_km`, what he
now sees is the **revised** figure. That was the original complaint and it is gone.

This also tells us `Code.gs` and `Actions.gs` are already live in Apps Script — the columns could not
exist and be filled otherwise.

## FIXED — `Hr` is now on every Placement Failure row

All 21 rows carry an hours slab. The format is `12 Hr` / `24 Hr` (space, capital H) rather than `12hr`,
which is fine: `_pfKey` lowercases and strips whitespace, so both spellings are one key.

## NOT FIXED — the dates, and that is still blocking all 5 vendors

Every one of the 21 `trip_date` cells is still **`dd-mm-yyyy` text** (`17-08-2026`). `_pfDate` rejects
those by design rather than guessing, so the tab still reads as **21 rows, 0 priced, ₹0** and the same
5 vendors are blocked: Buraq, Yah Yah, Logistics link, Ssk Roadlines, Bharat Enterprises.

Retyping the dates is the single highest-value action left. Measured on the live export:

| tab state | rows priced | deduction | vendors blocked |
|---|---:|---:|---:|
| as it stands today | 0 | ₹0 | 5 |
| dates retyped as real date cells | 17 | ₹29,167 | 3 |
| + the two 2028 rows corrected to 2026 | 19 | ₹32,300 | 2 |
| + the two rows below | **21** | **₹36,100** | **0** |

## NOT FIXED — two rows, and one of them is new

**Rows 20 and 21 are still dated 2028** (`30-08-2028`, `31-08-2028`, Logistics link). Correct to 2026 and
they attach to `MUM7-20271-20260822-31`, worth ₹3,133.

**Row 3 is a new problem introduced by filling `Hr`.** It reads Yah Yah / **10FT** / 1,500 km / **24 Hr**,
and Yah Yah has no 10 FT 24hr contract at all:

```
MUM10-19434-20260817-31      10 FT   12hr   slab  1500
MUM7-19434-20260817-31        7 FT   12hr   slab 15500
MUM8-19434-20260817-31        8 FT   12hr   slab  4000
MUM7-19434-20260817-31-24H    7 FT   24hr   slab  6000   <- their only 24hr contract is 7 FT
```

So `24 Hr` on a 10FT row resolves to nothing. It should be **12 Hr** (or the FT size is what is wrong).

**Row 1 is the one we already knew about**, and the masters now settle it. Buraq has two 7 FT / 12hr
contracts:

```
MUM7-18764-20260817-31    slab 1000 km    17 Aug -> 31 Aug     <- date fits, slab does not
MUM7-18764-20260820-31    slab 1200 km    20 Aug -> 31 Aug     <- slab fits, date does not
```

The row says 17 Aug / 1,200 km, which matches neither. **The slab is the wrong field**: 17 Aug + 1,000 km
resolves cleanly to `MUM7-18764-20260817-31` with no duplicate collision, whereas moving the date to
20 Aug collides with the existing 20 Aug row and trips the duplicate gate. Worth confirming with ground,
but 1,000 km is the reading that works.

`placement_failure_paste_2026-09-07.csv` in the repo root is the corrected tab, ISO dates and all four
fixes applied, same six headers so it drops straight in.

## Result with all of it applied

21 of 21 rows priced, **₹36,100.23** deducted across 8 contracts, **0 of 16 vendors blocked**:

```
MUM7-18764-20260817-31    Buraq            1 vehicle-day     Rs  1,433
MUM7-18764-20260820-31    Buraq            1 vehicle-day     Rs  1,567
MUM10-19434-20260817-31   Yah Yah          1 vehicle-day     Rs  2,367
MUM7-19434-20260817-31    Yah Yah          3 vehicle-days    Rs  4,567
MUM8-19434-20260817-31    Yah Yah          2 vehicle-days    Rs  3,600
MUM7-20271-20260822-31    Logistics link   7 vehicle-days    Rs 10,967
MUM14-20426-20260817-31   Ssk Roadlines    1 vehicle-day     Rs  2,600
MUM8-20882-20260817-31    Bharat           5 vehicle-days    Rs  9,000
```

## The Zonal tab in FM Carting - MIS

Its Jul–Aug paste appears to have been cleared, and it does not matter: `Trip_Level` carries 271 rows at
`route_scope = Zonal`, so zonal money comes from there and `_misReadZonalAll()` is never reached. Menu 9
recreates the tab if missing and otherwise leaves it alone.

## Scripts

`MIS_SHEET_ID` is set (`Billing.gs` line 39). Suite: **940 assertions across 17 harnesses, all passing.**
`Billing.gs` is the file that has actually changed since what is deployed — paste all three anyway so
the editor and the repo cannot drift.
