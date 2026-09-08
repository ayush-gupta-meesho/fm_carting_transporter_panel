# Resolved disputes never reached the trip row — 166 live corrections lost

**27 Aug 2026.** Reported as: *"once the vendor has confirmed the trips with revised KM amounts, he is
seeing the original disputed KM amounts; in disputed trips, once we had resolved, he was able to see
resolved new KMs."*

---

## What is actually wrong

**Not one of 166 resolved disputes on the live sheet had ever reached `Trip_Level`.** In all 166 rows
`total_trip_km` still equals `orig_total_km`. The resolved figure exists only in `Disputes_Log`.

```
Disputes_Log rows with dispute_status = Resolved      167
  … carrying a resolved_km                            166
  … where Trip_Level.total_trip_km == resolved_km       0     <-- none
  … where Trip_Level.total_trip_km == orig_total_km    166     <-- all
resolved_km found in ANY Trip_Level column (40 cols)    0
Σ (resolved_km − orig_total_km)                   1,974.216 km
All 166 belong to one vendor: Krushiv Enterprise (18838)
```

The hunch that a **bulk confirmation** pushed the old values is ruled out — see §5. Nothing the vendor
did caused this; the correction never left `Disputes_Log`.

## Root cause — the guard was stamped before the values were read

`applyResolutionsFromSheet()` used `resolved_at` as a permanent "already applied" marker:

```js
if (val(i, 'dispute_status').toLowerCase() !== 'resolved') continue;   // TRIGGER
if (val(i, 'resolved_at')) continue;                                   // GUARD: skipped forever
var tripId = val(i, 'trip_id');
_setCell(dl, i, 'resolved_at', now);          // <-- stamped HERE, before any resolved_* is looked at
…
ow('total_trip_km', val(i, 'resolved_km'));   // ow() skips blanks
```

So the ordinary ops sequence loses the number:

| | action | effect |
|---|---|---|
| 1 | Ops fills `resolution_note`, sets `dispute_status = Resolved` | `resolved_km` still blank |
| 2 | The 10-min timer (or menu 4) fires | `resolved_at` **stamped**, trip → `Reconfirm`, **nothing written** |
| 3 | Ops types `resolved_km` | lands in `Disputes_Log` only — the row is now skipped forever |

The live data proves this is what happened, not a theory:

- `resolved_at` has **4 distinct values shared by 141 / 14 / 11 / 1 rows**, each group identical to the
  second. `now` is computed once per run, so that is 4 machine runs, not human typing.
- `Confirmation_Status_View` has **166 rows with `dispute_status = Resolved`** and per-row
  `status_updated_at`. `_upsertStatusView()` only runs inside the applier — so the applier definitely
  executed on every one of these rows.
- `resolution_note` is the identical sentence *"We have reviewed and resolved."* on all 166 — a
  fill-down. And `resolved_km` **equals `claim_km` exactly in 166 of 166** — a second fill-down, from
  the claim column, done afterwards.

Applier ran → guard stamped → status flipped → no value written. Exactly the sequence above.

## Why it looked like confirming reverted the value

Two panel defects hid it, and made the moment of acceptance look like the cause:

1. **The KM cell showed `t.km` and nothing else.** A corrected trip and an uncorrected one rendered
   identically, so the row never said the number had been revised. And `t.km` was the *original*,
   because `total_trip_km` was never updated.
2. **`index.html` line 1050 gated the "View dispute" link on `status==='disputed'||'reconfirm'`.** The
   Resolution block inside that dialog reads `resolved_km` **live from `Disputes_Log`** via `dmap` —
   which is the only place the panel ever showed the resolved figure. The moment the vendor pressed
   Accept the trip became `confirmed`, the link vanished, and the resolved KM became unreachable.

So the vendor saw 183 km while deciding (in the dialog), accepted, and was left looking at 167.074 km
on the row with no way back to the resolution. From their seat that is a revert.

## And it was a billing bug, not only a display bug

`Billing.gs` and the panel both call `_classifyTrip()`, which read `_num(t.total_trip_km)`. So the MIS
billed the uncorrected KM too. On these two contracts it happens to cost nothing today:

| contract | slab KM | Σ KM as-is | Σ KM corrected | position | ₹ effect |
|---|---:|---:|---:|---|---:|
| RJK10-18838-20260801-01 | 66,000 | 39,865.686 | 40,459.062 | under slab both ways | **₹0** |
| RJK8-18838-20260801-01 | 17,500 | 11,492.784 | 12,873.624 | under slab both ways | **₹0** |

**No money is owed right now** — both contracts sit well below slab, so no excess KM is triggered
either way. The exposure is that the same defect on a contract at or over slab pays the wrong amount
(here it would have been ₹20,945 at `ex_km_rate` if the KM were billable), and that 1,974 km of
utilisation is understated on every report.

---

## The fix — three defects, three changes

### 1 · A resolution no longer writes over the system column

`resolved_km` and `resolved_amount` were the **only** two resolvable fields written destructively into
the column the engine owns. Every other one already had its own destination:

| field | ground writes | resolution writes |
|---|---|---|
| billing type | `billing_type_final` | `billing_type_resolved` |
| RTO / challan | `challan_type_final` | `challan_type_final` |
| zonal amount | — | `zonal_rfq_amount_final` |
| replacement vehicle | `replaced_default_vehicle_final` | `replaced_default_vehicle_final` |
| **KM** | — | ~~`total_trip_km`~~ → **`total_trip_km_resolved`** |
| **adhoc amount** | — | ~~`adhoc_amount`~~ → **`adhoc_amount_resolved`** |

**Two new Trip_Level columns**, appended at the **end** of the schema (`setupSheet()` writes headers
across `headers.length` columns, so inserting mid-list would relabel live columns and misalign every
row). Consequences: the original stays auditable, any re-push of `Trip_Level` can no longer silently
revert a correction, and you can tell a resolved KM from a system KM by looking.

`_classifyTrip()` now reads resolution-then-system, via a `_firstSet`-style explicit blank test rather
than `||` — a dispute resolved to **0 km** is a real outcome and must not fall through:

```js
var kmSys = _num(t.total_trip_km);
var kmRes = _s(t.total_trip_km_resolved);
var km    = kmRes !== '' ? _num(kmRes) : kmSys;
```

Ground deliberately gets **no** KM column. There is no `total_trip_km_final` and there must not be one.

### 2 · `resolved_at` no longer skips the row

It now gates only the **one-time, vendor-facing side effects** — the flip to `Reconfirm` and the
`Confirmation_Status_View` upsert, which notify the vendor and must happen exactly once. The **value
writes run on every pass and are idempotent**, compared cell by cell against their destination.

The function is therefore self-healing: a number filled in after the first pass lands on the next run,
and it is **reported** (`RECONCILED DSP-… : total_trip_km_resolved: <blank> → 183`) rather than lost.
An accepted trip is never reopened and the vendor is never notified twice.

A `Resolved` row with no `resolved_*` value **and** no `resolution_note` is now called out as a probable
half-finished edit — but still applied, because "reviewed, no change" is a real outcome and the vendor
is owed the answer.

The trip lookup also falls back from `trip_id` to `row_id`. Not hypothetical: dispute
`DSP-20260824113254-2626` carries `TR-59335170-3079_R` (the row_id) in its `trip_id` column and matches
no `Trip_Level.trip_id` at all. A dispute that matches nothing is now **named** in the return message
instead of silently skipped.

### 3 · The panel carries the correction on the row

- The KM cell shows the resolved figure with a green **"revised from 167.074 km"** chip beneath it,
  driven by a new `kmWas` / `amtWas` field on the payload (`null` when nothing was resolved, and `null`
  when a resolution merely confirmed the system value).
- **"View dispute" is now shown whenever the trip has a dispute**, not only while it is open, and reads
  **"View resolution"** once settled.

### Plus: `menu 5a · Repair missed resolutions`

`repairMissedResolutions()` — **dry run by default** — walks every Resolved dispute, ignores
`resolved_at` entirely, and writes any resolved value whose destination differs. It never touches
`vendor_status` (a vendor who accepted this correction should not be asked again), never writes a system
column, never notifies anyone, and names any missing column instead of silently doing nothing.

---

## What to do, in order

1. **Paste `Code.gs` and `Actions.gs`** into Apps Script.
2. **Run `1 · Create / verify tabs`.** This appends `total_trip_km_resolved` and `adhoc_amount_resolved`
   to `Trip_Level` (columns 41 and 42). Nothing applies until these two columns exist — the repair tool
   will tell you so by name rather than failing quietly.
3. **Run `5a · Check resolutions are in sync`** (read-only). Expect ~166 rows out of sync and a KM
   delta of **+1,974.216**, all oracle `18838`. Then run **menu 4** to apply them — the applier is now
   self-healing, so that is all it takes. Re-run 5a afterwards; it should report 0.
4. **Deploy the panel** — merge to `main`, since Vercel builds production from `main`.
5. **Run `4 · Apply vendor actions NOW`** so the snapshot the panel reads is rebuilt.

Then check one trip end to end: `TR-59335170-3079` should read **183 km** with *"revised from 167.074
km"*, and **View resolution** should still be there on a settled row.

## Also found, not fixed here

- **`categories` is the literal string `value`** on 166 of 167 dispute rows — a paste artefact. The
  panel's `_catLabel()` will render "value" as the reported reason.
- **`Confirmation_Status_View` and `Disputes_Log` disagree**: the view says `reconfirm_status =
  Reconfirmed` for 165 rows, `Disputes_Log` still says `Pending Reconfirmation` for all 167.
  `applyConfirm()` upserts the view but never writes back to `Disputes_Log`.
- **`/api/action`'s `ACTIONABLE` map accepts `reconfirm` inside a bulk confirm.** The UI does not offer
  it — the row checkbox renders only for `status==='pending'` (now pinned by a test) — so a bulk accept
  of unreviewed resolutions is currently impossible. That render gate is the only thing preventing it.
- **`adhoc_amount` is populated and non-zero on all 166 rows** despite every one being `Regular`
  (Σ ₹527,292.185). Harmless today because a Regular trip bills off KM, but worth understanding.

## Tests

`testkit/_kmresolvetest.js` (56 assertions) and `testkit/_resolveduitest.js` (26, Playwright) are new.
`_importtest.js` grew 60 → 87 and `_flowtest.js` 10 → 13; **`_importtest` section 7 previously asserted
the bug as a guarantee** ("a stamped row is skipped forever, safe on a timer") and has been rewritten to
the new contract. Suite: **15 harnesses, 802 assertions, all passing** (was 13 / 690).

Both new harnesses end with a non-vacuity section that restores the old behaviour and proves the
harness fails: reverting the KM precedence, and simulating the old `resolved_at` gate.

The parity check in `_importtest` earned its keep during this change — it caught a first cut of the
idempotent write helper that compared `_num()` on anything containing a digit, so `RJK7-X` and
`RJK10-Y` both reduced to `0` and a `contract_id` correction was silently treated as already applied.
`_sameCell()` now only compares numerically when both sides *are* numbers, and `_kmresolvetest` §4 pins
that directly.
