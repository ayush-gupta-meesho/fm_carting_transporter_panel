# MIS pre-flight — what would block or spoil a run today

**4 Sep 2026.** The real `Billing.gs` engine run over the live sheet, for all **17 vendors / 41
contracts**, reporting every gate that is not clear. Not a review of the logic — an actual dry run.

Script: `/root/work/livegates.js` against a CSV export of the live workbook.

---

## Hard stops

### 1 · `MIS_SHEET_ID` is still empty — this alone stops everything

`Billing.gs` line 39 reads `var MIS_SHEET_ID = '';`. Menu 9 refuses outright:

> *Set MIS_SHEET_ID at the top of Billing.gs first.*

Nothing else matters until this is set. It has been outstanding since 11 Aug and is unrelated to
placement failure.

### 2 · The Placement Failure tab blocks 5 vendors — all 21 rows unresolved

| vendor | oracle | status |
|---|---|---|
| Buraq Transcarriers | 18764 | **BLOCK** + 2 warn |
| Yah Yah Transcarrier | 19434 | **BLOCK** + 2 warn |
| Logistics link | 20271 | **BLOCK** |
| Ssk Roadlines | 20426 | **BLOCK** + 2 warn |
| Bharat Enterprises | 20882 | **BLOCK** + 1 warn |
| the other 12 vendors | | clear or warn-only |

Four causes, in order of how much they cost:

- **`Hr` is blank on all 21 rows.** The column exists but nobody filled it. Without it a
  `19434 / 7 FT / 1500 km` row could be the 12hr contract or the 24hr one — ₹1,566.67 or ₹2,533.33 a
  day — so it refuses rather than guess.
- **Every `trip_date` is `dd-mm-yyyy` text.** Refused by name. `_toDate('05-08-2026')` genuinely
  returns **May**, so parsing it would be silently wrong rather than loudly refused.
- **Rows 20–21 are dated 2028.** Typo.
- **Row 2** (`18764 / 7 FT / 1,200 km` on 17 Aug) matches no contract — the 1,200 km contract starts
  20 Aug. Date or slab is wrong; only LH can say which.
- Plus the master-data fix: **`MUM7-20271-20260822-31` window** should be 22–31 Aug, not 23–25.

Fix those and the deduction is **₹31,533.57 across 18 vehicle-days**.

### 3 · The tab name and columns would have read as ZERO — now handled

The live tab is spelled **`Placement failure`** with a lower-case f, and carries LH's own headers
(`Oracle ID`, `FT Size`, `Slab`, `Hr`) rather than the schema's. `getSheetByName` is case-sensitive and
header matching is by name, so on the canonical spelling **both would have read as nothing** — and
nothing is indistinguishable from "no failures this month". That would have quietly paid out ₹31,533
of days nobody worked.

The engine now resolves the tab case-insensitively, accepts either set of column names, and **WARNs
loudly if it cannot find the tab at all**, naming the tabs it did see. `_pftest.js` §7b pins all of it.

---

## Not blocking, but worth looking at

### 4 · Look-alike plates — cosmetic, no money and no lost KM

Plates within edit distance 2 of a contracted plate (`GJ03CU0836` vs `GJ03CW0836`). An earlier draft of
this doc called this "KM on the wrong vehicle" and implied KM was stranded. That was wrong, and the
engine proves it:

| replacement trips (Regular, non-default) | trips | km |
|---|---:|---:|
| fold to a valid contracted vehicle | 1,155 | 82,742 |
| land unattributed | **0** | **0** |

Unattributed KM is **zero for every vendor**. The `Every Regular non-default trip folds to a valid
default` gate is clear for all 16 real vendors (the only prior hit was ORC-4521, the excluded demo).
No KM is lost and no extra KM is created — `replaced_default_vehicle` folds each one onto a plate that
is genuinely on the contract, and the MIS shows the fold on its own line.

Of the folded trips, **36 trips / 2,907 km** fold into a plate within two characters of the one that
ran — i.e. the same vehicle mis-keyed, folding back onto itself:

```
180 km   ran as GJ03CU0836  ->  folded into GJ03CW0836   (Krushiv Enterprise)
 68 km   ran as MH04LE7215  ->  folded into MH04LE2715   (Shree Sadguru Krupa)
 49 km   ran as GJ03CV2168  ->  folded into GJ03CU2168   (Krushiv Enterprise)
 33 km   ran as GJ03CU0130  ->  folded into GJ03CU0174   (Krushiv Enterprise)
```

That is a data-quality nit on the replacement line of the MIS, not a money or attribution problem.
**Do not hold an MIS for it.**

### 5 · Same plate under two vendors — real, and worth ₹13,104 in Mumbai

118 trips / 5,990 km run on a plate that is a contracted vehicle of a *different* vendor. Ground's
explanation is that vendors work an aggregator model and hire from the open market, so two vendors can
legitimately present the same plate. Three checks settle what this costs.

**a · No plate is a contracted (default) vehicle of two vendors.** Zero shared plates in
`Contract_Vehicles`, zero overlapping vehicle periods. So **no fixed charge is ever paid twice** for one
vehicle. This was the expensive failure mode and it does not exist.

**b · No KM is lost.** KM is bucketed by the trip's `contract_id`, never by plate, and the fold stays
inside that contract's default set. Whoever was engaged is billed; the plate does not move money by
itself.

**c · It shifts excess KM, and only where a contract is already over slab.**

| | excess-KM charge, all contracts |
|---|---:|
| as billed today (KM on the contract that engaged the vendor) | ₹80,514 |
| if KM followed the plate instead | ₹93,618 |
| **difference** | **₹13,104** |

Where the ₹13,104 sits:

| contract | vendor | reg km | slab | headroom | excess today | excess if plate-based |
|---|---|---:|---:|---:|---:|---:|
| `MUM7-18764-20260820-31` | Buraq | 1,556 | 1,200 | **−356** | ₹2,845 | ₹15,949 |
| `MUM7-19434-20260817-31` | Yah Yah | 14,047 | 15,500 | 1,453 | ₹0 | ₹0 |
| `RJK10-18838-20260801-01` | Krushiv | 49,509 | 66,000 | 16,491 | ₹0 | ₹0 |
| `RJK10-20077-20260801-01` | Shivay | 7,274 | 11,000 | 3,726 | ₹0 | ₹0 |
| `RJK8-18838-20260801-01` | Krushiv | 16,424 | 17,500 | 1,076 | ₹0 | ₹0 |
| `RJK8-20077-20260801-01` | Shivay | 9,204 | 13,000 | 3,796 | ₹0 | ₹0 |

- **Rajkot (Krushiv ↔ Shivay, 4,352 km): ₹0 either way.** Every affected contract sits under its pegged
  slab with 1,076–16,491 km of headroom, so which of the two absorbs the KM changes no rupee. It is a
  records question, not a billing one.
- **Mumbai (Yah Yah ← Buraq, 1,638 km): ₹13,104.** Buraq's `MUM7-18764` is already **356 km over** its
  1,200 km slab. Those 1,638 km are currently sitting on Yah Yah, which has 1,453 km of free headroom,
  so they cost nothing. Moved to Buraq they would all be excess. **We are billing ₹13,104 less than a
  plate-based reading would give** — correct if Yah Yah was the vendor engaged, an under-recovery if
  Buraq was.

The exposure is structural rather than a one-off: shared plates park KM on whichever vendor has slab
headroom, and the gap grows as vendors approach their slabs. It is ₹0 in Rajkot today only because
nobody there is near their slab.

**d · Four same-plate-same-day collisions** — one physical vehicle cannot serve two vendors' 12-hour
contracts on the same date, so at least one side is mis-keyed:

```
GJ03BZ2400  11 Aug   Shivay  AND  Krushiv
GJ03CU3010  13 Aug   Shivay  AND  Krushiv
GJ03CU3010  20 Aug   Shivay  AND  Krushiv
GJ10TY4219  18 Aug   Krushiv  AND  Shivay
```

All four are Rajkot, so ₹0 today — but they are the cleanest evidence for ground to check.
move money, because it changes which contract's slab the KM lands in.

### 6 · Rajkot Movers — 4 trips, 600 km in the slab but on no vehicle

Counted toward the contract total with nothing to attribute it to.

---

## Structural, and the one to fix before September

### 7 · There is no month selector, and nothing is ever closed

The MIS period is **min(contract_start) … max(contract_end)** across that vendor's contracts. Today no
vendor spans two months, so this is invisible. But **`contract_status` has exactly one distinct value
in the entire sheet — `Active` — on all 41 contracts**, including:

- 3 Rajkot Movers contracts that ended **31 July**
- Drivetech, which ended **19 Aug**
- all 37 August contracts, now in the past

So the moment a September contract is added for an existing vendor while August is still `Active`,
that vendor's MIS covers **both months in one file and one invoice**. A new WARN gate,
**`Contract period sits inside one month`**, now catches it and says to bill the months separately.

Two consequences of nothing ever being closed: the `Vendor has at least one Active contract` gate can
never fail, so it is currently proving nothing; and July work reappears in every run.

**This is the one I would fix before September contracts go in** — either close finished contracts, or
add a period picker to the MIS.

### 8 · 297 trips not yet settled by a vendor

`Pending` 269 + `Reconfirm` 28. They are **included** in the payable and flagged on the MIS as
"awaiting your confirmation", so nothing blocks — but the number a vendor sees is not final until they
act on the panel.

### 9 · `Ground_Confirmation_Log` has scratch data parked in columns 20–24

16 named headers, then 8 blank ones, with a side block carrying its own mini-header
(`trip_id`, `Changed`/`Regular`, `final`, `TRUE`, `TMS_ADHOC_BILLING`). Harmless — reading is by header
name and blank headers are skipped — but it is sitting inside a log tab that finance may read.

---

## What is clean

Worth stating, because these were the blockers last month:

- **All three reconciliation gates clear for all 17 vendors** — vehicle count, Σ `pegged_km_slab` and
  Σ `monthly_rate` all agree with `Contract_Info`. The `fixed_monthly_value(15days)` header problem is
  fixed.
- **0 trips outside their contract window** (of 4,897).
- **0 `trip_date` values in a non-ISO format** in `Trip_Level`, and 0 blank `trip_end_time`.
- **`Access_Control` is healthy** — 30 rows, no duplicate emails, no blank emails, 12 active `admin`
  rows, every `vendor` row carries an oracle.
- **Every zonal row matches a known vendor**; every zonal regular trip carries an RFQ id.
- **2 vendors are completely clear** (Sk Transport, Pune Logistics) and Drivetech too.

---

## Order to fix

1. **Set `MIS_SHEET_ID`.** Nothing runs without it.
2. Correct the `MUM7-20271-20260822-31` window to **22–31 Aug**.
3. Fill `Hr` on the 21 placement rows; retype the dates as real date cells; fix the two 2028 rows;
   resolve row 2's date-or-slab.
4. Run **menu 9** and read the alert — it now reports the placement row count, vehicle-days and rupees,
   and names any blocking problem.
5. **Ignore the look-alike plate warning** — it costs nothing and strands nothing (§4). Before sending
   **Yah Yah's and Buraq's** MIS, confirm with ground who was engaged on the 1,638 km run on
   `MH04LQ7801`: it is worth **₹13,104** (§5c). Rajkot's shared plates are ₹0 today — send those MIS.
   Ask ground about the four same-plate-same-day collisions separately (§5d), as data hygiene.
6. Decide on the month question before September contracts are created.

## Tests

`testkit/_pftest.js` is now **72 assertions**, covering the live tab name, LH's column names, the empty
`Hr`, a missing tab, vendor-scoped gates, and the month-span gate. Runnable suite: **560 assertions**
across 14 harnesses (3 browser harnesses need Playwright, not installed in my rebuilt mirror).

One thing the tests caught in my own work: the first cut of the placement gate reported *every*
unresolved row to *every* vendor, which blocked all 17 MIS files because one Buraq row was missing its
hours — including Rajkot vendors with no placement failures at all. Gates are now scoped to the vendor
being billed, and `_pftest.js` asserts that another vendor's bad row cannot hold up your payment.
