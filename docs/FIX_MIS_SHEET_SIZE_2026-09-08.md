# "The coordinates of the range are outside the dimensions of the sheet" — Krushiv Enterprise (18838)

## What it was

A sheet created by `insertSheet()` / `SpreadsheetApp.create()` is **1000 rows × 26 columns**. Krushiv's
Local tab needs **1,705 rows** — 1,563 local trips plus a vehicle table, totals, projection and notes
per contract. The writers never grew the sheet, so `getRange()` threw the moment it reached past row
1000. Nothing in the billing logic was wrong; the sheet was simply too small.

It fails for **Krushiv and only Krushiv** because nobody else is close:

| vendor | Local rows needed |
|---|---:|
| **Krushiv Enterprise** | **1,705** |
| Balaji Road Wizards | 616 |
| Shiv Roadlines | 572 |
| Shivay Transport | 482 |
| Buraq Transcarriers | 464 |
| everyone else | under 430 |

That is why every other MIS generated fine, and why the error looked mysterious rather than structural.

## The fix

One helper, `_vmFit(sh, row, col)`, which grows a sheet before anything is written into it:

```js
function _vmFit(sh, row, col) {
  var needR = Math.max(1, Math.ceil(_num(row) || 1));
  var needC = Math.max(1, Math.ceil(_num(col) || 1));
  var maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
  if (needR > maxR) sh.insertRowsAfter(maxR, (needR - maxR) + 200);
  if (needC > maxC) sh.insertColumnsAfter(maxC, (needC - maxC) + 4);
}
```

Called in two places, deliberately belt-and-braces:

- **At the top of every `_vm*` primitive** — `_vmHead`, `_vmHdr`, `_vmBand`, `_vmNote`. These are the
  funnels every writer already advances through row by row, so a tab that creeps past the ceiling for
  any reason is covered without anyone remembering to think about it.
- **Immediately before every bulk `setValues`** — the local vehicle table, the local trip list, Zonal,
  Adhoc, Summary, `Cost_View_All` and `Exceptions`. Each of these knows its body length up front, so
  the fit is exact.

`_vmLocal` additionally fits the **whole tab in one call** before writing a single cell, from a row
count computed across all contracts. The 200-row padding means Krushiv grows the sheet **once**, not
once per row — measured: `grew 1x`, deepest row written 1,755.

The other two tabs at risk in the working workbook were checked and are nowhere near: `Cost_View_All`
90 rows, `Validation_Gates` ~244, `Exceptions` ~166. They are guarded anyway, because `outOfPeriod` and
the near-miss list grow with the data.

## The test — this one reproduces your error

`testkit/_vmsizetest.js`, **14 assertions**. Apps Script cannot run in Node, so the harness supplies a
fake `Spreadsheet` whose `getRange` enforces the same 1000 × 26 limit and throws **the same message**,
then runs the real `_misWriteVendorMis` through it for every vendor.

Against the live export, on the **pre-fix** `Billing.gs`:

```
built 16 of 17

5 FAILURE(S):
  FAIL builds for 18838 Krushiv Enterprise  *** Exception: The coordinates of the range are
       outside the dimensions of the sheet. ***
  FAIL all 17 vendor MIS files build
  FAIL Krushiv Enterprise builds even though it needs 1705 rows
```

Same harness, **after** the fix:

```
built 17 of 17
  ok  builds for 18838 Krushiv Enterprise  (deepest row written 1755, grew 1x)
  ok  and a range beyond row 1000 was genuinely written (1755) — so the ceiling was
      really crossed, not merely approached
  ok  the sheet was grown 1 time(s) rather than the write being skipped
  ok  and grown in a few big steps, not once per row (1 calls)
```

Three of those assertions exist to stop the test going quiet later. The harness first proves its own
fake sheet throws the production message — a green run means nothing otherwise. It then asserts a range
past row 1000 was *actually written*, so the test cannot pass by never reaching the ceiling. And if a
future dataset has no vendor over 1000 rows, it **synthesises a 1,400-trip contract** rather than
silently testing nothing.

Run it against live data with:

```
LIVE_DIR=/path/to/csv-export node testkit/_vmsizetest.js
```

Suite: **995 assertions across 19 harnesses**, all passing.

## To deploy

Paste `Billing.gs` into Apps Script, save, then run **`10 · Generate vendor MIS`** for Krushiv again.
No sheet data changes and no other file is affected — `Code.gs`, `Actions.gs` and `index.html` are
unchanged by this fix.
