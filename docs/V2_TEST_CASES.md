# V2 Test Cases — confirm / dispute / reconfirmation / admin

Covers the write-back workflow (C4–C6) + the admin utilization view. Run after the V2 deploy steps below.
The core logic is already unit-tested in node (drain 16/16, action-gate 5/5, reconfirm+import 13/13, admin math 8/8);
this is the live end-to-end pass.

Legend: 🖥️ Apps Script editor · 📊 Google Sheet · ☁️ Vercel · 🌐 browser.

---

## Deploy delta (what changed for V2)

**Apps Script** — add the new file and re-paste the updated ones:
- 🖥️ Add **`Actions.gs`** (new). Re-paste **`Code.gs`** and **`Sync.gs`** (updated).
- The **VALMO Panel** menu now has **"4 · Apply vendor actions NOW (drain + sync)"** and **"5 · Import resolved disputes (CSV)"**.
- First run of the drain/import may prompt for extra authorization (UrlFetch already granted; the CSV import needs **Drive** access — approve it).

**Vercel** — commit + push the changed files (`api/action.js`, `api/upload-proof.js`, `api/config.js`, `api/data.js`, `api/request-otp.js`, `api/verify-otp.js`, `lib/core.js`, `package.json`, `.env.example`, `index.html`). Then:
- ☁️ **Storage → Create a Blob store → connect to project** (auto-sets `BLOB_READ_WRITE_TOKEN`).
- ☁️ Add env **`PROOF_MODE=blob`**. Redeploy.

**Admin user** — 📊 add a row to `Access_Control`: `admin@meesho.com | (blank oracle) | (blank name) | admin | | Yes`, then re-sync (menu 4). The sync now also writes an `admin:all` key.

> Flow reminder: vendor acts on the panel → action queues in Upstash → you run **menu 4** (drain + sync) → the Sheet updates and the panel reflects it on reload. **Sync is manual during testing, so menu 4 is the "apply" button.**
>
> **How this becomes automatic at go-live:** run **menu 6 · Turn ON auto-apply** once. It creates a time-driven trigger that runs the drain + sync every ~10 minutes with no clicks — so a vendor's confirm/dispute lands in the Sheet and refreshes the panel within that window. Menu 7 turns it back off. The interval is tunable in `Actions.gs` (`createDrainSyncTrigger`); per the earlier cost analysis, ~10–30 min stays well within the Upstash free tier, and since trips only surface 24h after completion, near-real-time isn'''t needed.

---

## A. Confirm (single + bulk)

- [ ] **A1** 🌐 As a vendor, open a contract → Trip MIS → a **Confirm** button and a **Raise Dispute** link show on each pending row; a checkbox column + "Confirm Selected" bar appear.
- [ ] **A2** Click **Confirm** on one trip → toast "Confirmed — applies on the next sync"; the row optimistically shows ✓ Confirmed / "applying on next sync…".
- [ ] **A3** 🖥️ Run **menu 4 (Apply vendor actions)** → alert reports "applied 1". 📊 `Trip_Level.vendor_status` = **Confirmed** for that trip; `Confirmation_Status_View` has a row with vendor_status Confirmed.
- [ ] **A4** 🌐 Reload the panel → the trip shows **✓ Confirmed** (authoritative, no "pending" note).
- [ ] **A5 — Bulk:** select 2–3 pending trips → **Confirm Selected** → menu 4 → all flip to Confirmed.
- [ ] **A6 — Locking:** try to confirm an already-confirmed trip (there's no button, but re-running menu 4 or a stale request is a no-op) → no double-write.

## B. Dispute (with proof)

- [ ] **B1** 🌐 Click **Raise Dispute** on a pending trip → modal opens with the 3 categories (Wrong billing / Wrong KM-Amount / Contract-RFQ), category-specific fields, a **required proof upload**, callback, description.
- [ ] **B2 — Proof required:** submit without attaching a file → blocked ("Please attach a proof file").
- [ ] **B3** Pick a category (e.g. Wrong KM), enter a value, attach an image/PDF, submit → toast "Dispute submitted"; row optimistically shows ⚑ Disputed.
- [ ] **B4** 🖥️ Menu 4 → 📊 `Disputes_Log` has a new row: green claim fields + **teal `orig_*` snapshot** of the trip + **`proof_url`** (a Vercel Blob URL) + dispute_status **Open**. `Trip_Level.vendor_status` = **Disputed**; `Confirmation_Status_View` shows Disputed + dispute_id.
- [ ] **B5** Open the `proof_url` in a browser → your uploaded file loads.
- [ ] **B6** 🌐 Reload → the trip shows **⚑ Disputed / under review**, no action buttons (locked).
- [ ] **B7 — Adhoc dispute:** raise a dispute on an Adhoc trip → the "Wrong Amount" field appears (not KM); billing-flip offers the default-vehicle aggregate dropdown (from `Contract_Vehicles`).
- [ ] **B8 — Ownership:** (dev check) a dispute for a trip not in your account is rejected by `/api/action`.

## C. Admin resolution + reconfirmation (C5 → C6)

- [ ] **C1** Prepare a resolved-disputes CSV with header `dispute_id, resolution_note, resolved_km, resolved_billing_type, resolved_by` and one row referencing an open `dispute_id` from `Disputes_Log` (e.g. resolved_km = a corrected value). Upload it to Drive.
- [ ] **C2** 🖥️ **Menu 5 (Import resolved disputes)** → paste the Drive file ID/URL → alert "applied 1". 📊 `Disputes_Log` red block filled (resolved_*, resolved_at, dispute_status **Resolved**, reconfirm_status **Pending Reconfirmation**); `Trip_Level` fields overwritten (e.g. total_trip_km = resolved value); `Trip_Level.vendor_status` = **Reconfirm**.
- [ ] **C3** 🖥️ Menu 4 (sync) → 🌐 reload panel → the trip now shows **↻ Pending Reconfirmation** with **Accept** and **Re-dispute** buttons, and the **corrected values**.
- [ ] **C4 — Accept:** click **Accept** → menu 4 → `Trip_Level.vendor_status` = **Reconfirmed**; panel shows ✓ Confirmed. `Confirmation_Status_View.reconfirm_status` = Reconfirmed.
- [ ] **C5 — Re-dispute:** on another reconfirm trip, click **Re-dispute** → new `Disputes_Log` row (same row_id, fresh dispute_id, reconfirm_status **Re-disputed**); vendor_status back to Disputed. (No dispute-window block on a re-dispute.)

## D. Admin utilization view

- [ ] **D1** 🌐 Log in with the **admin** email → instead of the vendor panel you see **"All-Vendor KM Utilization"**: header tiles (Contracts / Over-utilised / Under-utilised / On track).
- [ ] **D2** The table lists **every contract across all vendors** with Vendor, Contract, Cluster, Size, KM Slab, Actual, Expected-to-date, Projected, Util %, Proj %, and an **OVER / UNDER / ON-TRACK** badge.
- [ ] **D3** Sanity-check one row: `expected_to_date ≈ slab × (days elapsed / total days)`; `projected ≈ actual × (total / elapsed)`; a contract projected above its slab shows **OVER**; well below shows **UNDER**.
- [ ] **D4** Filters (Cluster / Status / search) narrow the table; **Download** exports the utilization CSV.
- [ ] **D5 — Scoping:** the admin sees all oracles; a vendor never sees the admin view (role is enforced server-side in `/api/data`).

## E. Idempotency / resilience

- [ ] **E1** Run **menu 4 twice** in a row → the second run applies nothing (dedupe by action_id + trip already locked). No duplicate `Disputes_Log` rows.
- [ ] **E2** A dispute on a trip whose `dispute_window_end` has passed → the drain rejects it (dead-lettered to `actions_dead`), the trip stays pending. (Re-disputes after resolution are exempt.)
- [ ] **E3** Confirm/dispute while the Blob token or Upstash is misconfigured → the panel shows a clear error, nothing half-writes.

---

### Swapping proof to Google Forms later
Set `PROOF_MODE=form` + `DISPUTE_FORM_ADHOC` / `DISPUTE_FORM_REGULAR` env vars, and build the two forms + an `ingestProofs()` reconciler. The dispute modal then shows an "Open proof form" link instead of the file input — no change to the `Disputes_Log` write path.
