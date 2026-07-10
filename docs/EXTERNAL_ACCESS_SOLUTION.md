# External Access — the problem and the fix

## The problem you spotted (and it's a real one)

A Google Apps Script web app deployed under a **Meesho Workspace** account is governed by your Workspace admin's
sharing policy. Two things bite:

1. **"Anyone" (public) deployment is usually disabled** for Workspace orgs. The most open setting you can pick is
   often **"Anyone at Meesho"** — which forces a Meesho Google login. External transporters (Gmail, Yahoo, their own
   company domains) simply **cannot open the URL**; they hit a Google sign-in wall for a domain they don't belong to.
2. **You can't (and shouldn't) share the Google Sheet with vendors.** Even if you could, that exposes every vendor's
   data to every other vendor and lets them edit the source of truth.

So Apps Script's "execute as me / anyone" model — which is what the current build assumes — **won't reach external
emails inside Meesho's policy.** Good catch; better now than after onboarding vendors.

> Note: the current Apps Script build is **still valuable** — you (a Meesho account) can deploy it as
> "Anyone at Meesho" and run the **entire end-to-end demo internally today** (all logic, UI, scoping, OTP). It's the
> fastest way to validate the product before investing in external infra. The migration below reuses ~90% of it.

---

## The fix: a thin backend you own + the Sheet stays private

Move the **frontend and a small backend** off Apps Script onto a host that serves the public internet
(**Vercel**, or **Firebase/Cloud Run** if you'd rather stay inside Google). The backend reads the Sheet using a
**Google service account** — so the Sheet is shared with *one machine identity*, never with vendors.

```
   Transporter (any email, any domain)
        │  HTTPS  (public Vercel URL)
        ▼
 ┌───────────────────────────────────────────────┐
 │  VERCEL  (Next.js — UI + API routes)           │
 │                                                │
 │  POST /api/auth/request-otp                    │
 │       → make 6-digit code, store in Redis(TTL) │
 │       → email it (Resend / SES / Meesho SMTP)  │
 │  POST /api/auth/verify-otp                     │
 │       → check code → set signed JWT cookie     │
 │            (httpOnly; carries oracle + role)   │
 │  GET  /api/data                                │
 │       → verify JWT → read Sheet (svc acct)     │
 │       → scope by oracle → return panel JSON    │
 │  GET  /  → the same panel UI (read-only)       │
 └───────────────┬───────────────────────────────┘
                 │ Google Sheets API (service-account key in env var)
                 ▼
        Google Sheet  (PRIVATE — shared ONLY with the
        service-account email as Viewer; vendors get nothing)
```

### Why this solves it
- **External emails work** — the public URL is served by Vercel, not gated by Workspace policy.
- **The Sheet stays private** — vendors never get Google access; only the service account (a Meesho-owned identity) can read it.
- **Same security model** — scope (oracle) is signed into the JWT and re-checked server-side on every `/api/data` call. A vendor cannot request another oracle's data.
- **It's the build-plan's own Stage 2/3** — "lift the frozen schema behind a thin backend + web app." The **sheet schema, the mapping logic, and the UI do not change** — only where they run.

### What changes vs the Apps Script version
| Concern | Apps Script (now) | Vercel (external) |
|--------|-------------------|-------------------|
| Serve UI | `doGet` + HtmlService | Next.js page (same HTML/CSS/JS) |
| Client → server | `google.script.run` | `fetch('/api/...')` |
| Read the Sheet | `SpreadsheetApp.getActive()` | `googleapis` + service account |
| OTP store | CacheService | Redis (Upstash / Vercel KV) — serverless is stateless |
| Session | Script Properties token | signed **JWT** in httpOnly cookie (stateless) |
| Send email | `MailApp` | Resend / Amazon SES / Meesho SMTP |
| Mapping logic | `_buildVendorPayload` | **same function, ported to Node** (already plain JS) |

---

## What you'll need to provision (one-time)

1. **Google Cloud project + service account** (in a Meesho GCP project ideally):
   - Enable the **Google Sheets API**.
   - Create a service account → create a **JSON key**.
   - **Share the Google Sheet** with the service account's email (`…@…iam.gserviceaccount.com`) as **Viewer**.
   - Scope the key to Sheets **read-only**.
2. **Vercel project** (free tier is fine for the pilot) with env vars:
   - `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, `SHEET_ID`
   - `JWT_SECRET` (random 32+ bytes)
   - `OTP_STORE_URL` / token (Upstash Redis or Vercel KV)
   - email-provider key (e.g. `RESEND_API_KEY`) and a verified **From** address/domain.
3. **A transactional email path** with good deliverability (see the decision below).

---

## Alternatives (and why the above wins)

- **A · Ask Workspace admin to allow this one app to deploy publicly.** Possible, but policy-dependent, slow, revocable,
  and you're still bound by Apps Script execution quotas (~8–10 clusters, per build-plan §G). Not a foundation.
- **B · Deploy the Apps Script under a personal (non-Meesho) Google account.** Public deployment works, but it puts
  **Meesho vendor data under a personal account** — a governance/compliance red flag. **Avoid.**
- **C · Firebase Hosting + Cloud Functions (stay in Google).** Functionally identical to Vercel, with one advantage:
  the service-account key **never leaves Google**, and you could even use **Firebase Auth email-link / passwordless**
  instead of hand-rolling OTP. If Meesho is a GCP shop, this is arguably the cleaner long-term home. Vercel wins on
  developer speed and is fine for the pilot; Firebase wins on staying inside Meesho's Google trust boundary.
- **D · Keep the Sheet only as the ops surface; copy transferred rows into a small DB (Postgres/Supabase) that the
  backend reads.** This is the natural next step past ~8–10 clusters and removes Sheets quotas entirely. The Vercel
  backend is written the same way; only the "read source" swaps. Not needed for the pilot, but the path is clean.

**Recommendation:** Vercel + service account + own OTP + JWT for the pilot (fastest to external users), with Firebase
noted as the "stay-in-Google" variant and a DB swap reserved for scale. All three keep the schema, mapping, and UI intact.

---

## Open decisions before I build the Vercel version
1. **Framework:** Next.js (recommended — API routes + the panel in one deploy) or a plain static page + serverless functions?
2. **Email sending:** Which provider do you have/approve — **Resend**, **Amazon SES**, **SendGrid**, or a **Meesho SMTP relay**? (Drives deliverability + which secret goes in.) This is the single biggest external dependency.
3. **OTP/rate-limit store:** OK to add **Upstash Redis / Vercel KV** (free tier)? Serverless needs an external store for OTPs.
4. **Service account:** Can you create a GCP service account and share the Sheet with it — or should the backend read from a **DB copy** instead of Sheets directly?

Answer these and I'll scaffold the full Vercel repo (Next.js app, the three API routes, the ported mapping, and env-var/deploy instructions), reusing the exact UI and mapping already built and tested here.
