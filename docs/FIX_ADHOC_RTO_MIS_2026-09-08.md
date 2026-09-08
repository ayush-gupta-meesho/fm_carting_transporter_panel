# The Pune Logistics gap: panel ₹2,39,260 vs MIS ₹2,50,987

Two separate things, both real, both in the RTO-adhoc corner. The first is a code bug that has been
fixed. The second is four mis-resolved disputes that need a human on the sheet.

---

## 1 · Code bug — the MIS paid RTO adhoc trips the panel correctly showed as zero

**The delta is ₹11,726.71 and it is four trips.**

| date | trip id | vehicle | challan | claimed | payable |
|---|---|---|---|---:|---:|
| 20 Aug | `TR-52207105-1004` | MH47BL3470 | RTO only | 3,162.95 | 0 |
| 30 Aug | `TR-72569140-2290` | MH04MH6158 | RTO only | 3,163.76 | 0 |
| 29 Aug | `TR-50359101-2048` | MH04MR8197 | RTO only | 2,400.00 | 0 |
| 31 Aug | `TR-96315762-3289` | MH03DV0761 | RTO only | 3,000.00 | 0 |

`₹2,50,987.20 − ₹11,726.71 = ₹2,39,260.49` — the panel figure, to the paisa.

**Cause.** `_classifyTrip` returns both `amt` (what the row claims) and `payable` (`rto ? 0 : amt`).
The panel summed `payable`. The MIS summed `amt`, in **two** places:

```js
// per-contract adhoc
if (x.isAdhoc) { adhocAmt += x.amt; ... }        // <- ignored the ONE RTO RULE

// the orphan "Other adhoc" bucket
if (x.isAdhoc) bAmt += x.amt;                    // <- same, and this is where all 82
                                                 //    Pune Logistics adhoc trips live
```

All four of Pune Logistics' RTO trips sit in the **bucket**, because their `contract_id` is
`ADHOC-19280`, which is not a real contract. So the bucket half of the bug is the half that actually
paid out here — worth noting, because the bucket is easy to forget when reasoning about the MIS.

**Fix.** Both paths now sum `x.payable`. `x.amt` is kept on the trip row as `claimed`, and the Adhoc
tab was widened from 10 to 11 columns so **Claimed** and **Payable** are separate: an RTO row reads
₹3,162.95 claimed / ₹0 payable, with the payable in red and a footnote pointing at the dispute reason.
A zero with no explanation reads as a missing number; a zero next to the claim reads as a decision.

**Blast radius across all vendors — 11 trips, ₹31,746 over-billed:**

| vendor | trips | over-billed | MIS adhoc before | after |
|---|---:|---:|---:|---:|
| Pune Logistics | 4 | ₹11,727 | ₹2,50,987 | **₹2,39,260** |
| Ajay Enterprise | 7 | ₹20,019 | ₹1,54,180 | **₹1,34,160** |

Payable falls correspondingly: Pune Logistics ₹3,56,097 → **₹3,44,370**, Ajay Enterprise
₹7,04,287 → **₹6,84,267**. No other vendor is affected. **Do not send those two MIS files until the
new `Billing.gs` is pasted.**

**Guardrail.** `testkit/_adhocrtotest.js`, 27 assertions, including two parity assertions — the panel's
adhoc sum must equal the MIS's adhoc total over the same rows — plus a non-vacuity check that
reproduces the old ₹14,562.95-vs-₹9,000 gap on the fixture. Suite is now **967 assertions across 18
harnesses**.

---

## 2 · Data problem — four disputes were resolved into the wrong column

Found while checking the first. Pune Logistics has **eight** RTO-origin adhoc trips, not four. The other
four had a dispute resolved on 03 Sep by Sharan, and the resolution went into the wrong field:

| sheet row | dispute id | trip | `resolved_challan_type` | `resolved_amount` | vendor claimed |
|---:|---|---|---|---|---:|
| 376 | `DSP-20260902145111-6249` | `TR-72098869-1816` | **3262** | *(blank)* | 6,800 |
| 377 | `DSP-20260902145118-9323` | `TR-13068299-5863` | **3000** | *(blank)* | 3,600 |
| 378 | `DSP-20260902145125-8543` | `TR-61978891-1358` | **3083** | *(blank)* | 3,600 |
| 379 | `DSP-20260902145131-8791` | `TR-17742878-7647` | **3052** | *(blank)* | 3,200 |

An **amount** was typed into the **challan type** column, and the amount column was left empty. Two
consequences:

- `challan_type_final` on those trips is now `"3262"`, `"3000"`, `"3083"`, `"3052"` — not a challan
  type at all. It happens to lift the RTO flag, because the test is `startsWith('rto')` and a number
  does not, so the trips became payable. **The intended outcome was reached by accident.** It breaks
  the moment anything validates that column, and it makes the MIS unreadable to a vendor who is told
  his challan type is "3000".
- Because `resolved_amount` is blank, each trip pays its **original system amount**, not the resolved
  one. So the vendor is paid **₹12,276.75** where Sharan's figures total **₹12,397** — ₹120.25 short,
  and ₹4,923.25 short of the ₹17,200 claimed. That gap will come back as a re-dispute.

All four sit at `Pending Reconfirmation`, so nothing has been accepted yet.

**Correction, per row:** put the figure in **`resolved_amount` (column AK)** and put
**`Forward Only`** in **`resolved_challan_type` (column AN)** — which is what the vendor asked for on
all four (`claim_challan_type = Forward Only`). Then run **`4 · Apply vendor actions NOW`**; the applier
is idempotent and reconciles on every pass, so it will pick the corrections up without any other step.

One judgement call for ground: Sharan's figures (3262 / 3000 / 3083 / 3052) are each below the claim,
and one vendor note reads *"ADDING 2 ROUTE AMOUNT IN THIS"* against a ₹6,800 claim settled at ₹3,262.
If those were negotiated numbers, use them as they stand. If they were meant to be the claim, the four
rows are ₹4,923.25 light.

---

## Why the panel was right and the MIS was wrong

Worth stating, because it is the reverse of the usual assumption. The panel is what the vendor
confirmed against, and it applied the ONE RTO RULE correctly. The MIS is the newer surface and it drifted.
Where the two disagree on money, **the panel is the reference** until proven otherwise — the vendor has
already acted on it.
