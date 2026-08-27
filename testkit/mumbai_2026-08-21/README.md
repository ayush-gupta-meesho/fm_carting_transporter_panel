# Mumbai contract-master validation snapshot — 21 Aug 2026

Frozen copy of the two tabs that matter (`Contract_Info`, `Local`) from
`Mumbai contract details` (`1jqIL15Wu097FVfFbOq6fR-NBTVM-rfQ2UtkQpcOxN70`),
as at **2026-08-21 09:30 IST**, plus the three scripts that check them.

Findings: `docs/VALIDATION_MUMBAI_CONTRACT_INFO_LOCAL_2026-08-21.md`

| file | what it does |
|---|---|
| `Contract_Info.csv` | 27 contract rows, header normalised to `fixed_monthly_value` |
| `Local.csv` | 84 vehicle rows (identical to the `Contract_Vehicles` shape) |
| `Trip_Level.csv` | empty stub — the gates need the tab to exist |
| `check.js` | reconciliation, plate uniqueness, `day1_order`, `active_days` vs window, rate card, `ex_km_rate`, ID format, vendor identity, km formats |
| `zonal.js` | zonal arithmetic: `vendor_rate` decomposition, tolls, band labels, `rfq_id` uniqueness, name join |
| `gates_all.js` | runs the **real** `Billing.gs` engine (`_misReadSource` → `buildBillingModel` → `runGates`) for all 11 oracles |

`__DIR__` in the scripts is a placeholder — point it at this folder before running:

```
sed 's#__DIR__/#'"$PWD"'/#g' check.js > /tmp/c.js && node /tmp/c.js
```

## Why the header is normalised here

The live sheet header is `fixed_monthly_value(15days)`. `_readTab()` matches columns by header **name**,
so the live header makes the engine read ₹0 for every contract and BLOCKs all 11 vendors on the
`Σ monthly_rate = Contract_Info.fixed_monthly_value` gate. These CSVs carry the corrected header so the
*other* ten gates can be exercised. To reproduce the live failure:

```
sed -i '1s/fixed_monthly_value/fixed_monthly_value(15days)/' Contract_Info.csv
```

## Expected output as at 21 Aug

`check.js` → **2 findings**, both on `MUM8-20682-20260817-31` (Drivetech / MH04MR9976):
`active_days 2` against a 3-day window, and 67 km / ₹1,583 matching no tier at 2 days (it is priced at 1).

`gates_all.js` → all 11 gates clear for all 11 vendors, total **₹22,61,466**.

`zonal.js` → EJN bills 500 km against a measured 478; EBR bills 260 km against a measured 247 and is
banded `0-250`; all three `rfq_id`s end `-RFQ-0001`; `Ajay Enterprises` does not join to `Ajay Enterprise`.
