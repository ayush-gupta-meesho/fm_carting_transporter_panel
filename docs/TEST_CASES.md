# VALMO Transporter Panel — End-to-End Test Checklist

Run these against the **sample data** (`sample-data/VALMO_Sample_Data.xlsx`) after deploying.
Every expected value below has already been **verified in code** against the backend mapping (22/22 automated checks pass);
this list is for confirming the same holds live in the browser.

**Sample logins (all use email OTP):**

| Email | Oracle | Vendor | Purpose |
|-------|--------|--------|---------|
| `vendor1@example.com` | ORC-4521 | Rajkot Movers Pvt Ltd | Main vendor — 3 contracts, 2 clusters, all trip types |
| `vendor2@example.com` | ORC-9902 | Saurashtra Logistics | Isolation target (must never see V1's data) |
| `vendor3@example.com` | ORC-7783 | Kutch Transport | Registered but **zero** transferred trips (empty state) |
| `disabled@example.com` | ORC-4521 | — | `active = No` (must be blocked) |
| `ground.ops@meesho.com` | — | — | `role = ground` (not a vendor; must be blocked in Stage 1) |
| `notregistered@example.com` | — | — | Not in Access_Control (must be blocked) |

> To receive real OTP emails during testing, add **your own email** as an `ORC-4521` vendor row, or run the `seedDemo()`
> helper which auto-registers your Google account. Sample `@example.com` addresses won't receive mail.

---

## A. Authentication

- [ ] **A1 — Send code (happy path):** Enter a registered email → "Send login code" → a 6-digit code arrives by email; UI advances to the code step.
- [ ] **A2 — Verify code:** Enter the correct code → signed in, panel loads. (Session lasts 8h.)
- [ ] **A3 — Wrong code:** Enter a wrong code → "Incorrect code. N attempt(s) left." Counter decrements.
- [ ] **A4 — Attempt lockout:** 5 wrong codes → OTP burned, told to request a new one.
- [ ] **A5 — Expiry:** Wait >10 min, then verify → "Code expired or not found."
- [ ] **A6 — One-time use:** Use a valid code once (success), then try the same code again on a new login → rejected.
- [ ] **A7 — Resend cooldown:** Click "Send login code" twice quickly → second attempt asks you to wait.
- [ ] **A8 — Unregistered email (`notregistered@…`):** → "not registered … contact your VALMO ops SPOC." No code sent.
- [ ] **A9 — Disabled account (`disabled@…`):** → blocked (treated as not registered). No code sent.
- [ ] **A10 — Non-vendor role (`ground.ops@…`):** → "This portal is for transporters only."
- [ ] **A11 — Malformed email:** `abc` → "Please enter a valid email address."
- [ ] **A12 — Session persistence:** After signing in, reload the tab → still signed in (no re-OTP).
- [ ] **A13 — Sign out:** Click "Sign out" → returns to login; reload → still logged out.

## B. Scoping & isolation (build-plan gateways G6 / G7)

- [ ] **B1 — Oracle scope (G6):** Sign in as `vendor1@…` → only **Rajkot Movers** contracts show. No Saurashtra / Kutch data anywhere.
- [ ] **B2 — Cross-vendor isolation (G6):** Sign in as `vendor2@…` → sees only the single 22ft Rajkot contract and its 2 trips; none of V1's trips.
- [ ] **B3 — State scope (G7):** As `vendor1@…`, confirm trip `TR-11000007` (a Regular 64 km trip with `sent_to_vendor_flag = No`) does **not** appear anywhere. Total C1 trips shown = 6, not 7.
- [ ] **B4 — No client tampering:** (Optional dev check) The data call sends only the session token; the oracle is read server-side from the session, so there is no client field to tamper with.
- [ ] **B5 — Empty vendor:** Sign in as `vendor3@…` → one contract card may show with 0 KM; trip MIS shows "No transferred trips… yet." No error.

## C. L1 — contract list & header

- [ ] **C1 — Header (vendor1):** Name "Rajkot Movers Pvt Ltd", Oracle "ORC-4521", **Total Contracts = 3**, **Actual KM Counter (MTD) = 4,236**, **Clusters = 2**.
- [ ] **C2 — Pending strip:** "You have N trips pending confirmation" reflects the count of `pending` trips across all contracts.
- [ ] **C3 — Three contract cards:** Rajkot · 7ft · 3 veh · 12hr; Rajkot · 10ft · 2 veh · 24hr; Morbi · 7ft · 2 veh · 12hr.
- [ ] **C4 — Under-slab card (Rajkot 7ft):** KM bar shows **346 / 7,000 km**, no "+extra".
- [ ] **C5 — Over-slab card (Rajkot 10ft):** KM bar shows **3,500 / 3,200 km** with an amber **"+300 extra"** overflow segment.
- [ ] **C6 — Filters:** Cluster = Morbi shows only the Morbi card; Vehicle Size = 10ft shows only that card; search by "morbi" filters correctly; "no match" message when nothing matches.

## D. L2 — contract detail (open Rajkot 7ft)

- [ ] **D1 — Summary title:** "Rajkot Movers Pvt Ltd × Rajkot × 7ft × 3 Vehicles × 12hr", correct contract ID + duration.
- [ ] **D2 — Total KM slab bar:** "**346** actual KMs run of **7,000** Total KM Slab", "Within Total KM Slab".
- [ ] **D3 — Over-slab bar (Rajkot 10ft):** "**3,500** … of **3,200**", "**+300 km extra @ ₹20/km**".
- [ ] **D4 — Value breakup table:** Row1 = 2 Vehicles · 2,000 km each = 4,000 km · ₹1,28,000; Row2 = 1 Vehicle · 3,000 km · ₹1,32,000; **Total = 3 Vehicles · 7,000 km · ₹2,60,000**.
- [ ] **D5 — Breakup note:** "Up to 7,000 km … covered by ₹2,60,000. KMs beyond … at ₹20/km."

## E. Vehicle-level table (Rajkot 7ft)

- [ ] **E1 — Rows:** 3 Default vehicles (V1 GJ03-AA-1001, V2 …1002, V3 …1003) + 1 **Replacement** vehicle (V4 GJ03-AA-1099).
- [ ] **E2 — Tags:** Default vehicles tagged **Default**; V4 tagged **Replacement** — and shows **NO "Replacing Vx"** here (correct per G9, since a replacement vehicle can cover multiple defaults).
- [ ] **E3 — Replacement aggregation:** V4 shows **Regular KMs = 132** (72 + 60), **Regular Trips = 2**.
- [ ] **E4 — Type filter:** "Replacement" filter shows only V4; "Default" shows only V1–V3.
- [ ] **E5 — Drill-in:** Click V4 → jumps to Trip MIS filtered to V4's trips.

## F. Trip MIS (per-contract & global)

- [ ] **F1 — Sub-tabs & counts:** All / Pending Confirmation / Confirmed show correct counts; switching filters the table.
- [ ] **F2 — Billing badges:** Regular trips show blue **Regular**; adhoc shows amber **Adhoc**.
- [ ] **F3 — Replacement tag (trip level, G10):** Trip `TR-11000003` shows **Replacement Regular** + "**Replacing GJ03-AA-1001 (V1)**"; `TR-11000004` shows "**Replacing GJ03-AA-1002 (V2)**". This is the one place "Replacing Vx" appears.
- [ ] **F4 — Adhoc row (`TR-11000005`):** KMs/Amount column shows **₹1,450** "adhoc amount"; no KM; Replacement column shows "—".
- [ ] **F5 — RTO row (`TR-11000006`):** shows grey **"RTO · 0 km"** + "Not accumulated"; status **✓ Confirmed**.
- [ ] **F6 — Long route (`TR-11000001`):** route renders "RJS → 3 nodes → IDF" with a tooltip listing the middle nodes.
- [ ] **F7 — Status column:** Pending rows show "Pending Confirmation" + "Dispute open till <date>"; confirmed rows show "✓ Confirmed". **No Confirm/Dispute buttons** (read-only Stage 1).
- [ ] **F8 — Filters:** Billing = Adhoc shows only adhoc; Show = "RTO-only" shows only the RTO trip; "KM-bearing only" hides RTO.
- [ ] **F9 — Global MIS:** From the pending strip, the global view lists trips across all 3 contracts with a **Contract ID** column.
- [ ] **F10 — CSV download:** "⬇ Download" produces `VALMO_trips_export.csv` with all visible trips and correct columns (KM vs Adhoc amount vs RTO).

## G. Mapping correctness (spot-checks vs the sheet)

- [ ] **G-a — KM aggregation:** Sum of Regular non-RTO `total_trip_km` per contract equals the L2 "Actual KMs Run" and the card counter (346 / 3,500 / 390).
- [ ] **G-b — Vx labelling:** Default vehicles labelled by `day1_order` (1→V1…); a trip vehicle not in Contract_Vehicles becomes the next V-number and is tagged Replacement.
- [ ] **G-c — billing_type_final precedence:** If `billing_type_final` is set it wins over `billing_type_system`.
- [ ] **G-d — Confirmed hides window:** A confirmed trip shows no "dispute open till" date.

## H. Resilience / edge

- [ ] **H1 — Decorative header rows:** If you paste data into a sheet that still has the R1 title rows above the header, the reader still finds the header row (scans first 8 rows). Verify data still loads.
- [ ] **H2 — Blank / placeholder rows:** "(enter rows below…)" placeholder rows and fully-blank rows are skipped.
- [ ] **H3 — Missing optional fields:** A trip with blank `dispute_window_end` still renders (shows "—").
- [ ] **H4 — Re-deploy required:** After editing code, confirm changes only appear after "Manage deployments → New version."

---

### Automated coverage already in place
The backend mapping is unit-tested in Node against this exact sample data. Covered automatically:
G6/G7 scoping, empty-vendor, KM aggregation (346/3500/390/4236), tier grouping, replacement vehicle covering
two defaults (V4 km=132), adhoc/RTO handling, long-route parse, and cross-vendor isolation. Re-run instructions
are in `PROJECT.md`.
