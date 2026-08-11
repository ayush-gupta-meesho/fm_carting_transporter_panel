# Zonal / Local route scope — schema and rules

**Status: built and verified 2026-08-07.** Decisions 1–8 confirmed by Ayush, plus the identity
amendment in §0 (a zonal trip has no `contract_id`). This document is the contract between the data
engine, the Apps Script backend, the Vercel panel and the Billing MIS.

Verified by four harnesses in `testkit/` — `_apitest.js` (22, the dispute-claim contract across all three
hops), `_uitest.js` (225, real browser), `_billtest.js` (30, real Billing.gs vs an independent sum) and
`_resolvetest.js` (15, does an upheld resolution actually change what the trip pays). Run all four before
any push.

Route scope is a **second axis alongside Regular/Adhoc**, not a third billing type. Every trip has
both a `route_scope` and a `billing_type`.

---

## 0. The identity rule — a zonal trip has no `contract_id`

**Amended 2026-08-07.** A zonal trip does not belong to a carting contract at all, so the engine leaves
`contract_id` blank. **`rfq_id` is the contract reference for a zonal trip.** Everything downstream keys
on that:

| | Local | Zonal |
|---|---|---|
| Billing reference | `contract_id` | **`rfq_id`** |
| Vendor attribution | `contract_id` → `Contract_Info` | **`transporter_oracle_id` on the trip row** |
| Panel card | one per `contract_id` | **one per `rfq_id`**, internal id `ZONAL::<rfq_id>` |
| Cluster / size / period | `Contract_Info` | **derived from the card's own trips** (no RFQ master tab) |
| KM slab, vehicle rows, utilisation % | yes | never |
| MIS Summary | one line per contract | **one line per `rfq_id` + a Zonal subtotal** |
| Log tabs (`contract_id` column) | `contract_id` | `rfq_id` — written by `_billRef()`, with `route_scope` alongside |

### Zonal ADHOC has no RFQ id — and that is not a missing value

A zonal **Regular** trip bills at its RFQ rate, so `rfq_id` is its billing reference. A zonal **Adhoc**
trip bills on `adhoc_amount`; **no RFQ rate applies, so the engine leaves `rfq_id` blank by design.**
The two must never be treated the same way:

| | Zonal Regular | Zonal Adhoc |
|---|---|---|
| `rfq_id` | required — it is the billing reference | **blank, correctly** |
| Blank `rfq_id` means | a data problem → **WARN gate** | nothing; it is the normal state |
| Panel card | its own card per `rfq_id` | the vendor-level `<oracle>_Zonal_Adhoc_Trips` bucket |
| Contract / RFQ ID column | the RFQ id | **`Zonal adhoc`** — never `(no RFQ id)` |
| MIS Summary | one line per `rfq_id` | **one `Zonal adhoc trips` line**, never a phantom `(no RFQ id)` RFQ line |
| MIS Zonal tab | banded per RFQ | one trailing `Zonal adhoc — billed on amount, no RFQ rate` band |
| Dispute categories | billing type · amount · **RFQ id** | billing type · amount only — **no RFQ category**, there is no RFQ to dispute |

The gate is therefore **"Every zonal REGULAR trip carries an RFQ ID"**. Scoping it to Regular is not a
softening: without it the gate would WARN forever on correct data, and a warning that is always on is a
warning nobody reads.

If the engine *does* stamp an `rfq_id` on a zonal adhoc trip, it is kept and displayed — the RFQ column
and the dispute category come back. The rules above key off "is the rfq_id actually there", not off a
hard-coded assumption.

Two consequences worth stating plainly:

1. **There is no RFQ master tab.** Cluster, vehicle size, period and last-trip date are the mode / min /
   max of the card's own trips, and the amount is whatever `zonal_rfq_amount` says. Nothing validates a
   trip's amount against a contracted RFQ rate — that is a conscious trade for zero ops overhead, and the
   place to revisit if amounts start drifting.
2. **A blank `rfq_id` on a zonal REGULAR trip is a data problem** — it is the contract reference. Such
   trips still bill (the engine set the amount) but group under `(no RFQ id)` and raise a `WARN` gate.
   They are never dropped. On a zonal **Adhoc** trip a blank `rfq_id` is normal — see the table above.

If the engine *does* stamp a `contract_id` on a zonal row, it is ignored for grouping and billing. The
`route_scope != Zonal` filter in `_misBuildContracts` is belt-and-braces so such a row still cannot reach
a slab, a vehicle row or a utilisation %.

---

## 1. New columns — the complete set

Column **position is irrelevant to the code**: `_readTab()` finds columns by header name, and
`Actions.gs` writes via a header lookup (`_setCell`). So the order below is Ayush's chosen order,
placed for readability, and nothing breaks by inserting mid-table.

### `Trip_Level` — 5 new columns (40 total)

| Position | Column | Type | Written by | Values / notes |
|---|---|---|---|---|
| 9 (after `trip_cluster`) | `route_scope` | varchar | **engine (system)** | `Local` \| `Zonal`. Blank reads as `Local`. |
| 10 | `rfq_id` | varchar | **engine (system)** | the zonal RFQ this trip billed against. Blank for Local. **On a zonal trip this is the contract reference — see §0.** |
| 25 (after `replaced_default_vehicle_system`) | `zonal_rfq_amount` | decimal | **engine (system)** | fixed payable for a Zonal + Regular trip. Blank/0 for Local. |
| 31 (after `challan_type_final`) | `zonal_rfq_amount_final` | decimal | **dispute resolution only** | written by the resolution appliers when an amount dispute is upheld. Ground can never type here. |
| 32 (new, 2026-08-07) | `billing_type_resolved` | varchar | **dispute resolution only** | where an upheld billing-type resolution lands, on **both** scopes. Highest authority. Ground can never type here — a value on an untransferred row is cleared and flagged. See §4c. |

**No `route_scope_final`** — scope is system-defined (rule i). The ground-editable set stays at four:
`ground_confirmed`, `billing_type_final`, `replaced_default_vehicle_final`, `challan_type_final`.

**No `rfq_id_final`** — a corrected RFQ id is recorded in `Disputes_Log.resolved_rfq_id`. The amount is
what bills, so `zonal_rfq_amount_final` is sufficient on the trip row.

Zonal adhoc cost uses the existing **`adhoc_amount`** (rule ii). The live column is `adhoc_amount`,
not `adhoc_cost`.

### `Disputes_Log` — 10 new columns

Vendors can dispute billing type, amount and RFQ (decision 5), and the panel must be able to render
"was X, you claim Y" — which needs the original snapshotted, exactly as `orig_total_km` and
`orig_adhoc_amount` already are for local trips.

| Column | Type | Notes |
|---|---|---|
| `claim_zonal_amount` | decimal | what the vendor says the amount should be |
| `claim_rfq_id` | varchar | what the vendor says the RFQ should be |
| `orig_route_scope` | varchar | snapshot — written by `applyDispute()` |
| `orig_rfq_id` | varchar | snapshot |
| `orig_zonal_rfq_amount` | decimal | snapshot — without this the dispute card cannot show the before-value |
| `resolved_zonal_amount` | decimal | ground's answer → applied to `Trip_Level.zonal_rfq_amount_final` |
| `resolved_rfq_id` | varchar | ground's answer → applied to `Trip_Level.rfq_id` on a zonal row (it is the billing reference; see §0) |
| `claim_challan_type` | varchar | posted automatically when a vendor claims a KM or amount on an **RTO** trip — see §4d |
| `orig_challan_type` | varchar | snapshot of `challan_type_final \|\| challan_type` |
| `resolved_challan_type` | varchar | ground's answer → applied to `Trip_Level.challan_type_final` on **both** scopes. This is what lifts an RTO. |

New `categories` values (no schema change): **`Wrong zonal amount`**, **`Wrong RFQ`**.

### `Ground_Confirmation_Log` — 1 new column

| Column | Type | Notes |
|---|---|---|
| `route_scope` | varchar | so a `ZONAL_NOT_EDITABLE` entry is self-explanatory and the log can be filtered by scope. `billing_before` / `billing_after` / `data_sent` / `partial_edit_flag` already exist and need no change. |

### `Confirmation_Status_View` — 1 new column

| Column | Type | Notes |
|---|---|---|
| `route_scope` | varchar | lets acceptance % be reported local vs zonal without joining back to `Trip_Level`. |

**Total: 17 new columns across 4 tabs** (13 original + `Trip_Level.billing_type_resolved` and three
`Disputes_Log` challan columns added 2026-08-07). Add them in one pass.

## 4c. An upheld dispute CAN flip a zonal trip's billing type — through its own column

Rule (iii) says ground can never revert a zonal classification. It says nothing about a dispute that ops
has examined and upheld, and a vendor who is billed Regular on a trip that was genuinely Adhoc needs a
route. **A resolution may now flip it — by writing `billing_type_resolved`, a column only the two
resolution appliers ever touch.**

**One precedence, both scopes — `resolution > ground > system`:**

```
billing = billing_type_resolved                       // resolution appliers only, BOTH scopes
       || (zonal ? '' : billing_type_final)           // ground — LOCAL only (rule iii on zonal)
       || billing_type_system                         // the engine
```

So `resolved_billing_type` always lands in **one** column whatever the scope, and `Trip_Level` can be read
without first checking whether a trip is local or zonal. The only scope-dependent term is ground's
`billing_type_final`, which is skipped on zonal — that is rule (iii), now visible in a single expression
instead of two divergent ones.

Ground keeps its column and still reclassifies **local** trips exactly as before; a resolution simply
outranks it. On zonal, ground never counted and still does not.

Sharing `billing_type_final` was tried and rejected: it is a *ground* column, so any stray ground edit on a
row the `ZONAL_NOT_EDITABLE` guard never saw would silently re-price the trip. The `TR-ZT-0006` demo row is
exactly that case and moved ₹4,800 the moment the columns were shared — which is what caught it.

**And a resolution cannot predate a dispute.** `transferReadyTrips()` clears any `billing_type_resolved`
found on a row that has never been sent to a vendor — on both scopes — and flags it in
`Ground_Confirmation_Log.data_sent`. A hand-typed cell must never outrank the engine.

**Guard: a flip that would zero the trip is refused.** A zonal Adhoc trip bills `adhoc_amount`. The engine
populates `adhoc_amount` on every trip, so in practice the flip has a value to land on and this guard never
fires — it costs nothing when the data is right. But if `resolved_billing_type = Adhoc` and *both*
`resolved_amount` and the existing `adhoc_amount` are empty, the applier **refuses the flip** and logs
`REFUSED flip to Adhoc — the trip would pay 0. Fill resolved_amount and re-run.` A ₹5,300 trip must never
silently become a ₹0 trip because one field was empty.

(The zonal Regular rows in `testkit/demo-data` have a blank `adhoc_amount` — that is a gap in the demo
fixture, not a description of production. It is what the guard is tested against.)

## 4d. Disputing an RTO trip — the vendor just claims the KM or amount

An RTO trip pays nothing whatever its scope (the ONE RTO RULE), and the classifier applies that *before*
any amount: `payable = rto ? 0 : …`, `km = rto ? 0 : km`. So an upheld amount or KM dispute on an RTO trip
used to be a **proven no-op** — the resolution wrote a value the classifier then discarded.

`challan_type_final` is an **override** column: blank is its correct resting state, and it stays blank
whenever ground has nothing to change — exactly like the other three `_final` columns. The problem was
never that it was empty; it was that **nothing in the panel, the API or the appliers could ever write it**,
so the one lever that clears RTO had no handle. Now:

- The vendor sees no new category. On an RTO trip the ordinary **Wrong KM / Amount** panel explains that
  entering a value is *also* a claim that this was not an RTO trip, and the panel posts
  `claim_challan_type = 'Forward Only'` alongside the value. The vendor is never asked to name a challan
  type from a list they do not use.
- Ops answers with `resolved_challan_type`, which writes `Trip_Level.challan_type_final` on **both** scopes
  — a challan is a fact about the trip, not a routing classification the engine owns.
- Everything else follows automatically through the shared classifier: the trip stops being RTO, and its
  KM re-enters the slab or its amount becomes payable.

Verified by `testkit/_resolvetest.js`: a zonal RTO goes ₹0 → ₹5,300, a local RTO's 180 km enters the slab,
and a local Adhoc RTO recovers ₹4,944 — while writing `zonal_rfq_amount_final` or `total_trip_km` alone
still changes nothing, which is what made the old path dead.

## 2. The amount matrix — scope × billing × RTO

| Route scope | Billing | RTO | Amount paid | KM into slab |
|---|---|---|---|---|
| Local | Regular | no | — (KM aggregates into the slab) | **Yes** |
| Local | Regular | yes | — | No (shown at 0 km) |
| Local | Adhoc | no | `adhoc_amount` | No |
| Local | Adhoc | yes | `adhoc_amount` | No |
| Zonal | Regular | no | `zonal_rfq_amount_final \|\| zonal_rfq_amount` | No |
| Zonal | Regular | **yes** | **₹0 — nothing is paid** (rule 8) | No |
| Zonal | Adhoc | no | `adhoc_amount` | No |
| Zonal | Adhoc | **yes** | **₹0 — nothing is paid** (rule 8) | No |

**Only Local + Regular + non-RTO KM ever aggregates into the grouped KM slab.** Zonal KM never
touches a slab, a vehicle row, or a utilisation %.

Billing formula per contract, unchanged in shape:

```
payable = fixed_monthly_value
        + MAX(0, Σ Local Regular non-RTO KM − grouped_km_slab) × ex_km_rate
        + Σ Local  adhoc_amount
        + Σ Zonal  zonal_rfq_amount   (non-RTO only)
        + Σ Zonal  adhoc_amount       (non-RTO only)
```

---

## 3. Classification — the shared classifier

`_classifyTrip()` in `Code.gs` gains the scope axis. On a zonal trip ground's `billing_type_final` is
ignored outright, so rules (i) and (iii) hold by construction rather than by guard alone:

```
scope    = route_scope || 'Local'                       // system only, no _final
isZonal  = lower(scope) === 'zonal'
billing  = isZonal ? billing_type_system                // ground edits ignored on zonal
                   : (billing_type_final || billing_type_system)
isAdhoc  = lower(billing) === 'adhoc'
rto      = (challan_type_final || challan_type) startsWith 'rto'  [+ the zero-km fallback]
zonalAmt = rto ? 0 : (zonal_rfq_amount_final || zonal_rfq_amount)
amount   = isZonal ? (isAdhoc ? (rto ? 0 : adhoc_amount) : zonalAmt)
                   : (isAdhoc ? adhoc_amount : null)
kmToSlab = !isZonal && !isAdhoc && !rto
```

---

## 4. Guards — `Actions.gs`

1. **Zonal trips are EXEMPT from the reclassification guard.** Not optional: 11 of the 14 zonal
   vehicles seen in July are not contract defaults, so without the exemption every zonal trip would be
   reverted to Adhoc and stamped `NEEDS_ATTRIBUTION_FIX`.
2. **New guard `ZONAL_NOT_EDITABLE`.** On a zonal row, if ground has set `billing_type_final` or
   `replaced_default_vehicle_final`, clear it, write `partial_edit_flag = Yes`,
   `ground_action_state = ZONAL_NOT_EDITABLE`, and a `data_sent` hint naming the engine as the place to
   fix it. Scope and billing on zonal are system outcomes.
3. **`applyResolutionsFromSheet()` is exempt from guard 2** for the amount, and only for the amount: an
   upheld dispute writes `zonal_rfq_amount_final` / `rfq_id_final`. It must **not** write
   `billing_type_final` on a zonal row — a billing-type dispute on zonal is fixed in the engine, not in
   the sheet.
4. The vehicle-dropdown validation (menu 8) skips zonal rows — `replaced_default_vehicle` is
   meaningless there.

---

## 4b. The vendor action flow — what has to be true for Confirm / Raise Dispute to appear

Three separate gates, each with a different owner. When a vendor says "the buttons are missing", it is
always one of these:

| Gate | Owner | Symptom when it blocks |
|---|---|---|
| `sent_to_vendor_flag = Yes` | menu 4 `transferReadyTrips()` (or the engine) | the trip is not on the panel at all |
| a sync has run since | menu 3 / 4 → Upstash | the panel shows the *previous* snapshot; the sheet looks right and the panel does not |
| `vendor_status` is `Pending` or `Reconfirm` | the vendor's own last action | the row shows "Confirmed" / "Disputed" and reads `no action` |

`transferReadyTrips()` stamps four things, flag **last** so a half-written row is retried rather than
stranded: `dispute_window_end = now + DISPUTE_WINDOW_DAYS` (15), `vendor_status = Pending`,
`sent_to_vendor_timestamp`, then `sent_to_vendor_flag = Yes`.

**A row that arrives with `sent_to_vendor_flag` already `Yes` is skipped** — correctly, it is already
transferred — so it never gets a `dispute_window_end` either. Demo/test rows must therefore be pasted with
`ground_review_deadline`, `sent_to_vendor_flag`, `sent_to_vendor_timestamp`, `vendor_status` and
`dispute_window_end` all **blank**, and menu 4 left to fill them. `sample-data/zonal_demo_rows.csv` ships
that way. Paste it pre-flagged and menu 4 reports "0 moved", which reads as a bug and is not one.

**The panel will not offer an action the backend rejects.** `applyDispute()` throws once
`dispute_window_end` has passed, so the trip row shows a muted *"Dispute window closed"* in place of the
Raise Dispute link (Confirm stays — confirming has no window). A blank `dispute_window_end` counts as open,
matching the backend, which only enforces a window it can read. The payload carries the raw timestamp as
`winTs` next to the display string `win` for exactly this comparison.

**The Action column is pinned to the right edge of the trip table** (`position:sticky`). With ten columns
it overflows below ~1400px, and before pinning it, Confirm and Raise Dispute scrolled out of sight — the
vendor could not act at all. Verified visible down to 1152px by `testkit/_uitest.js`.

## 5. Panel layout

Zonal trips get **one card per `rfq_id`**, built at vendor level, alongside (not inside) the local
contract cards:

- **Card label** — `<cluster> · <size> · Zonal · <rfq_id>`, with a teal badge. Internal id
  `ZONAL::<rfq_id>`; the id line reads `RFQ ID: <rfq_id>`.
- **L2 lands straight on the Trip tab; the Vehicle tab is hidden.** There is no vehicle-level
  definition for zonal. This reuses the existing `isAdhocBucket` mechanism, so it is a flag, not new
  navigation code.
- **Zonal adhoc** goes to a vendor-level bucket card `<oracle>_Zonal_Adhoc_Trips`, mirroring the
  existing `ADHOC-<oracle>` Other-Adhoc badge.
- Trip rows show a teal `Zonal` badge next to the Regular/Adhoc badge — two axes, both visible.
- A **Route filter (All / Local / Zonal)** in the Trip MIS.
- Local cards show a one-liner outside the slab: *"Zonal: N trips · ₹X — fixed per trip, not part of
  the KM slab."*
- Vendors can confirm and dispute zonal trips exactly as they do local ones, with the two new dispute
  categories available.

### 5.1 Card naming — the RFQ id carries the name

Because the RFQ id *is* the contract reference, it carries the card name:
`<cluster> · <size> · Zonal · <rfq_id>`. Cluster and size are there for human orientation and come from
the card's own trips. The meta line reads Cluster / Vehicle Size / Trips / Period, and the id line reads
`RFQ ID: <rfq_id>` with a tooltip explaining that a zonal trip has no contract ID.

This also settles the earlier collision — two zonal cards in one cluster used to read identically
("Rajkot · Zonal Routes" twice) because they were keyed on contracts that were not in the name. Keyed on
the RFQ, they cannot collide: the key is in the label.

The internal id `ZONAL::<rfq_id>` (and the pre-amendment `<contract>::ZONAL`) is **never shown to a
vendor** — `_cidLabel()` strips both from the card id line, the L2 title, the Contract pill in the global
Trip MIS, the dispute modal header and the CSV export.

### 5.2 The dispute modal is scope-aware

A zonal trip carries no KM and no vehicle-level split, so the local modal rendered `Current KM: null km`
on it. The category set and every panel now switch on scope:

| | Local | Zonal |
|---|---|---|
| Category 2 | `Wrong KM / Amount` → `claim_km` (Regular) / `claim_amount` (Adhoc) | `Wrong amount` → **`claim_zonal_amount`** (Regular) / `claim_amount` (Adhoc) |
| Category 3 | `Contract / RFQ ID mismatch` → `claim_contract_id` | `Wrong RFQ ID` → **`claim_rfq_id`** (required). There is no separate contract-id field: the RFQ id *is* the contract reference. |
| Billing panel | shows the aggregate-against-default-vehicle dropdown | dropdown suppressed; a note says the engine owns it (rule iii) |
| `Disputes_Log.categories` | `billing` / `value` / `rfq` | `Wrong billing type (zonal)` / `Wrong zonal amount` / `Wrong RFQ` |

An RTO trip of either scope shows `₹0 — RTO, not payable` rather than a KM or amount, matching the ONE
RTO RULE. `_buildDisputeMap()` in `Code.gs` carries `claim_zonal_amount`, `claim_rfq_id`,
`orig_route_scope`, `orig_rfq_id`, `orig_zonal_rfq_amount`, `resolved_zonal_amount` and `resolved_rfq_id`
into the payload — without them the View-Dispute dialog could not render a zonal dispute at all.

---

## 6. Mixed-use vehicles — no change, by decision

Three July vehicles drew a local fixed fee **and** ran zonal: `GJ10TY4293` (default on
`RJK8-18838`, ₹24,720/mo, zero local trips, 17 zonal trips ₹1,00,300), `GJ03BY2262`
(`RJK17-13551`, ₹41,715/mo, 14 zonal), `GJ03CU2168` (`RJK10-18838`, ₹32,445/mo, 1 zonal). Total
₹1.91 L of zonal on vehicles already on a local fixed fee.

**Decision: keep the current logic.** Those vehicles are being paid for the replacements run against
them, so the local fixed fee is earned regardless. No pro-ration, no roster change, no slab
adjustment. Recorded here so the question is not re-opened.

Side effect worth knowing: this is what the MIS `Exceptions` block D
("contracted but ran zero trips under its own plate") was flagging on `GJ10TY4293`. Once
`route_scope` lands, that exception explains itself.

---

## 7. CSV exports — there are two, both need the new fields

| Function | In | Today | Change |
|---|---|---|---|
| `downloadCSV()` | `index.html` ~line 943 | vendor trip export, built from the in-memory payload | add `Route scope`, `RFQ id`, `Zonal amount` columns; RTO zonal rows must export ₹0, matching the screen |
| `downloadAdminCSV()` | `index.html` ~line 1163 | admin utilisation export | zonal is excluded from utilisation by design, so add contract-level `Zonal trips` and `Zonal ₹` columns rather than per-vehicle ones |

Both build rows from the payload, so they inherit whatever `Code.gs` puts in it — the payload change is
the real work and the exports are a column list each.

## 8. Dispute resolution workflow

Two appliers write resolutions into `Trip_Level`, both via `ow()` (overwrite only where a `resolved_*`
value is present): the CSV import (`Actions.gs` ~line 331) and `applyResolutionsFromSheet()` (~line 385).
Both need the same two changes:

1. **Add** `ow('zonal_rfq_amount_final', resolved_zonal_amount)`.
2. **Gate** `ow('billing_type_final', resolved_billing_type)` on `route_scope != Zonal`. Today it writes
   unconditionally, which would let a resolution reopen the door rule (iii) closes. A billing-type
   dispute on a zonal trip is recorded and answered by fixing the engine, not by writing the sheet.

`resolved_km` / `resolved_aggregate_vehicle` are meaningless on a zonal row (no slab, no vehicle
mapping) — gate both the same way, so an over-filled resolution CSV cannot corrupt a zonal trip.

**`resolved_rfq_id` now writes `Trip_Level.rfq_id` on a zonal row** (amended 2026-08-07) — it is the
billing reference, exactly as `resolved_contract_id` writes `contract_id` on a local row. The two are
mutually exclusive: `_billRef()` decides which axis a row is on, and `resolved_contract_id` is ignored on
zonal. `resolved_at` remains the already-applied guard.

## 9. MIS changes

- The `Zonal` tab flips from **manual paste to reading `Trip_Level`**, writing `source = trip_level`.
- Zonal is read **once, at vendor level, in `_misReadSource()`** and grouped by `rfq_id`. There is no
  per-contract zonal figure any more — a zonal trip has no contract_id, so there is nothing to prefer
  and nothing to double-count. `_misZonalRfq()` builds `m.zonal.rfqGroups`, which drives both the Zonal
  tab bands and the Summary lines.
- **Summary carries one line per `rfq_id`, then a `Zonal subtotal` row.** The subtotal repeats the lines
  above it, so it is excluded from `TOTAL PAYABLE` — the grand total sums to the row *before* it.
- Zonal is **grouped by `rfq_id`** (decision 7). That separates the migration set
  (`MIG-FM-Aug-Zonal-…`) from standard (`FM-Zonal-…`) with no prefix logic.
- New gate: **"Every zonal trip carries an RFQ ID"** (`WARN`). The amount still bills; the trip just
  cannot be tied to an RFQ line on the vendor's invoice.
- **No exception handling for planned ≠ actual route** (decision 6). 12 of 96 July trips differ, mostly
  node-order flips; they bill at the RFQ rate and the fix stays at RFQ source.
- The vendor MIS `Zonal` tab gains `rfq_id` grouping and an RTO marker showing ₹0 where rule 8 applies.

---

## 10. One open item

**Local + Adhoc + RTO currently pays `adhoc_amount` in full.** Rule 8 says a zonal RTO pays nothing;
the same argument arguably applies locally. There is exactly one live case —
`TR-97835183-4747` on `RJK17-13551-20260717-01`, Adhoc, challan `RTO only`, **₹4,944 paid**. Confirm
whether local adhoc RTO should also pay ₹0, or stay as-is.
