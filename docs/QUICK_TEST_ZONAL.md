# Quick test — zonal as RFQ, panel actions, MIS rollup

**~10 minutes, in order.** Every expected value below is computed from the **live** "FM Carting - Panel"
sheet as it stands (32 trips, 11 zonal), so you can compare literally. Anything that does not match is a
real failure, not a rounding difference.

Prerequisite: `Code.gs`, `Actions.gs`, `Billing.gs` pasted into Apps Script and saved, `index.html` pushed
to Vercel.

---

## 0 · Automated first (2 min) — do this before touching the sheet

PowerShell has no `&&` — one command per line:

```powershell
cd testkit
npm i playwright
npx playwright install chromium
node _mkpayload.js
node _apitest.js     # expect: ALL 19 CHECKS PASSED
node _uitest.js      # expect: ALL 207 CHECKS PASSED
node _billtest.js    # expect: ALL 22 CHECKS PASSED
```

If either fails, stop — the bug is in the code, not in your sheet, and the failure line names it.

---

## 1 · Transfer (menu 4)

| # | Do | Expect |
|---|---|---|
| 1.1 | Clear **AH `sent_to_vendor_flag`** on the 11 zonal rows (`TR-ZT-0001`…`0012`). Also clear **AG, AI, AK** for a fresh 15-day window. Leave **AJ `vendor_status`** alone to keep the Reconfirm case. | — |
| 1.2 | Run **menu 4 · Apply vendor actions NOW** | alert reports **11** trips transferred, then the sync line. Menu 4 already syncs — do **not** also run menu 3. |
| 1.3 | Look at the 11 rows again | `AH = Yes`, `AI` timestamped, `AK dispute_window_end` ≈ **today + 15 days**, `AJ` = `Pending` (and `Reconfirm` still on `TR-ZT-0008`) |
| 1.4 | Run **menu 4** again immediately | reports **0** transferred. This is correct — already-flagged rows are skipped. |
| 1.5 | `Ground_Confirmation_Log` | 11 new rows. `route_scope = Zonal`, and **`contract_id` holds the RFQ id**, not a blank |

> If 1.2 reports 0 on the first run, `sent_to_vendor_flag` was still `Yes` — that was the original
> confusion, not a bug.

---

## 2 · L1 card list (log in as the vendor)

Expect **5 zonal RFQ cards**, one per RFQ, plus a Zonal Adhoc bucket:

| Card name | RFQ ID line | Trips | Amount |
|---|---|---|---|
| Morbi · … · Zonal · FM-Zonal-EGZ-RFQ-0002 | `RFQ ID: FM-Zonal-EGZ-RFQ-0002` | 1 | **₹4,400** |
| Rajkot · … · Zonal · FM-Zonal-RDB-RFQ-0003 | `RFQ ID: FM-Zonal-RDB-RFQ-0003` | 1 | **₹4,700** |
| Rajkot · … · Zonal · FM-Zonal-RDE-RFQ-0006 | `RFQ ID: FM-Zonal-RDE-RFQ-0006` | 1 | **₹5,300** |
| Rajkot · … · Zonal · FM-Zonal-REB-RFQ-0005 | `RFQ ID: FM-Zonal-REB-RFQ-0005` | 4 | **₹15,900** |
| Rajkot · … · Zonal · MIG-FM-Aug-Zonal-EMG_ENH-RFQ-001 | `RFQ ID: MIG-…-001` | 1 | **₹5,900** |
| **Zonal Adhoc Trips** | `ORC-…_Zonal_Adhoc_Trips` | 3 | **₹10,900** |

| # | Check |
|---|---|
| 2.1 | Exactly **5** cards say `· Zonal ·`, and no two card names are identical |
| 2.2 | No card anywhere shows `ZONAL::` or `::ZONAL` |
| 2.3 | Every zonal card's id line reads **`RFQ ID: …`**, not `Contract ID:` |
| 2.4 | The 5 zonal amounts sum to **₹36,200**; + ₹10,900 adhoc = **₹47,100** |
| 2.5 | Local cards are unchanged — Rajkot 7ft 1,428 km, Rajkot 10ft 3,500 km (+300 extra), Morbi 7ft 390 km |
| 2.6 | Filter **Vehicle Size = 7ft** → the 7ft zonal cards stay, the 10ft one drops |

---

## 3 · Zonal L2 header (open `FM-Zonal-REB-RFQ-0005`)

| # | Check |
|---|---|
| 3.1 | Title: `<vendor> × Rajkot × … × Zonal × FM-Zonal-REB-RFQ-0005` — no `ZONAL::` |
| 3.2 | Mono line: `RFQ ID: FM-Zonal-REB-RFQ-0005 · Period: …` |
| 3.3 | A **teal note band** below it (body font, not monospace) saying a zonal trip has no contract ID |
| 3.4 | The two tiles read **`4 ZONAL TRIPS`** and **`₹15,900 TOTAL PAYABLE`** — no em dashes |
| 3.5 | **No Vehicle tab** — it lands straight on the trip list |
| 3.6 | **No Replacement column** in the table (it is meaningless on zonal) |
| 3.7 | `TR-ZT-0002` shows **`RTO · 0 km` / `Not payable`**, not ₹5,300 |

---

## 4 · The Action column — the one that broke

| # | Do | Expect |
|---|---|---|
| 4.1 | On any card, **do not scroll sideways** | **ACTION** is the rightmost column and is fully visible |
| 4.2 | Narrow the browser to roughly half your screen | Action stays **pinned** to the right edge with a soft shadow; the other columns scroll under it |
| 4.3 | A pending trip inside its window (`TR-ZT-0010`, or any zonal row after step 1) | **Confirm** + **Raise Dispute** |
| 4.4 | `TR-SYNC-NOW` / `TR-SYNC-GATE` (windows closed 1 Jul) | **Confirm** + muted **"Dispute window closed"**, hover shows the date. No Raise Dispute link. |
| 4.5 | `TR-ZT-0008` (Reconfirm) | **Accept** + **Re-dispute** |
| 4.6 | A confirmed row | `no action` |
| 4.7 | Tick 2–3 checkboxes | bulk bar appears → **Confirm Selected** posts, toast says "apply on the next sync" |

---

## 5 · The zonal dispute (this is the flow that was showing `null km`)

| # | Do | Expect |
|---|---|---|
| 5.1 | **Raise Dispute** on `TR-ZT-0001` (zonal Regular) | header `TR-ZT-0001 · FM-Zonal-REB-RFQ-0005` + a teal **Zonal** chip |
| 5.2 | Categories | `Wrong billing type` / **`Wrong amount`** / **`Wrong RFQ ID`** — no "Wrong KM" |
| 5.3 | Tick **Wrong amount** | Current amount **₹5,300**. Never `null km`. |
| 5.4 | Tick **Wrong RFQ ID** | one pair only — Current / Correct RFQ ID. **No separate Contract ID field** |
| 5.5 | Tick **Wrong billing type** | **no** aggregate-against-vehicle dropdown, and a note that the engine owns it |
| 5.6 | Submit with the amount blank | blocked: "Please enter the correct amount." |
| 5.7 | Amount `abc` | blocked: "Please enter a valid number." |
| 5.8 | Amount `6200`, RFQ `FM-Zonal-REB-RFQ-0009`, no callback | blocked: callback required |
| 5.9 | Add callback + proof, submit | toast "finalizes on the next sync"; row flips to **⚑ Disputed** |
| 5.9b | **This is the one that was broken.** `api/action.js` did not copy `claim_zonal_amount` / `claim_rfq_id` into the queued action, so the claim arrived blank while everything else looked fine. `_apitest.js` now guards it. Make sure the new `api/action.js` is deployed to Vercel before testing. |
| 5.10 | Run **menu 4**, check `Disputes_Log` | **`claim_zonal_amount = 6200`**, **`claim_rfq_id = FM-Zonal-REB-RFQ-0009`**, `claim_km` **blank**, `claim_aggregate_vehicle` **blank**, `orig_route_scope = Zonal`, `orig_rfq_id`, `orig_zonal_rfq_amount = 5300`, `contract_id` = the **RFQ id**, `categories` contains **`Wrong zonal amount`** and **`Wrong RFQ`** |
| 5.11 | Same on a **local** trip (`TR-ZT-0010`) | categories still `Wrong KM / Amount` + `Contract / RFQ ID mismatch`; posts `claim_km`, never `claim_zonal_amount` |
| 5.12 | Click **View dispute** on the zonal row after the sync | shows `Was ₹5,300 → Corrected ₹6,200`, `Was RFQ ID`, `Correct RFQ ID`, and a **Zonal** chip. No "Resolved KM" row. |

---

## 6 · Ground cannot edit zonal (`ZONAL_NOT_EDITABLE`)

| # | Do | Expect |
|---|---|---|
| 6.1 | On a zonal row, clear `AH` and type `Adhoc` into **`billing_type_final`** | — |
| 6.2 | Run **menu 4** | `billing_type_final` is **cleared back to blank** |
| 6.3 | `Ground_Confirmation_Log` newest row | `ground_action_state = ZONAL_NOT_EDITABLE`, `partial_edit_flag = Yes`, and `data_sent` names the **RFQ**, telling you to fix it in the data engine |
| 6.4 | The panel still shows that trip as **Regular** | the ground edit was ignored, as designed |

---

## 7 · Dispute resolution on zonal

| # | Do | Expect |
|---|---|---|
| 7.1 | In `Disputes_Log`, on the 5.10 row set `resolved_zonal_amount = 6200`, `resolved_rfq_id = FM-Zonal-REB-RFQ-0009`, `resolution_note`, `resolved_by`. Also fill `resolved_km = 999` and `resolved_billing_type = Adhoc` **deliberately** | — |
| 7.2 | Run **menu 4** | `Trip_Level.zonal_rfq_amount_final = 6200`, `rfq_id` updated to `…-0009`, and **`total_trip_km` / `billing_type_final` untouched** — the run log notes they were ignored on a zonal row |
| 7.3 | Panel | the trip reads **₹6,200**, status **Pending Reconfirmation**, with **Accept** / **Re-dispute** |
| 7.4 | The card | the trip has **moved** to the `…-0009` card (the RFQ is the contract reference, so correcting it re-attributes the trip) |

---

## 8 · CSV export

| # | Check |
|---|---|
| 8.1 | **Download** on the global Trip MIS |
| 8.2 | First column header reads **`Contract ID / Zonal RFQ ID`** |
| 8.3 | Zonal rows carry the **RFQ id** there — never `ZONAL::…` and never the bucket name |
| 8.4 | `Route Scope`, `RFQ ID`, `Zonal Amount (INR)` columns present |
| 8.5 | RTO zonal rows export **0**, matching the screen |

---

## 9 · MIS (menu 9 → menu 10)

| # | Check |
|---|---|
| 9.1 | **Menu 9** — `Cost_View_All` has a zonal figure for this vendor, and it is **₹47,100** |
| 9.2 | `Validation_Gates` — **"Every zonal trip carries an RFQ ID"** is present and **clear** |
| 9.3 | **Menu 10** — the Excel downloads with tabs **Summary · Local · Zonal · Adhoc** |
| 9.4 | Summary shows **one line per zonal RFQ** — ₹4,400 / ₹4,700 / ₹5,300 / ₹15,900 / ₹5,900 |
| 9.5 | Then a tinted **`Zonal subtotal`** row = **₹47,100 / 11 trips** (it includes the 3 adhoc) |
| 9.6 | **`TOTAL PAYABLE` does not double-count zonal** — it sums to the row *above* the subtotal. Cross-check: fixed + excess + adhoc + 47,100 |
| 9.7 | Zonal tab — banded by RFQ, and the 6th column reads **`RFQ ID (contract ref)`**, not `Contract` |
| 9.8 | Every one of the 11 zonal trip_ids appears **exactly once** across Local / Zonal / Adhoc |
| 9.9 | Blank one zonal `rfq_id`, re-run menu 9 | the gate flips to **WARN** naming the trip count and ₹, the trip still appears under `(no RFQ id)`, and **₹47,100 does not change** |

---

## The three failure modes worth remembering

1. **"The panel is wrong."** → Has a sync run? The panel reads the Upstash snapshot, never the sheet
   live. Menu 4 syncs; menu 3 syncs only.
2. **"Menu 4 moved 0 trips."** → `sent_to_vendor_flag` was already `Yes`. Correct behaviour.
3. **"The buttons are missing."** → Check `vendor_status` is `Pending`/`Reconfirm` first, then window
   width. Action is pinned now, so it should never be the second one again.
