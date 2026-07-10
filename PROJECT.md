# VALMO Transporter Panel — Project

Email-login vendor panel over the VALMO data contract. Vendors sign in with their email (6-digit OTP) and see
**only their own transferred trips**. Two deploy tracks share one schema, one mapping, one UI.

## Status
- ✅ **Track 1 — Apps Script** (internal): backend auth + oracle-scoped data API + R1→UI mapping + read-only panel. Built & unit-tested.
- ✅ **Track 2 — External (Vercel + Upstash + Meesho SMTP)**: public panel + serverless API + Apps Script→Upstash sync. Built & unit-tested (JWT, OTP, scoping).
- ✅ Sample data (5 tabs, all trip types) — verified against the mapping (22/22 checks).
- ✅ Setup guide + full test-case checklist + external-access design doc.
- ⛔ Confirm / dispute / admin / reconfirm / archive (C4–C7) — out of Stage 1 scope.

## Which track?
- **Track 1 (Apps Script)** works for **Meesho-internal** users (deploy "Anyone at Meesho"). Fastest way to demo the
  whole product today. External vendor emails **cannot** reach it under Workspace policy.
- **Track 2 (Vercel)** is the **production path for external transporters** — any email domain, the Sheet stays
  private, and **no Google service account is needed** (the Apps Script sync job reads the Sheet as you and pushes
  pre-scoped data to Upstash). ← **you chose this path.**

See `docs/EXTERNAL_ACCESS_SOLUTION.md` for the full reasoning.

## Folder layout
```
VALMO_Transporter_Panel/
├─ PROJECT.md                          ← you are here
├─ apps-script/
│  ├─ Code.gs                          ← mapping + auth + scoped API (used by BOTH tracks)
│  ├─ Index.html                       ← Track 1 panel (google.script.run)
│  └─ Sync.gs                          ← Track 2: pushes access:* + vendor:* to Upstash every 10 min
├─ vercel-app/                         ← Track 2 public app
│  ├─ index.html                       ← same panel UI, uses fetch('/api/*')
│  ├─ api/{request-otp,verify-otp,data,logout}.js
│  ├─ lib/core.js                      ← Upstash REST + JWT + cookies
│  ├─ package.json · vercel.json · .env.example
│  └─ README.md                        ← Track 2 deploy steps
├─ sample-data/
│  ├─ VALMO_Sample_Data.xlsx           ← 5 tabs, ready to import (headers on row 1)
│  └─ *.csv                            ← one per tab (incl. Access_Control)
└─ docs/
   ├─ GETTING_STARTED.md               ← single runbook: deploy & test (+ reference appendix)
   ├─ TEST_CASES.md                    ← end-to-end checklist (applies to both tracks)
   ├─ EXTERNAL_ACCESS_SOLUTION.md      ← why/how of Track 2
   └─ DECISIONS.md                     ← resolved product decisions (§F/§H)
```

## Data flow (Track 2, production)
```
Google Sheet (private)
   ▲ read as owner (no service account, no sharing)
   │
Apps Script  Code.gs (_buildVendorPayload)  +  Sync.gs  ──10 min──►  Upstash Redis
                                                                        access:<email> → {oracle,name,role,active}
                                                                        vendor:<oracle> → pre-scoped panel payload
                                                                            │
Vendor (any email) ──► Vercel: /api/request-otp (SMTP) · /api/verify-otp (JWT cookie) · /api/data ◄─ reads Upstash
```

## Quick start
**Track 1 (internal demo):** follow `docs/GETTING_STARTED.md` (Part 0) → deploy web app as "Anyone at Meesho" → run `docs/TEST_CASES.md`.

**Track 2 (external):**
1. Apps Script project = `Code.gs` + `Sync.gs`. Add Script properties `UPSTASH_URL`, `UPSTASH_TOKEN`; run `createSyncTrigger()`.
2. Deploy `vercel-app/` to Vercel (preset **Other**); set env vars from `.env.example` (Upstash + JWT + Meesho SMTP).
3. Load real data into the Sheet; add vendor rows to `Access_Control`; open the Vercel URL; run `docs/TEST_CASES.md`.

## Verified automatically
- **Mapping** (Node vs sample data, 22/22): G6/G7 scoping, KM aggregation (346/3,500/390; MTD 4,236), tier grouping,
  a replacement vehicle covering two defaults (V4 km=132), adhoc/RTO handling, long-route parse, cross-vendor isolation, empty vendor.
- **Vercel backend** (Node, 17/17): JWT sign/verify + tamper/