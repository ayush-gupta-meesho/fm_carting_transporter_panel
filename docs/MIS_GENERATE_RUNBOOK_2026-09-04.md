# Generating the MIS — what is done, and what is left

`MIS_SHEET_ID` is now set in `Billing.gs` line 39:

```js
var MIS_SHEET_ID = '1q4TkNZTElZUV6NIymLPqYoKGkjWck14mxvRwjDQMoEc';   // FM Carting - MIS
```

Verified against Drive: title **FM Carting - MIS**, owner ayush.gupta3@meesho.com, created 06 Aug 2026.
It is a **different file from FM Carting - Panel**, which is what this must be — menu 9 writes tabs into
it. Never point `MIS_SHEET_ID` at the panel sheet.

Suite after the change: **940 assertions across 17 harnesses, all passing.** `testkit/payload.json` had
to be regenerated (`node testkit/_mkpayload.js`) — the checked-in fixture was one case stale and was
failing `_uitest` for that reason alone, not because of this change; it has been regenerated in place.
On this machine 673 of the 940 run: the three browser harnesses (`_uitest`, `_resolveduitest`,
`_adminunsenttest` = 267 assertions) need `npm i playwright`, which is not installed here.

---

## About the Zonal tab in that workbook

It has a real paste in it (Jul–Aug zonal trips). **The engine will not read it.** Zonal now comes from
`Trip_Level` where `route_scope = Zonal`, so `_misReadZonalAll()` is only a fallback for when
`Trip_Level` carries no zonal rows at all — and it does carry them. The paste is dormant history.

Menu 9 creates the Zonal tab if missing and otherwise **leaves it completely alone**, so nothing there
gets clobbered. It only clears and rewrites `Cost_View_All`, `Validation_Gates` and `Exceptions`.

---

## Steps

**1 · Paste the three files into Apps Script** (Extensions → Apps Script on FM Carting - Panel):
`Code.gs`, `Actions.gs`, `Billing.gs` — whole file each, replacing what is there. Save.

**2 · Reload the panel sheet** so `onOpen()` rebuilds the menu, then run **`1 · Create / verify tabs`**
once. This appends `total_trip_km_resolved` and `adhoc_amount_resolved` to the end of `Trip_Level` and
creates the `Placement Failure` tab against the canonical schema. Authorise when prompted.

**3 · Fix the Placement Failure tab.** This is the only thing still blocking, and it blocks
**5 of 16 vendors**. The tab is currently read as **21 rows, 0 priced, ₹0** — every row rejected. Two
faults, in this order:

- **All 21 `trip_date` cells are `dd-mm-yyyy` TEXT** (`17-08-2026`). `_pfDate` rejects these by
  design rather than guessing — `05-08-2026` is genuinely ambiguous. Retype them as real date cells
  (or `yyyy-mm-dd`).
- **All 21 `Hr` cells are blank.** 18 of them are unambiguous from the masters — the vendor has only
  one contract at that (size, slab) — and all 18 are `12hr`.

`placement_failure_corrected.csv` in the repo root is the paste-ready version: ISO dates, `Hr` filled,
and the resolved contract and day rate on each row so you can check the arithmetic before pasting.

What each fix buys, measured by running the real engine over the live export:

| state of the tab | rows priced | deduction | vendors still blocked |
|---|---:|---:|---:|
| as it is today | 0 | ₹0 | 5 |
| dates fixed only | 16 | ₹28,400 | 3 |
| dates + the 18 derivable `Hr` | 18 | ₹31,534 | 2 |
| all three problem rows resolved too | 21 | ₹36,234 | **0** |

**4 · Three rows need a human, not a script.**

- **Row 2** — 17 Aug, Buraq 18764, 7 FT, 1,200 km. Buraq's 7 FT / 1,200 km contract
  (`MUM7-18764-20260820-31`) starts **20 Aug**, so a 17 Aug failure has no contract to attach to.
  Careful here: simply moving the date to 20 Aug collides with the existing 20 Aug row and trips the
  duplicate gate. So ground has to say which it was — a **different slab on 17 Aug**, or a **second
  vehicle on 20 Aug**. If it is the second vehicle, set `vehicles_failed = 2` on the existing 20 Aug
  row; do not add a second row.
- **Rows 5 and 7** — Yah Yah 19434, 7 FT, 1,500 km on 17 and 18 Aug. This vendor has both a 12hr and a
  24hr contract at that size and slab, so the engine refuses to pick. Ground must state 12hr or 24hr.
- **Rows 21 and 22** — dated **2028**-08-30 and 2028-08-31. Typo; correct to 2026 and they attach to
  `MUM7-20271-20260822-31` cleanly.

**5 · Run `9 · Refresh cost view + gates`.** Read the alert. It reports contract count, zonal rows read,
placement rows / vehicle-days / rupees, and names anything blocking. `Validation_Gates` in the MIS
workbook carries the row numbers and reasons.

**6 · Run `10 · Generate vendor MIS`** per vendor, then File → Download → Microsoft Excel. Never send
the working workbook — `Cost_View_All` carries every other vendor's rates and fixed monthly values.

---

## Vendors you can bill the moment step 2 is done

**11 of 16 have no blocking gate at all**: Shiv Roadlines, Balaji Road Wizards, Shree Sadguru Krupa,
Krushiv Enterprise, Sk Transport, Pune Logistics, Shivay Transport, Fedfox Logistics, Ajay Enterprise,
Drivetech, Apex Business Solutions.

The 5 blocked are exactly the 5 with placement-failure rows: Buraq, Yah Yah, Logistics link,
Ssk Roadlines, Bharat Enterprises. Note that a blocked placement row **holds back that vendor's whole
MIS** — the gate is vendor-scoped, so it cannot hold back anyone else's.

## Warnings you should not wait on

The two plate warnings are not blockers and are quantified in `MIS_PREFLIGHT_2026-09-04.md` §4 and §5:
look-alike plates cost nothing and strand nothing (0 km unattributed, all 1,155 replacement trips
fold), and the cross-vendor plates are ₹0 in Rajkot. The single money item is **₹13,104** on Yah Yah's
1,638 km on `MH04LQ7801`, which is Buraq's contracted plate — confirm with ground who was engaged
before sending those two MIS files.

## Still open, unrelated to generating this month's MIS

- No contract is ever closed — all 41 are `Active`, including three July ones. There is no month
  selector, so a July contract still reads as live.
- `Contract_Info` and `Contract_Vehicles` now agree on all 38 billable contracts (the
  `MUM7-20271-20260822-31` window has been corrected to 22–31 Aug).
