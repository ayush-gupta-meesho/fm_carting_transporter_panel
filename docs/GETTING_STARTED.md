# Getting Started — proceed & test, step by step

The single source of truth for deploying and testing the panel. Covers a **5-minute internal smoke test** (Apps Script
only) and the full **external path** you chose (Sheet → Upstash → Vercel). Reference material (Access_Control schema,
data mapping, security, limits, tuning) is in the Appendix at the bottom.

Legend: 🖥️ = in the Apps Script editor · 📊 = in the Google Sheet · ☁️ = in Vercel · 🌐 = in a browser.

---

## Part 0 — Optional 5-minute internal smoke test (no Upstash/SMTP/Vercel yet)

Proves the panel, mapping, scoping and OTP all work, using only your Meesho Google account.

1. 📊 Create a new Google Sheet → **Extensions → Apps Script** (this binds the script to the Sheet, so no ID is needed).
2. 🖥️ Paste `apps-script/Code.gs` into `Code.gs`. Add an HTML file named exactly **`Index`** (＋ → HTML) and paste `apps-script/Index.html`. Save.
3. 📊 Reload the Sheet → menu **VALMO Panel → 1 · Create / verify tabs**. Approve the auth prompt (Google warns it's an "unverified" app — it's your own script; **Advanced → Go to project → Allow**).
4. 📊 **VALMO Panel → 2 · Seed demo data** — registers *your* Google account as vendor `ORC-4521` and loads test trips.
5. 🖥️ **Deploy → New deployment → Web app** → *Execute as* **Me**, *Who has access* **Anyone at Meesho** → Deploy → open the URL.
6. 🌐 Log in with your Meesho email → OTP arrives → you see the panel. This confirms everything short of external access.

> This internal deploy can't reach external vendor emails (Workspace policy). That's what the external path below fixes.
> When you're happy, delete the seeded rows for a clean sheet and continue.

---

## Part 1 — Google Sheet + Apps Script (the private data source)

1. 📊 Create the Sheet (or reuse the one above). **Extensions → Apps Script**.
2. 🖥️ Ensure the project has **both** `Code.gs` and `Sync.gs` (＋ → Script for the second). Keep `Code.gs` — `Sync.gs` reuses its mapping.
   *(The `Index` HTML file is only needed for the internal Part-0 web app; the external path doesn't use it.)*
3. 📊 Reload the Sheet → **VALMO Panel → 1 · Create / verify tabs**. This creates all 9 tabs with headers on **row 1**:
   `Contract_Info`, `Contract_Vehicles`, `Trip_Level`, `Node_Cluster_Map`, and the new **`Access_Control`** tab (schema in the Appendix).
4. **Load data** (pick one):
   - 📊 Import `sample-data/VALMO_Sample_Data.xlsx` (**File → Import → Upload → Insert new sheets / Replace**), **or**
   - paste each `sample-data/*.csv` under the matching tab's header row, **or**
   - use **VALMO Panel → 2 · Seed demo data** for a quick fill.
5. 📊 In the **`Access_Control`** tab, add a row for **an email you can actually receive mail at**, pointed at an oracle that has trips, e.g.
   `your.email@… | ORC-4521 | Rajkot Movers Pvt Ltd | vendor | | Yes`.
   *(The sample `@example.com` addresses won't receive real OTP mail — add a real one for testing.)*

## Part 2 — Upstash (the fast read store)

6. ☁️ At [upstash.com](https://upstash.com) (or Vercel → Storage → Upstash) create a **Redis** database. Copy the **REST URL** and **REST token**.
7. 🖥️ Apps Script **Project Settings (gear) → Script properties → Add**:
   - `UPSTASH_URL` = the REST URL
   - `UPSTASH_TOKEN` = the REST token
8. 📊 **VALMO Panel → 3 · Refresh panel data (sync only).** Expect a "Sync complete — Synced N access rows + M vendor payloads" alert.
   - ☁️ In Upstash **Data Browser**, confirm keys like `access:your.email@…` and `vendor:ORC-4521` exist.
9. 📊 For hands-off running, **VALMO Panel → 6 · Turn ON auto-apply (drain + sync, 10 min)** — a time trigger that both applies vendor confirms/disputes **and** refreshes Upstash every 10 min. While testing you can skip this and use menu 3 / 4 manually. **Menu 7 · Stop auto-apply** turns it off.

## Part 3 — Vercel (the public app)

10. ☁️ Deploy `vercel-app/`:
    - CLI: `cd vercel-app && npx vercel` (framework preset **Other**; no build step), **or**
    - Dashboard: **Add New → Project**, import the folder/repo, preset **Other**.
11. ☁️ **Settings → Environment Variables** — add everything from `.env.example`:
    `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `JWT_SECRET` (a long random string — `openssl rand -base64 48`),
    `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.
12. ☁️ **Redeploy** (env vars only apply to new deployments). Copy the production URL — that's what you send vendors.

> Local dry-run (optional): `cd vercel-app && npx vercel dev` with a `.env` file, then open `http://localhost:3000`.

## Part 4 — Test the live app 🌐

13. Open the Vercel URL. **Sign in** with the real email you registered → a 6-digit code arrives → enter it → panel loads.
14. **Resend button:** on the code screen, "Resend code" is disabled and counts down from 30s, then enables. Click it → a new code arrives and the countdown restarts. (The server also enforces the 30s cooldown.)
15. **Scoping (G6/G7):** you should see only that oracle's contracts/trips, and never a `sent_to_vendor_flag = No` trip. To prove isolation, register a second email you control against a different oracle (e.g. `ORC-9902`), re-sync (menu 3), log in as that one, and confirm the two never see each other's data.
16. **Walk the checklist:** run `docs/TEST_CASES.md` against the live URL — auth (A1–A13), scoping (B1–B5), L1/L2 (C/D), vehicle table (E), trip MIS (F), mapping spot-checks (G). Expected numbers for the sample data are in that file (e.g. MTD 4,236; over-slab card 3,500/3,200).
17. **Sign out** → returns to login; reload → stays logged out.

## Part 5 — Go live

18. Replace sample data with real Rajkot data in the Sheet (keep headers on row 1). Add real vendor rows to `Access_Control`.
19. Turn on **menu 6 · Turn ON auto-apply** so vendor actions + data refresh run automatically every ~10 min (menu 7 stops it). Send each vendor the Vercel URL. They log in by email — nothing to install, no Sheet access.

---

## Troubleshooting
- **No OTP email:** check `SMTP_*` env vars and that the `SMTP_FROM` domain is approved; see Vercel → Deployment → Functions logs for `request-otp`.
- **"not registered":** the email isn't in `Access_Control`, or you edited the sheet but didn't re-sync (run menu 3).
- **Panel loads empty:** that oracle has no `sent_to_vendor_flag = Yes` trips, or the sync hasn't run — check Upstash for `vendor:<oracle>`.
- **Sync menu error:** `UPSTASH_URL` / `UPSTASH_TOKEN` script properties missing or wrong.
- **Changes not showing:** Vercel env-var/code changes need a **redeploy**; the Apps Script web app (Part 0) needs **Manage deployments → Edit → New version**.

---

# Appendix — reference

## A. The `Access_Control` tab (powers login + scoping)

| Column | Meaning |
|--------|---------|
| `email` | The vendor's login email (matched case-insensitively). One row per authorised email. |
| `vendor_oracle_id` | The oracle this email is scoped to. Must match `transporter_oracle_id` in `Trip_Level`. |
| `vendor_name` | Display name shown in the panel header. |
| `role` | `vendor` (transporter panel) or `admin` (read-only all-vendor utilization view). `ground` is reserved. |
| `cluster_scope` | Optional; leave blank for vendors (scoping is by oracle, and the vendor can filter clusters in-app). |
| `active` | `Yes` to allow login; `No` disables the account without deleting the row. |

**One oracle per email.** A vendor operating two different oracle IDs under one email isn't handled yet — flag it if needed.

## B. How the data maps (so the numbers make sense)

- **Contract card / L2 header** ← `Contract_Info` (cluster, size, hours, ex-km rate, duration).
- **Vehicle V1/V2/V3 labels** ← `Contract_Vehicles` ordered by `day1_order`. A trip vehicle **not** in `Contract_Vehicles` is shown as a **Replacement** vehicle (next V-number).
- **Value breakup table** ← `Contract_Vehicles` grouped by (`pegged_km_slab`, `monthly_rate`).
- **Actual KMs / MTD counter** ← **sum of `total_trip_km`** over that vendor's **Regular, non-RTO** transferred trips (RTO and Adhoc excluded). The panel *aggregates* for display; it never re-classifies.
- **Trip row** ← `Trip_Level`: billing from `billing_type_final` (falls back to `_system`); adhoc amount shown only when final billing = Adhoc; replacement from `replacement_flag_system` + `replaced_default_vehicle_final`; RTO from `challan_type = RTO`; status from `vendor_status`.
- **"Replacing Vx"** shows only at **trip level** (from `replaced_default_vehicle_final`). At **vehicle level** a non-core vehicle is tagged **Replacement** only (build-plan §C3, G9/G10).
- **L1 filters** (Cluster / Vehicle Size / Hours) are built dynamically from the vendor's own contracts.

## C. Security model
- **Scope is derived server-side from the signed session, never from client input** — a vendor cannot request another oracle's data. (Track 1: session token in Script Properties; Track 2: signed JWT cookie + pre-scoped `vendor:<oracle>` in Upstash.)
- OTPs: 6-digit, 10-min expiry, single-use, 5-attempt lockout, 30-second resend cooldown.
- Sessions last 8 hours.
- **Email:** Track 1 uses `MailApp` (~100/day consumer Gmail, ~1,500/day Workspace). Track 2 uses Meesho SMTP.
- **Email enumeration:** the login tells an unregistered email it isn't registered (fine for a closed vendor base). Ask if you'd prefer a generic "if registered, a code was sent" response.

## D. Known limits (Stage 1, by design)
- **Read-only** — no confirm / dispute / admin / reconfirm / archive (build-plan C4–C7).
- **One oracle per email.**
- **Scale:** the Sheet source is good to ~8–10 clusters (build-plan §G); beyond that, swap `Sync.gs` for a DB writer — the API and UI stay the same.
- **CSV download** inside the Apps Script iframe may be blocked by the sandbox; it works on the Vercel deploy.

## E. Tuning knobs
- **Apps Script** (`Code.gs` top): `OTP_TTL_SECONDS`, `OTP_RESEND_COOLDOWN`, `OTP_MAX_ATTEMPTS`, `SESSION_TTL_SECONDS`, `APP_NAME`, `SHEET_ID`.
- **Sync cadence** (`Sync.gs`): the `everyMinutes(10)` in `createSyncTrigger`.
- **Vercel** (`vercel-app/lib/core.js`): `SESSION_TTL`; OTP TTL / cooldown in `api/request-otp.js`.


## F. VALMO Panel menu reference

| Item | What it does | When |
|------|--------------|------|
| **1 · Create / verify tabs** | Creates/repairs the 9 tabs (headers on row 1). | Once, at setup. |
| **2 · Seed demo data** | Loads sample rows + registers your Google email as a vendor. | Testing only. |
| **3 · Refresh panel data (sync only)** | Rebuilds `access:*` + `vendor:*` in Upstash from the Sheet. Does **not** process the action queue. | After editing the Sheet directly (contracts, Access_Control). |
| **4 · Apply vendor actions NOW (drain + sync)** | Applies queued confirms/disputes to the Sheet, then refreshes Upstash. | The manual "apply" button while testing write-back. |
| **5 · Import resolved disputes (CSV)** | Fills `Disputes_Log` red block, overwrites `Trip_Level`, re-surfaces trips for reconfirmation. | When an admin has resolved disputes offline. |
| **6 · Turn ON auto-apply (drain + sync, 10 min)** | A time trigger that runs #4 automatically every ~10 min. | **Go-live** — hands-off operation. |
| **7 · Stop auto-apply** | Removes the auto trigger. | To pause automation. |

**No overlap by design:** #3 refreshes only · #4 = #3 **plus** applying the action queue · #6 = #4 **on a schedule**.
At go-live you normally just turn on **#6**; use #1 at setup, #4 for a manual push, and #5 when resolving disputes.

## G. What changes at go-live (checklist)
1. Replace sample data with real data; keep headers on row 1.
2. Add real vendor rows (and any admin row) to `Access_Control`; run **menu 3** to push them.
3. Turn on **menu 6 · auto-apply** (drain + sync every ~10 min) — this is what makes confirm/dispute automatic.
4. Vercel: confirm `PROOF_MODE=blob` + `BLOB_READ_WRITE_TOKEN` are set; **rotate** the JWT/SMTP/Upstash secrets that were shared during setup.
5. Deploy the Apps Script **web app is NOT needed** on this (Vercel) path — only the triggers.
6. Send vendors the Vercel URL. Nothing to install; no Sheet or Drive access for them.
