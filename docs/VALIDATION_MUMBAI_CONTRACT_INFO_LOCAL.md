# Validation — "Mumbai contract details": `Contract_Info` vs `Local`

Checked **18 Aug 2026** against the live sheet
(`1jqIL15Wu097FVfFbOq6fR-NBTVM-rfQ2UtkQpcOxN70`, last modified 18 Aug 08:26). Scope as asked:
**`Contract_Info`** (24 contracts, the overall level) and **`Local`** (81 rows, the vehicle level).
Every figure below was produced by running the real `Code.gs` + `Billing.gs` over the two tabs.

---

## Verdict

**The two tabs reconcile exactly — all 24 contracts, on vehicle count, slab and value.** Totals agree at
**81 vehicles · 1,08,500 km · ₹22,25,250** from both directions. This is the check that found 7 errors in
the Rajkot master; Mumbai is clean on it.

**But the sheet will not bill.** `runGates()` returns **BLOCK for all 11 vendors** — because of one column
heading, not one number.

```
════ MENU 9 — as the sheet stands ════
19434 Yah Yah      Rs 5,19,750   1 of 11 gates not clear   [BLOCK]
18764 Buraq        Rs 4,99,000   1 of 11                   [BLOCK]
20517 Ajay         Rs 3,98,500   1 of 11                   [BLOCK]
20426 Ssk          Rs 3,18,500   1 of 11                   [BLOCK]
20226 Fedfox       Rs 1,86,750   1 of 11                   [BLOCK]
19252 Sk           Rs   89,750   1 of 11                   [BLOCK]
20882 Bharat       Rs   77,500   1 of 11                   [BLOCK]
18722 Shree        Rs   45,000   1 of 11                   [BLOCK]
20703 Apex         Rs   43,000   1 of 11                   [BLOCK]
19280 Pune         Rs   23,750   1 of 11                   [BLOCK]
20682 Drivetech    Rs   23,750   1 of 11                   [BLOCK]
════ 11 BLOCK, 0 WARN ════
```

---

## 1 · BLOCKER — the column is named `fixed_monthly_value(15days)`

The schema column is **`fixed_monthly_value`**. The sheet has **`fixed_monthly_value(15days)`**.

`_readTab()` matches columns by header name, so the engine finds no such column and reads **0** for every
contract. The reconciliation gate then compares Σ `monthly_rate` against zero and blocks:

```
MUM10-19434-20260817-31 (Σ 35500 vs CI 0); MUM7-19434-20260817-31 (Σ 254500 vs CI 0);
MUM8-19434-20260817-31  (Σ 77750 vs CI 0); MUM7-19434-20260817-31-24H (Σ 152000 vs CI 0)   … × 24
```

The values themselves are all **correct** — they match Σ `monthly_rate` to the rupee. Only the heading is
wrong.

**Proven both ways.** Delete the `(15days)` suffix and re-run:

```
════ 0 BLOCK, 0 WARN — all 11 vendors clear on all 11 gates ════
```

If the 15-day basis needs recording, put it in a note or a separate column — not in the header of a column
the engine reads by name.

## 2 · BLOCKER — one vehicle is on two vendors' contracts

`MH04MR2302` appears twice in `Local`:

| contract_id | vendor | day1_order | pegged slab | monthly_rate |
|---|---|---:|---:|---:|
| `MUM8-20226-20260817-31` | Fedfox Logistics | 4 | 1,000 km | ₹23,750 |
| `MUM8-19280-20260817-31` | **Pune Logistics** | 1 | 1,000 km | ₹23,750 |

**Pune Logistics has exactly one vehicle on the whole pilot, and it is Fedfox's.** Consequences:

- **₹23,750 is at risk of being paid twice** — once on each contract.
- Trip attribution keys on `vehicle_number`, so every trip that vehicle runs will match **two** contracts.
- The panel would show the same registration on two different vendors' cards.

No plate appeared on two contracts in Rajkot's 72 rows — this is the first instance, and it needs ops to
say which vendor actually holds the vehicle.

---

## 3 · HIGH — the KM columns hold text, not numbers

`Contract_Info.total_km_slab` and `Local.pegged_km_slab` are stored as **`"1,500 km"`** — a comma and a
unit inside a numeric field.

The engine happens to survive it: `_num()` does `parseFloat` after stripping commas, and `parseFloat`
stops at the space, so `"1,500 km"` reads as `1500`. That is **luck, not design** — it is the same class of
problem as the Rajkot text dates, which did not survive.

What already breaks: any Google Sheets `SUM`/`SUMIF`/`AVERAGE` over these columns returns 0, and the
in-sheet pivot already renders the total as **`108,500 km`** rather than a number.

**Fix:** store `1500`, and put "km" in the header or a format mask.

## 4 · HIGH — the 15-day pro-rating is ÷2, not 15/31

Every `monthly_rate` in `Local` is the rate-card monthly figure **halved** (e.g. 7FT / 3,000 km = ₹47,000 →
₹23,500). But 17–31 Aug is **15 of 31 days = 0.4839**, not 0.5.

| | as built (÷2) | at a true 15/31 | difference |
|---|---:|---:|---:|
| Fixed, 15 days | **₹22,25,250** | ₹21,53,468 | **₹71,782 (3.33%) richer** |

The KM side carries the same 3.33%, which also means every utilisation % will read 3.3% low and the bar a
vendor must cross before excess KM applies is 3.3% too high.

If ÷2 is a deliberate half-month simplification, fine — but it should be written down as the agreed method,
because it is not what "15 of 31 days" computes to.

## 5 · MEDIUM (question) — the 24-hr 7FT / 3,000 km tier looks mispriced

All four 24-hr vehicles sit on one tier: 7FT, 3,000 km/month, **₹76,000/mo → ₹38,000 for 15 days**.
That is **₹1,52,000 — 6.8% of the invoice** resting on a single cell.

Marginal cost per extra kilometre across the 7FT tiers:

| card | 2,000 → 3,000 | 3,000 → 4,500 | 4,500 → 6,500 |
|---|---:|---:|---:|
| 12 Hr | ₹4.00/km | ₹4.67/km | ₹6.50/km — rises smoothly |
| **24 Hr** | **₹20.00/km** | ₹2.67/km | ₹2.00/km — spikes, then collapses |

And the 24-hr premium over 12-hr at the 3,000 km tier is inconsistent by size: **+62% at 7FT**, +48% at
8FT, +28% at 10FT, down to +11% at 24FT. 7FT is the outlier, and it is the only size we are using.

Not a defect — the card is the card — but worth one confirmation against the RFQ before it bills.

---

## 6 · LOW

- **Vendor names differ inside the same workbook.** `Contract_Info` says **"Ajay Enterprise"** and
  **"Fedfox Logistics Pvt. Ltd."**; the summary block says "Ajay Enterprise**s**" and "Fedfox Logistics
  Pvt. Ltd" (no dot). The join is on `vendor_oracle_id` so nothing breaks, but the panel displays the
  `Contract_Info` spelling — align them, and check which matches the invoicing entity.
- **`Local.monthly_rate` actually holds a 15-day amount.** The gate passes because both sides are 15-day,
  but the column name says otherwise and will mislead the next reader.
- **Only 2 of the 4 slab tiers are in use** — every vehicle is on 2,000 or 3,000 km/month; nothing on
  4,500 or 6,500. Worth confirming the pegging rule is right for a 15-day window.

---

## What passed

- **`Contract_Info` reconciles to `Local` exactly on all 24 contracts** — vehicle count, `total_km_slab`
  and `fixed_monthly_value`, with zero discrepancies. Totals: 81 / 1,08,500 km / ₹22,25,250 both sides.
- **All 81 vehicle amounts match the rate card** (pegged × 2 = monthly slab, `monthly_rate` = card ÷ 2),
  on both the 12 Hr and 24 Hr cards.
- **`ex_km_rate` matches the card's `extra_km` on all 24** — 7FT ₹8, 8FT ₹10, 10FT ₹12, 14FT ₹14. No
  band-shift error of the kind found on Krushiv in Rajkot.
- **`day1_order` runs 1..n with no gaps on every contract**, and `default_vehicle_id` is unique across all
  81 rows.
- **No duplicate `contract_id`**; every ID matches `MUM{size}-{oracle}-20260817-31[-24H]`; the size prefix
  matches `vehicle_size` and the `-24H` suffix matches `hours_slab` on all 24; the oracle ID inside each
  ID matches the `vendor_oracle_id` column; one `vendor_name` per oracle.
- **All 81 registrations are in standard format** — the `v4` / `v5` / `v6` / `v24` placeholders from the
  earlier costing file have been replaced with real plates.
- **Dates are real date values**, `2026-08-17` / `2026-08-31` on both tabs, and `active_days` = 15
  throughout. The vendor's Duration renders correctly as **"17 Aug – 31 Aug 2026"**.
- **No orphan vehicle rows** — every `Local` row points at a contract that exists.

Also resolved since the costing workbook: the vehicle count is now consistent at **81** (it read 80 / 81 /
84 across four places there), and Ssk's `MUM10` has grown from 3 to 4 vehicles with the slab and value
following correctly.

---

## Fix order

1. **Rename `fixed_monthly_value(15days)` → `fixed_monthly_value`** — one edit, unblocks all 11 vendors
2. **Resolve `MH04MR2302`** — decide whether it is Fedfox's or Pune's, and remove the other row
3. **Retype the KM columns as numbers** (`1500`, not `"1,500 km"`)
4. **Confirm ÷2 vs 15/31** and record the agreed method
5. **Confirm the 24-hr 7FT / 3,000 km rate** against the RFQ
6. **Align the vendor-name spellings** and rename `monthly_rate` to reflect the 15-day basis

Then run **menu 9** — with items 1 and 2 done it should come back clear for all 11 vendors.
