# Placement Failure — a deduction line on the vendor MIS

**4 Sep 2026.** New `Placement Failure` tab in *FM Carting - Panel*, read by the billing engine and
turned into a visible deduction on each vendor's MIS.

---

## What this is — and what it deliberately is not

A placement failure is a contracted vehicle-day the vendor did not honour. The MIS now shows:

```
Fixed amount            the full period value of the contract
Placement failure       − the days not honoured, at the contract's own day rate
                        ────────────────────────────────────────────
Total payable           what is actually owed
```

**This is the pro-rating made visible, not a second charge.** `active_days` and `monthly_rate` are
left exactly as they are, and this line is the only reduction applied. Trimming the masters *and*
deducting would take the same days twice — on Bharat's five real failures that is ₹36,000 paid
against ₹45,000 owed. `testkit/_pftest.js` §5 asserts both halves of that, so the two can never both
be applied.

The decision was explicit: pro-rate only, shown as a line so the vendor can see why the figure moved.

## The day rate is not a new number

`monthly_rate` is already the value for the contract's `active_days`, so the day rate is
`monthly_rate / active_days` — which is arithmetically identical to `tier / 30`, the convention the
engine already prices everything on. Checked against live data:

| | monthly_rate / active_days | tier / 30 | |
|---|---:|---:|:-:|
| 8 FT @ 1,500 km | 27,000 / 15 = **1,800.00** | 54,000 / 30 = **1,800.00** | ✓ |
| 7 FT @ 1,200 km | 18,800 / 12 = **1,566.67** | 47,000 / 30 = **1,566.67** | ✓ |
| 7 FT @ 1,000 km | 21,500 / 15 = **1,433.33** | 43,000 / 30 = **1,433.33** | ✓ |

So there was nothing to settle about the basis. Both routes give the same rupee.

**One unit trap, worth stating plainly:** the unit is the **vehicle-day**, not the contract-day.
Bharat's contract is 2 vehicles × 15 days = 30 vehicle-days for ₹54,000. Five failures leave **25 of
30**, not 10 of 15. An earlier draft of the test asserted 10/15 and was wrong — the test caught it.
The distinction bites the moment a contract has more than one vehicle, which is nearly always.

---

## The tab

| column | filled by | notes |
|---|---|---|
| `trip_date` | LH | **must be a real date cell**, or `yyyy-mm-dd` text. See the date rule below. |
| `vendor_oracle_id` | LH | the join key |
| `vendor_name` | LH | for reading; the oracle is what joins |
| `vehicle_size` | LH | `7FT` or `7 FT` — both work, it is normalised |
| `pegged_km_slab` | LH | must match a vehicle on the contract |
| `hours_slab` | LH | **required** — see below |
| `vehicles_failed` | LH | defaults to 1. Use this rather than repeating a row. |
| `remarks` | LH | free text |
| `recorded_by`, `recorded_at` | LH | audit |

**Grain: one row = one contracted vehicle-day not honoured**, identified by
`(trip_date, vendor_oracle_id, vehicle_size, pegged_km_slab, hours_slab)`.

### No `vehicle_number`, on purpose

Which physical vehicle runs against a slot is not fixed, so LH record the shape of what was missing —
*"on the 18th you could not put out one 7 FT / 1,500 km / 12hr vehicle"* — rather than a plate. The
deduction only needs the day rate, and every vehicle on the same slab in one contract carries the same
rate, so a plate would add nothing to the pricing.

The trade-off: two failures of the same shape on one day cannot be told apart from an accidental
paste. That is what `vehicles_failed` is for, and why a duplicate key is a **BLOCK** rather than a
silent sum.

### `hours_slab` is required, and here is why

Oracle 19434 has **two** 7 FT contracts running the same dates, both with 1,500 km vehicles:

| contract | hours | per vehicle | day rate |
|---|---|---:|---:|
| `MUM7-19434-20260817-31` | 12hr | ₹23,500 | ₹1,566.67 |
| `MUM7-19434-20260817-31-24H` | 24hr | ₹38,000 | ₹2,533.33 |

A `19434 / 7 FT / 1500 km` row matches both. Without `hours_slab` the engine would have to guess at a
vendor's money, and ₹967 a day rides on the guess. It refuses instead.

### The date rule — the third time this has bitten us

`_toDate()` reads `dd-mm-yyyy` **text** as `mm-dd-yyyy` whenever the day is 12 or less, and returns
null when it is 13 or more. `_toDate('05-08-2026')` really does come back as **May**.

On a tab that moves money a silently wrong month is far worse than a refused row, so `_pfDate()`
**names and rejects** `dd-mm-yyyy` text rather than parsing it. Real date cells and `yyyy-mm-dd` text
are accepted. The source table LH sent uses `dd-mm-yyyy` text throughout, so every row of it would be
refused as-is — that is the guard working, not a bug.

---

## The three gates — all BLOCK

A row that cannot be priced stops the MIS. An unpenalised no-show and a mistyped row look identical
otherwise.

1. **`Every Placement Failure row resolves to one contract`** — names the sheet row number and the
   reason for each failure.
2. **`No duplicate Placement Failure entry`** — an accidental paste must not deduct twice; the message
   points at `vehicles_failed` as the right way to say "two".
3. **`Placement failure days within the vehicle-days available`** — a vendor cannot fail more
   vehicle-days than the contract has to give.

A missing tab reads as **zero failures** and blocks nothing, so the engine keeps working before
`1 · Create / verify tabs` has been run.

Also refused: vehicles on the same slab in one contract that disagree on `monthly_rate` or
`active_days` — there is no single day rate to deduct, so the engine does not average them.

---

## The 21 rows LH sent: 18 price, 3 are refused

Against the live masters, **₹31,533.57** across 18 vehicle-days.

| vendor | oracle | days | deduction |
|---|---|---:|---:|
| Logistics link | 20271 | 7 | ₹10,966.90 |
| Bharat Enterprises | 20882 | 5 | ₹9,000.00 |
| Yah Yah Transcarrier | 19434 | 4 | ₹7,400.00 |
| Ssk Roadlines | 20426 | 1 | ₹2,600.00 |
| Buraq Transcarriers | 18764 | 1 | ₹1,566.67 |
| **total** | | **18** | **₹31,533.57** |

**Worth looking at on its own: Logistics link failed 7 of its 10 contracted vehicle-days** — ₹10,967
of a ₹15,667 contract. That vendor barely ran. It is a commercial conversation, not a billing one.

### The 3 refused rows

| row | what is wrong |
|---|---|
| 1 | `18764 / 7 FT / 1,200 km` on **17 Aug**. The 1,200 km contract starts **20 Aug**; on 17 Aug that vendor's 7 FT vehicle is pegged at 1,000 km. Either the date or the slab is wrong — **LH to say which**. |
| 4, 6 | `19434 / 7 FT / 1,500 km`. Needs `hours_slab` — 12hr or 24hr. **LH to fill.** |

### Master-data fixes needed first

| | fix |
|---|---|
| `MUM7-20271-20260822-31` | `Contract_Info` says **23–25 Aug**; the contract_id says 22–31 and the vehicle row says **22–31 with active_days 10**. Agreed: **22–31 Aug is right — correct Contract_Info.** Until then all 7 Logistics link rows fall outside the window and refuse. |
| rows 20, 21 | dated **2028**, not 2026. Typo. |
| all dates | `dd-mm-yyyy` text → retype as real date cells. |
| `vehicle_size` | LH type `7FT`, the masters hold `7 FT`. Handled by normalisation — no change needed, but worth knowing the two are not equal as strings. |

---

## Rolling it out

1. Paste `Code.gs` and `Billing.gs` into Apps Script.
2. Run **`1 · Create / verify tabs`** — creates the `Placement Failure` tab with its headers.
3. Fix the master data above, starting with the `MUM7-20271` window.
4. Paste the corrected rows (`placement_failure_corrected.csv`), fill the 3 blanks, retype the dates
   as real dates.
5. Run **`9 · Refresh cost view + gates`** — the alert now reports the row count, vehicle-days and
   rupees to deduct, and names any blocking problem.
6. Check **Validation_Gates** shows the three placement gates clear.
7. Run **`10 · Generate vendor MIS`**. The Summary tab now carries a `Placement failure` column and a
   note explaining it to the vendor.

## Tests

`testkit/_pftest.js` — **53 assertions**. Suite: **17 harnesses, 921 assertions.**

It pins the day-rate identity, the `hours_slab` requirement with the real ₹23,500-vs-₹38,000 case, the
string forms LH actually type, the date rule (including that `_toDate` really does read `05-08-2026`
as May), the vehicle-day arithmetic, all three gates, a missing tab, and inconsistent masters.

§5 is the one that matters: it asserts the deduction lands on the same rupee as trimming the masters,
and that doing both would pay ₹36,000 against ₹45,000 owed. §8 removes the deduction and proves the
payable moves by exactly ₹9,000, so none of it is vacuous.
