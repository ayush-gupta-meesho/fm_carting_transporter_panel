# VALMO Transporter Panel — Vercel app (external-access build)

Public, email-OTP vendor panel for **external transporters** (any email domain). Reads **pre-scoped** data from
Upstash Redis that the Apps Script sync job pushes from the Google Sheet — so **the Sheet is never shared with
vendors and no Google service account is required.**

```
Vendor browser ── HTTPS ──►  Vercel (this app)
                              /            ▲ reads pre-scoped data
                              │ Meesho SMTP│
                              ▼            │
                          OTP email    Upstash Redis
                                           ▲ writes access:* + vendor:* every ~10 min
                                           │
                              Apps Script sync job (runs as you; full Sheet access)
                                           │
                                     Google Sheet (private)
```

## Files
```
vercel-app/
├─ index.html          # login + read-only panel (same UI as Apps Script build; uses fetch)
├─ api/
│  ├─ request-otp.js   # POST — validate email vs access:*, email a 6-digit code via SMTP
│  ├─ verify-otp.js    # POST — check code, set signed JWT session cookie (scope = oracle)
│  ├─ data.js          # GET  — verify JWT, return vendor:<oracle> payload (401 if no session)
│  └─ logout.js        # POST — clear cookie
├─ lib/core.js         # Upstash REST client, HS256 JWT, cookie/body helpers
├─ package.json        # dep: nodemailer (fetch/crypto are built-in on Node 18+)
├─ vercel.json
└─ .env.example
```

## One-time setup

### 1. Upstash Redis
Create a database at [upstash.com](https://upstash.com) (or Vercel → Storage → Upstash). Copy the **REST URL** and **REST token**.

### 2. Meesho SMTP
Get the transactional SMTP host / port / user / pass and an approved **From** address from your platform/IT team.

### 3. Deploy to Vercel
```bash
cd vercel-app
npx vercel        # or connect this folder as a Vercel project in the dashboard
```
Framework preset: **Other** (static + serverless — no build step). Then add **Environment Variables**
(from `.env.example`): `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `JWT_SECRET` (a long random string),
`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Redeploy after setting them.

### 4. Wire the Apps Script sync (the data feed)
In the Apps Script project that has `Code.gs` + `Sync.gs`:
1. **Project Settings → Script properties:** add `UPSTASH_URL` (the same REST URL) and `UPSTASH_TOKEN` (the same token).
2. Run **`createSyncTrigger()`** once (authorize when prompted). It seeds Upstash now and every 10 minutes after.
3. Confirm keys exist in Upstash: `access:<email>` per registered vendor, `vendor:<oracle>` per vendor.

You do **not** deploy the Apps Script web app in this path — `Sync.gs` only pushes data outward.

## Test
1. Open the Vercel URL. Enter a registered vendor email → receive the code → sign in.
2. Confirm you see only that vendor's contracts/trips. Sign out. Try an unregistered email (blocked).
3. Run the full checklist in `../docs/TEST_CASES.md` (auth, scoping, rendering) against the live URL.

## Security model
- **Scope from the token:** `/api/data` reads the oracle out of the **signed** JWT cookie and returns only
  `vendor:<that oracle>`. A vendor cannot request another oracle's data — the only way to get a different oracle in
  the token is to sign it with `JWT_SECRET`, which lives only on the server. (Verified in the backend unit tests.)
- **OTP:** 6-digit, 10-min TTL, single-use, 5-attempt cap, 30-second resend cooldown — all enforced in Upstash.
- **Cookie:** `HttpOnly; Secure; SameSite=Lax`, 8-hour expiry.
- **Sheet stays private:** only the Apps Script owner (you) reads it; Upstash holds pre-scoped copies keyed by oracle;
  Vercel holds only the Upstash token + SMTP creds in encrypted env vars.

## Notes / tuning
- **Staleness:** vendor data refreshes every ~10 min (adjust in `Sync.gs`). Irrelevant for this product — trips only
  become visible 24h after completion by design.
- **Email enumeration:** the login tells an unregistered email it isn't registered (better UX for a closed vendor
  base). To hide it, return a generic "if registered, a code was sent" in `api/request-otp.js`.
- **Scale:** Upstash free tier handles the pilot comfortably. Past ~8–10 clusters, swap the Sheet source for a DB —
  only `Sync.gs` (or a DB writer) changes; the API and UI stay the same.
