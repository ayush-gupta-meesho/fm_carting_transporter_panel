# Validation — Mumbai Pilot Contracts (Local + Zonal), 17–31 Aug 2026

Checked **11 Aug 2026** against `Mumbai_Pilot_Contracts_Local  Zonal_1731 Aug.xlsx`. Treating
**Summary (Local) / Utilisation Summary** as the contract level and **Contract x Vehicle** as the
vehicle level, per the same test we run on Rajkot.

---

## Verdict

**The contract level and the vehicle level reconcile exactly — that part is clean.** All 24 contract
lines agree on vehicle count, contracted KM and amount, and all 80 vehicle amounts match the rate card to
the rupee.

The problems are elsewhere: **zonal is carried twice with two different answers**, the **pro-rating method
in the file contradicts the method stated in Terms**, and the **utilisation number is inflated by counting
one lane's distance against several vehicles**.

| | value |
|---|---:|
| Local fixed, 15d | **₹21,89,750** |
| Zonal, 15d | **₹2,58,375 — or ₹2,23,153. The file says both.** |
| Local contracted KM (15d) | 1,07,000 |
| Local vehicles | **80 — or 81, or 84. Three different totals.** |

---

## 1 · BLOCKER — zonal is priced twice, two different totals, ₹35,222 apart

The `Zonal RFQ` tab has a main block (rows 5–7) and a second block pasted at columns N–T (rows 16–26).
Same three routes, different numbers, different IDs:

| route | main block | second block | `Contract x Vehicle` uses |
|---|---:|---:|---|
| EJN → MIS (Ajay, 8FT) | 500 km @ ₹14.0 + ₹1,110 toll = **₹1,21,650** | 477.74 km @ ₹14.5, no toll = **₹1,03,908** | the **second** |
| EAG-QCT → MIS (Pune, 8FT) | 310 km @ ₹14.5 + ₹590 toll = **₹76,275** | 310 km @ ₹14.5, no toll = **₹67,425** | the **second** |
| EBR → MIS (Shree, 7FT) | 260 km @ ₹13.5 + ₹520 toll = **₹60,450** | 246.76 km @ ₹14.0, no toll = **₹51,820** | the **second** |
| **total** | **₹2,58,375** | **₹2,23,153** | |

The ₹35,222 gap decomposes exactly: **₹33,300 is toll** (₹2,220/day × 15) and **₹1,922 is the distance
difference** (500 vs 477.74 km, 260 vs 246.76 km).

Two decisions needed, and neither is a spreadsheet fix:

1. **Are tolls in the rate or reimbursed separately?** The main block folds them in ("Vendor Aligned Rate
   (Incl Toll)"), the second block does not.
2. **Which distance is contractual — the rounded one or the measured one?** 500 vs 477.74 km is not a
   rounding difference, it is 4.7%.

Whichever wins, the losing block must be deleted. `Contract x Vehicle` silently follows the second block,
so as the file stands the zonal number anyone quotes depends on which tab they opened.

## 2 · BLOCKER — the pro-rating in the file is not the pro-rating in Terms

`Terms` row 5 states the window is **15 of 31 days** and that "Local slab km AND amount pro-rated 15/31".
Every sheet actually computes **÷ 2**:

> *"Contracted km (15d) = slab ÷ 2"* · *"amount = monthly slab amount ÷ 2"*

15/31 = 0.4839, not 0.5. **Divide-by-two is 3.33% richer than the stated method.**

| | as built (÷2) | at a true 15/31 | overstated |
|---|---:|---:|---:|
| Local amount 15d | ₹21,89,750 | ₹21,19,113 | **₹70,637** |
| Local contracted KM 15d | 1,07,000 | 1,03,548 | **3,452 km** |

The KM error compounds the first: a slab that is 3.3% too high makes every utilisation % 3.3% too low, and
raises the bar a vendor must cross before excess KM applies.

**Decide which is intended and make the file say it once.** If ÷2 is a deliberate commercial simplification
for a half-month, Terms should say so instead of claiming 15/31.

---

## 3 · HIGH — three different vehicle counts

| source | Local vehicles |
|---|---:|
| `Summary (Local)` line items | **80** |
| `Contract x Vehicle` rows | **80** |
| `Utilisation Summary` | **81** |
| `Terms` row 7 | **81** (77 × 12Hr + 4 × 24Hr) |
| `Summary (Local)` reconciliation line | **"77 + 4 + 3 Zonal = 84"** |

The single point of difference: **`MUM8-18764` (Buraq, 8FT) — Utilisation Summary says 11 vehicles,
Contract x Vehicle has 10.** That is the on-hold placeholder vehicle (`V1`) named in Terms row 7 as
"included per instruction" — it is counted in Utilisation and in Terms, but has **no row in the vehicle
table and no row in Summary (Local)**, so it carries no KM and no money.

Note the contracted KM is **15,000 either way**, so adding the 11th vehicle did not add a slab. Decide
whether the on-hold vehicle is in or out, and make all four places agree.

## 4 · HIGH — utilisation is inflated: one lane's distance counted on several vehicles

11 lanes have more than one vehicle against them, and **every vehicle on a shared lane is credited the
full lane distance**, not a share of it:

| lane | vehicles | vendors | est km credited to each |
|---|---:|---:|---:|
| LSWW | 3 | 2 (Ajay, Buraq ×2) | 1,898 each |
| QFO | 3 | 3 (Ajay, Fedfox, Pune) | 258 each |
| EAU, FIL, FLP, JVR, LDPG, EIF, QFI | 2 each | 2 each | identical each |
| LKDV | 2 | 1 (Buraq) | 1,815 each |

Measured effect:

```
est km as the file counts it     117,543   ->  utilisation 109.9%
est km counting each lane once    97,235   ->  utilisation  90.9%
distance credited more than once  20,308   =  17.3% of the total
```

**This is the difference between "we are 10% over slab" and "we are 9% under slab"** — opposite conclusions
from the same data, and it drives whether excess KM is expected to be charged at all. If two vehicles
genuinely run the same lane on different shifts the double count is correct; if the lane is one vehicle's
work, it is not. Worth resolving before this becomes the Mumbai baseline.

## 5 · HIGH — zonal RFQ IDs will not survive contact with the panel

```
FM-Zonal-EJN→MIS-RFQ-0001          ← U+2192 arrow, not a hyphen
FM-Zonal-EAG→QCT→MIS-RFQ-0002      ← two of them
FM-Zonal-EBR→MIS-RFQ-0001          ← U+2192, and RFQ-0001 is ALREADY USED above
```

Three separate problems:

- **Duplicate sequence number.** `RFQ-0001` is used for both EJN (Ajay) and EBR (Shree). A zonal trip has
  no `contract_id` — its `rfq_id` **is** the contract reference — so two vendors sharing an RFQ ID means
  their trips and their money merge onto one card.
- **Non-ASCII arrow.** Same issue flagged on the Rajkot August master. If the data engine writes `->` or
  `-` on the trip row, it will not match, and the vendor gets a second card with the rest of the money on
  it. It also does not survive an ASCII CSV round trip.
- **Two ID schemes.** Main block uses `FM-Zonal-…`, second block uses `MIG-FM-Zonal-…`. Pick one.

Also, in the second block the **EBR row's route reads `EAG-QCT-MIS`** — copied from the row above; it
should be `EBR-MIS`.

## 6 · MEDIUM — zonal rate bands

| route | size | km | band label | rate used | card says |
|---|---|---:|---|---:|---|
| EJN | 8 FT | 500 | 250-500 | **14.0** | **14.5** for 250-500; 14.0 is the 500+ rate |
| EAG-QCT | 8 FT | 310 | 250-500 | 14.5 | ✓ |
| EBR | 7 FT | 260 | **0-250** | 13.5 | rate is right for 250-500; the **label** is wrong |

EJN is either mis-banded or mis-rated — at 500 km exactly, both bands claim it, because the card's ranges
overlap at every boundary (`0-250` / `250-500` / `500+`). **Make the bands non-overlapping** (0–250,
251–500, 501+) so this cannot recur. If 14.5 is correct, EJN is under-priced by ₹3,750 over the 15 days.

---

## 7 · MEDIUM / hygiene

- **4 placeholder registrations** — `v4`, `v5`, `v6`, `v24`, all Yah Yah (rows 73, 75, 78, 82). Terms
  mentions only one placeholder (Buraq `V1`), and that one is not in the vehicle table at all. These
  cannot be loaded — vehicle attribution keys on the registration number.
- **Only 2 of the 4 slab tiers are used.** Every vehicle sits on 2,000 or 3,000 km/month; nothing on 4,500
  or 6,500, although several run over 2,000 km in 15 days. Worth confirming the pegging rule is right.
- **Zonal rows in `Contract x Vehicle` are structurally mislabelled** — the distance sits in the
  "Contracted km" column and the *rupee amount* sits in the "Est km 15d" column (e.g. 103908.45 in a KM
  field). Anything reading that tab programmatically will read money as kilometres.
- **Casing** — zonal rows use `12 HR`, local rows use `12 Hr`.
- **Vendor e-mail addresses** are pasted into `Contract x Vehicle` columns U:W (11 rows), directly under a
  cell reading **"this should not share"**. Delete before circulating.
- **15 `#N/A` cells** left in column N; `Sheet2` is an empty leftover; the `Pune` tab spans 1,000 rows for
  one vehicle.

---

## 8 · What is still needed to load this into the panel

The file is a costing model, not yet a contract master. Against the panel schema:

| tab | missing columns |
|---|---|
| `Contract_Info` | `cluster`, `ex_km_rate`, `contract_start_date`, `contract_end_date`, `contract_status` |
| `Contract_Vehicles` | `day1_order`, `active_days`, `default_vehicle_id`, `start_date`, `end_date` |

Two of these matter more than the rest:

- **`ex_km_rate` exists only on the rate cards and is never carried onto a contract row.** Excess KM cannot
  be billed without it, and Mumbai's rates differ by size (₹8–22/km).
- **`active_days` is 15, not 31.** Rajkot's engine has only ever seen full months. Dates must be entered as
  **real date cells**, never text — a `dd-mm-yyyy` text date parses as the wrong month when the day is ≤ 12
  and fails outright when it is > 12, which is exactly what broke the Rajkot August master.

---

## What passed

- **Contract level reconciles to vehicle level exactly** — all 24 lines, on count, contracted KM and
  amount. Zero discrepancies. This is the check that found 7 errors in the Rajkot master.
- **All 80 vehicle amounts match the rate card to the rupee** (slab = contracted KM × 2, amount = monthly
  rate ÷ 2), on both the 12Hr and 24Hr cards.
- **No duplicate vehicle registration** anywhere in the file.
- **Contract ID format is consistent** — `MUM{size}-{oracle}-20260817-31[-24H]` on all 24, the size prefix
  matches the vehicle size on every row, and the oracle ID inside the ID matches the Oracle ID column on
  all 80 rows.
- **Every vendor maps to exactly one oracle ID.**

---

## Fix order

1. **Pick one zonal block** and delete the other — decide tolls in/out and which distance is contractual (§1)
2. **Settle ÷2 vs 15/31** and restate Terms to match the file (§2)
3. **Fix the zonal RFQ IDs** — unique sequence numbers, plain hyphens, one prefix (§5)
4. **Resolve the lane-sharing question** before quoting a Mumbai utilisation number (§4)
5. **Decide whether the on-hold Buraq vehicle is in or out**, and align all four counts (§3)
6. **Replace the 4 placeholder registrations** with real numbers (§7)
7. **Make the zonal bands non-overlapping** and re-rate EJN (§6)
8. **Strip the e-mails, `#N/A`s, `Sheet2`** before circulating (§7)
9. **Add the 10 missing schema columns** before any load into the panel (§8)
