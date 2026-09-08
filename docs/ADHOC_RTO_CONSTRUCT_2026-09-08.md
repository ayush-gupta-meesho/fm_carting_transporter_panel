# Adhoc RTO becomes payable

## The rule

| the trip | RTO effect |
|---|---|
| **Regular** — either scope, replacement rows included | pays **nothing**, and no KM reaches the grouped slab. Unchanged. |
| **Adhoc** — either scope | **is paid**, at the full `adhoc_amount` the row carries. New. |

It is one line in the shared classifier, `Code.gs` line 401:

```js
// before
var payable = rto ? 0 : (isAdhoc ? adhocAmt : (isZonal ? zonalAmt : 0));
// after — isAdhoc is tested BEFORE rto, and that is the whole change
var payable = isAdhoc ? adhocAmt : (rto ? 0 : (isZonal ? zonalAmt : 0));
```

Because `_classifyTrip` is the single authority both the panel and the MIS read, one line moves both
surfaces together. That is deliberate: the ₹11,726.71 Pune Logistics gap existed because the two
surfaces each did their own arithmetic on this question.

**A paid RTO trip is still recorded as an RTO.** The marking is a fact about the run; it is no longer a
payment switch. Both are asserted.

## What it is worth on the live sheet

11 trips, **₹31,746.03**, two vendors:

| vendor | trips | adhoc RTO paid |
|---|---:|---:|
| Ajay Enterprise | 7 | ₹20,019.32 |
| Pune Logistics | 4 | ₹11,726.71 |

Zonal adhoc RTO is covered by the rule but has **zero rows live today** — it matters from next month.

The **MIS figures do not move**: it was already summing the raw amount, which is why it read ₹2,50,987
against the panel's ₹2,39,260. What moves is the **panel**, which now comes up to meet it. Verified
across all 16 vendors on the live export:

```
vendors where the panel and the MIS disagree on adhoc: 0 of 16
Pune Logistics   panel Rs 2,50,987   MIS Rs 2,50,987
Ajay Enterprise  panel Rs 1,54,180   MIS Rs 1,54,180
```

169 Regular RTO trips carrying 9,273.5 real KM stay at zero KM and zero money, exactly as before.

## What else had to change, and why

The rule was stated in prose in six places, and all of it said the opposite.

- **`vercel-app/index.html`** — an adhoc RTO row rendered as `RTO · 0 km / Not payable`. It now shows the
  amount with an `adhoc amount · RTO` label. The dispute modal no longer tells an adhoc vendor the trip
  "pays nothing"; it says the trip **is** paid and this is a plain amount claim.
- **`index.html`, the claim builder** — it used to attach `claim_challan_type = 'Forward Only'` to *every*
  RTO dispute, so an adhoc vendor disputing an amount silently also claimed the trip was not an RTO.
  Now scoped to non-adhoc: `if (disputeTrip.rto && disputeTrip.billing!=='Adhoc')`. This is the change
  most likely to be missed by reading the diff of `Code.gs` alone.
- **`Billing.gs`** — the Adhoc tab footnote now states that an adhoc trip is paid even on an RTO-only
  challan, so the row does not read as a bug to whoever checks the MIS. The Zonal tab note was likewise
  split into its Regular and Adhoc halves.
- **`Actions.gs`** — the comment claiming an amount dispute on an RTO trip is a no-op is now true of
  Regular only.
- **`docs/DISPUTE_RESOLUTION_RUNBOOK.md`** — the RTO table gained a "paid while still marked RTO?"
  column, and the part-run recipe now prefers **flip to Adhoc, leave the RTO alone** over lifting the
  challan.

## The four mis-resolved disputes — the correction is money-neutral

Rows 376–379 of `Disputes_Log` have a rupee figure in `resolved_challan_type` and a blank
`resolved_amount`, which put `"3052"`, `"3083"`, `"3000"`, `"3262"` into `challan_type_final`.

Set **`resolved_challan_type` = `RTO only`** on all four (column AN), leave `resolved_amount` blank, run
**menu 4**. Checked against the live rows:

```
TR-17742878-7647   "3052" -> RTO only    Rs 3052.64  ->  Rs 3052.64
TR-61978891-1358   "3083" -> RTO only    Rs 3025.26  ->  Rs 3025.26
TR-13068299-5863   "3000" -> RTO only    Rs 3035.08  ->  Rs 3035.08
TR-72098869-1816   "3262" -> RTO only    Rs 3163.76  ->  Rs 3163.76
                                total    Rs 12276.75 ->  Rs 12276.75    difference Rs 0.00
```

**Not a rupee changes.** They were already being paid, off a junk challan value; after the correction
they are paid by rule, off a clean one. That is the whole point — the outcome was right by accident and
is now right by construction.

One thing ground may still want to settle separately: Sharan's figures (3262 / 3000 / 3083 / 3052) each
sit below the vendor's claim (6800 / 3600 / 3600 / 3200), and one note reads *"ADDING 2 ROUTE AMOUNT IN
THIS"*. If those were negotiated settlements rather than the claim, they are ₹120.25 above what the rule
pays and ₹4,923.25 below what was asked. That is a commercial conversation, not a data fix.

## Tests

`testkit/_adhocrtotest.js` — **25 assertions**, rewritten from the version that asserted the old
direction (parked at `_to_delete_empty_dir_2026-09-08/` alongside an empty folder I could not delete
from here; both are safe to remove). It holds:

- both arms of the rule, local and zonal, including a replacement RTO row paying zero
- the MIS per-contract total **and** the orphan bucket both including the adhoc RTO trip
- the Regular RTO trip still listed with its real 180 km while contributing 0 to the slab
- **the parity assertion** — panel adhoc sum === MIS adhoc total over the same rows
- a non-vacuity check reproducing the old ₹9,000-vs-₹14,562.95 split, i.e. the shape of the live gap
- the surfaces: that `Code.gs` tests `isAdhoc` before `rto`, that the old blanket form is gone, and that
  `index.html` no longer auto-claims a challan lift on every RTO dispute

Six existing harnesses asserted the old rule and were rewritten rather than deleted — `_rtotest`,
`_matrixtest`, `_billtest`, `_resolvetest`, `_kmresolvetest`, `_uitest`. Two are worth calling out:

- **`_matrixtest`** carries an independent spec oracle over **12,960 combinations**. Updating its one
  payable line and re-running is the strongest evidence the change is complete and leaks nowhere.
- **`_rtotest`** keeps the Regular arm asserted in exactly its old form, and the new Adhoc arm is
  written in the same shape immediately below it, so the diff between the two blocks *is* the rule
  change, readable side by side.

Suite: **981 assertions across 18 harnesses**, all passing.

## To deploy

1. Paste `Code.gs`, `Actions.gs`, `Billing.gs` into Apps Script. Save.
2. Deploy `vercel-app/index.html`. Without it the panel still says "Not payable" on rows that now pay.
3. Run **`3 · Refresh panel data`** so the vendor view picks up the new amounts.
4. Fix the four dispute rows above, run **`4 · Apply vendor actions NOW`**.
5. Re-download the vendor MIS files. Pune Logistics and Ajay Enterprise are the only two whose adhoc
   figures were ever in question, and both now match the panel.
