# Thorough test sweep — every change we have made

**11 August 2026.** Brief: *"Can you do thorough testing of all the changes we had made. Do not want to
miss out any use case?"*

Everything below was produced by executing the real `Code.gs` / `Actions.gs` / `Billing.gs` /
`index.html` / `api/action.js`. Nothing is a code review.

---

## Headline

| | before | after |
|---|---:|---:|
| harnesses | 5 | **11** |
| assertions | ~290 | **658** |
| live money bugs found | — | **1** |
| root causes explained | — | **1** |
| production lines changed | — | **1** |

**One money bug: ₹17,000 of zonal money was being billed twice.** Found by a harness written for this
sweep, fixed, and the fix verified non-vacuously. One line of production code changed; everything else
here is tests and documentation.

---

## 1 · BUG (fixed) — ₹17,000 billed twice

I wrote `_paritytest.js` to assert something nothing had ever checked: that the vendor's panel and
finance's MIS **cannot disagree**. Both call the same `_classifyTrip`, so that was the whole point of the
design — but "cannot disagree" was an architectural intention, not a test.

It came back reporting **11 duplicated trips**, all zonal. The cause is in `_misReadSource()`:

```js
tl.forEach(function (t) {
  var cid = _s(t.contract_id);
  if (info[cid]) { (trips[cid] = trips[cid] || []).push(t); return; }
  var orc = _s(t.transporter_oracle_id);
  if (excl[_low(orc)] || !byOracle[orc]) return;
  (orphans[orc] = orphans[orc] || []).push(t);     // <-- every zonal trip landed here
});
```

A zonal trip has **no `contract_id`** — that is the decision we took on 7 August: its `rfq_id` *is* the
contract reference. So all 11 zonal rows failed `info[cid]`, fell into the Other-Adhoc orphan bucket, and
were billed a second time.

| | before | after |
|---|---:|---:|
| rows in the Other-Adhoc bucket | 14 (3 real + **11 zonal**) | 3 |
| `bucket.adhocAmt` | ₹27,500 | ₹10,500 |
| `totals.adhoc` | ₹39,150 | ₹22,150 |
| `totals.zonal` | ₹47,100 | ₹47,100 |
| **`totals.payable`** | **₹548,250** | **₹531,250** |

₹17,000 counted once as zonal and again as adhoc. The same 11 trips also appeared on the MIS **Adhoc**
tab as well as the **Zonal** tab — so a vendor reconciling their MIS line by line would have found their
own trips listed twice.

**The asymmetry was the bug.** `Code.gs` already excluded zonal from its orphan bucket; `Billing.gs`
never did. The fix is the same filter:

```js
if (_low(_s(t.route_scope) || 'Local') === 'zonal') return;   // handled by the zonal pass below
```

**Verified non-vacuously.** With that one line removed, `_billtest` fails 6 assertions and `_paritytest`
fails 1, naming `TR-ZT-0001…4`. With it in, all 658 pass. A test that cannot fail is not protecting
anything, so I check this every time.

### Why nothing caught it before

`_billtest.js`'s totals check was:

```js
const expect = m.totals.fixed + m.totals.excessAmt + m.totals.adhoc + m.totals.zonal;
ck(R(m.totals.payable) === R(expect), 'payable is the sum of its four parts');
```

Every term comes from the same object, so it holds **no matter how wrong `adhoc` is**. It had only ever
independently cross-checked *zonal* against the CSV — never adhoc, which is exactly the term the bug
inflated.

`_billtest` now sums local adhoc and the orphan bucket independently off the raw CSV, asserts no zonal row
can appear in `d.trips` / `d.orphans` / the bucket, and asserts payable is **not** ₹548,250.

> **The lesson, worth keeping:** a self-consistency check is not a test. Every total needs at least one
> independent re-derivation, or it will agree with itself while being wrong.

---

## 2 · ROOT CAUSE — the two live date findings are one bug

The sanity check on 7 August flagged two separate problems in `Contract_Info`: `contract_start_date` reads
`2026-01-08` instead of 1 August, and `contract_end_date` holds the unreadable text `"31-08-2026"`.

`_datetest.js` shows they are the **same typing mistake**. If a date is stored as text in the Indian
`dd-mm-yyyy` format, JavaScript reads it as `mm-dd-yyyy`:

| typed | day | `_toDate` reads it as | outcome |
|---|---|---|---|
| `01-08-2026` (1 Aug) | ≤ 12 | **8 January 2026** | parses — silently wrong |
| `31-08-2026` (31 Aug) | > 12 | **null** | no 31st month — fails loudly |

**The boundary is the 12th: `dd ≤ 12` parses wrongly, `dd > 12` fails loudly.** One mistake, two different
silent failures, which is why it looked like two findings.

The fix is unchanged — retype both columns as real dates — but the rule to carry forward is: **never store
a date as text in this sheet.** Any month with a 1st–12th will look fine and be seven months off.

What each one breaks, measured:

- **`_misInPeriod`** — the live window (8 Jan – no end) accepts a **February** trip. The correct window
  rejects it. The "trip dated outside the contract period" exception can never fire today.
- **`_projFields`** — half way through August with 1,500 of 3,000 km run, the correct window projects
  **3,000 km / 100% / ON-TRACK**. The live window projects **1,500 km / 50% / UNDER**. Every projection and
  every badge on the admin view is currently wrong.
- **`_fmtRange`** — the vendor's Duration renders as the raw broken cells: `2026-01-08 00:00 – 31-08-2026`.

---

## 3 · `_rtotest.js` had zero assertions

It printed a table and always exited 0 — it could never fail, so it protected nothing. Now **75
assertions**, including six independent statements of the **ONE RTO RULE**: no `resolved_*` value pays an
RTO trip, because `payable = rto ? 0 : …` runs first. `resolved_challan_type` is the only lever.

Two facts it pins that matter before anyone resolves one:

- On **LOCAL REGULAR**, lifting the RTO alone earns the vendor **nothing** — the KM is still 0, so
  `resolved_km` is required too. On the other three combinations (Local Adhoc, Zonal Regular, Zonal Adhoc)
  the amount is already on the row, so `resolved_challan_type` alone is enough.
- The RTO test is `startsWith('rto')`, not `contains`. **`"RTO cancelled"` still reads as an RTO and still
  pays ₹0.** `"Not RTO"` and `"Forward Only"` are safe. This is a live trap for whoever fills the column.

---

## 4 · The five new harnesses

| harness | assertions | the gap it closed |
|---|---:|---|
| `_matrixtest.js` | 23 | `_classifyTrip` was tested only on the shapes the demo data happened to contain. Now the **full cross product** of the 8 fields that influence classification — **12,960 combinations** — each compared against an independent oracle written from `ZONAL_LOCAL_SCHEMA.md` rather than from the code. All 8 outcome shapes are asserted to be reached, so it cannot pass by skipping a branch |
| `_paritytest.js` | 35 | nothing asserted that the panel and the MIS agree. Per local contract, per RFQ, per trip and both grand totals; plus every trip the vendor sees is on some MIS tab, the MIS bills no trip the vendor was never shown, and no trip appears twice. **Found the ₹17,000 bug** |
| `_guardtest.js` | 81 | every **refusal** path in `Actions.gs` — none had a single assertion. The ground window, `ZONAL_NOT_EDITABLE`, the hand-typed `billing_type_resolved` clear, the incomplete-reclassification bounce, and ownership / locking / closed-window on both `applyConfirm` and `applyDispute` |
| `_importtest.js` | 60 | the **CSV** resolution door was completely untested although it writes the same `Trip_Level` columns as the in-sheet door. Includes an **equivalence** section: six scenarios through both doors, requiring a byte-identical `Trip_Level` snapshot and identical payable |
| `_datetest.js` | 69 | `_toDate` / `_misInPeriod` / `_projFields` had no tests at all. **Found the root cause in §2** |

### What `_guardtest` actually proves

Because these are the paths standing between the panel and the money:

- A trip inside its ground window does not transfer — **but its derived deadline is persisted**, so the
  next run is not recomputing from scratch.
- `Ground_Confirmation_Log` is written **before** `sent_to_vendor_flag`, so a log failure leaves the trip
  un-transferred and retryable rather than transferred and unlogged.
- A ground edit to `billing_type_final` on a **zonal** trip is cleared, the log names the **RFQ** (there is
  no contract_id to name), and the row is flagged partial.
- A hand-typed `billing_type_resolved` is cleared on **both** scopes. That column outranks everything, so
  without this guard someone could pay a trip ₹9,999 by typing in a cell, with no dispute behind it.
- `applyConfirm` / `applyDispute` refuse on ownership, refuse on locked status, and **throw** on a closed
  window — and another vendor's trip is not merely unchanged, it is not even logged.
- An unfilled claim stays **blank**, not `0`. A claim of zero is a real claim; a blank one is not.

### What `_importtest` actually proves

The equivalence section is the point. Six scenarios — local reclassify + KM + amount, local RTO lifted,
zonal amount + RFQ corrected, a refused zonal flip, an accepted zonal flip, zonal adhoc RTO lifted — each
run through the CSV importer **and** the in-sheet applier, with the entire `Trip_Level` snapshot compared
byte for byte. All six identical. **The same resolution now provably pays the same amount however ops
submits it.**

Also confirmed: the zonal refusal works through the CSV door too. A flip to Adhoc with a blank
`adhoc_amount` and no `resolved_amount` is refused and the trip **keeps paying its ₹5,300** rather than
silently dropping to ₹0.

---

## 5 · Two behaviours that look like bugs and are not

Both surprised me until I executed them, so they are worth stating:

- **A `ZONAL_NOT_EDITABLE` or `NEEDS_ATTRIBUTION_FIX` trip still transfers.** The bad *edit* is discarded,
  not the trip. Dropping the trip would hide money from the vendor in order to punish a ground mistake.
- **A blank `dispute_window_end` does not lock the vendor out.** Blank means *not yet closed*, not
  *closed*. A trip transferred before the window logic existed must still be disputable.

---

## 6 · Final state

**11 harnesses, 658 assertions, all passing.**

```
_uitest      225   real Chromium, the whole vendor flow
_guardtest    81   every refusal path in Actions.gs                        NEW
_rtotest      75   the RTO resolution table                          rewritten
_datetest     69   dates — the failure mode that never shouts             NEW
_importtest   60   the CSV door + door-equivalence                        NEW
_billtest     37   MIS vs an independent CSV sum                     extended
_paritytest   35   panel <-> MIS parity                                   NEW
_matrixtest   23   12,960 classification combinations                     NEW
_apitest      22   the claim_* contract across three files
_resolvetest  21   does an upheld resolution move money?
_flowtest     10   nobody types into Trip_Level
```

Run them with `node <name>.js` from `testkit/` after `node _mkpayload.js`. Every one exits non-zero on
failure. `testkit/README.md` documents each in full.

### What is still not covered

Named so they are known gaps rather than blind spots:

- **`syncToUpstash` / `/api/data`** — the snapshot hop is exercised only through a stub. A sync that
  silently pushes a stale or truncated payload would not be caught.
- **Google Sheets I/O itself** — `_readTab` and `_setCell` are in-memory in every harness, so a real
  range / permission / quota error is out of scope.
- **The Apps Script menu wrappers** — the UI prompt layer is stubbed; the functions they call are covered.
- **Live master data.** These harnesses run on `demo-data/`. They prove the *code* is right; they cannot
  prove the *sheet* is.

---

## 7 · What you need to do

The code side is done. These are the items still sitting with you:

1. **Paste `apps-script/Billing.gs`** — it now carries the ₹17,000 fix. `Code.gs` and `Actions.gs` are
   unchanged since the last paste.
2. **Add the 4 columns** if not already done: `Trip_Level.billing_type_resolved`, and
   `Disputes_Log.claim_challan_type` / `orig_challan_type` / `resolved_challan_type`.
3. **Set `MIS_SHEET_ID`** in `Billing.gs` to the MIS sheet id, or menu 10 has nowhere to write.
4. **Fix the 5 `Contract_Info` problems** from `SANITY_CHECK_CONTRACTS_2026-08.md`. Two are blockers, and
   §2 of this document explains why two of them are really one — retype the date columns as **real dates**,
   never text.
5. **Deploy `vercel-app/index.html` + `api/action.js`** if they are not already live.

Then run **menu 9** and confirm `Validation_Gates` is clear for all four vendors before any August billing.
No real vendor has a single trip yet, so this is the moment to fix the master data.
