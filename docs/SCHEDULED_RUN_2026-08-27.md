# Scheduled run — 14:30 / 18:30 / 22:30 / 03:30 IST, skipping Adhoc and RTO

**27 Aug 2026.** Four daily runs that do everything menu 4 does, except they do not transfer Adhoc or
RTO trips to vendors.

---

## Read this first: `RTO Only` matches nothing

The request named `challan_type = 'RTO Only'`. The live sheet stores it as **`RTO only`** — lowercase
o. A case-sensitive equality test matches **0 of 3,911 rows**, so the filter would have run, reported
success, and held back nothing.

Actual `challan_type` values on the live sheet:

| value | rows | held? |
|---|---:|:-:|
| `Forward Only` | 1,941 | no |
| `Forward + RTO` | 1,805 | **no** — see below |
| `RTO only` | 145 | **yes** |
| `Regular` | 9 | no |
| *(blank)* | 9 | no |
| `Adhoc` | 1 | no |
| `RTO` | 1 | **yes** |

The filter uses `_low(challan_type_final \|\| challan_type).indexOf('rto') === 0` — the **same test
`_classifyTrip` uses to decide a trip pays ₹0**. So it catches `RTO only`, `RTO`, and any casing of
either, and it deliberately does *not* catch **`Forward + RTO`**: the classifier does not treat those
as RTO, they carry payable KM, and holding them back would keep real money away from vendor
confirmation.

## What gets held

**Adhoc OR RTO**, not AND. On the live sheet:

| | rows | % of 3,911 |
|---|---:|---:|
| `billing_type_system` = Adhoc | 318 | 8.1% |
| RTO (challan starts with `rto`) | 146 | 3.7% |
| **union — what is held** | **451** | **11.5%** |
| intersection (both at once) | 13 | 0.3% |

An AND filter would have held 13 rows and let the other 305 Adhoc and 133 RTO trips through.

The test delegates to `_classifyTrip` rather than reading raw cells, which buys two things a literal
column test would miss:

- **A ground reclassification to Adhoc is held too** (`billing_type_final = Adhoc`, 6 live rows) — but
  only on Local. On zonal, ground is ignored here exactly as it is ignored everywhere else, so rule
  (iii) holds in the scheduler as well as in the classifier.
- **The zero-km RTO limb is included**: a trip with `total_trip_km = 0` and `km_accumulated_flag = No`
  is already RTO to the classifier, so it is held. A *blank* flag is not enough — the 9 blank-challan
  rows are not assumed to be RTO.

So the scheduler, the panel and the billing MIS cannot disagree about what "Adhoc" and "RTO" mean.

## What happens to a held trip

**Nothing.** The skip runs before any write, so a held row is left byte-for-byte alone: no
`ground_review_deadline`, no `dispute_window_end`, no `vendor_status`, and no
`Ground_Confirmation_Log` row. It stays eligible forever.

**Menu 4 is unfiltered and is the release valve.** `transferReadyTrips()` with no arguments transfers
everything, exactly as before — so you can push held trips through deliberately at any time. There is
deliberately **no second copy** of the transfer function; the filter is an optional `opts.skip`
predicate on the one that already existed, because a duplicated transfer path is how the two would
drift apart.

The backlog is visible rather than silent, in three places: the run report (`Held back 3 (2 Adhoc,
1 RTO) — release with menu 4.`), the admin header (`… · 12 held (Adhoc / RTO)`), and a **`Held · Adhoc`**
chip on the row itself, counted separately from genuinely-not-yet-sent trips so the two do not look
alike.

---

## Two things about the schedule that will bite you

**1 · Clock triggers fire in the Apps Script PROJECT timezone, not the spreadsheet's.** These are
different settings, and `_tz()` returns the spreadsheet's. A project left on `America/Los_Angeles`
would run these 12½ hours out, silently. The installer **refuses to install** unless the project is on
`Asia/Kolkata` and tells you where to change it: *Apps Script editor → Project Settings → Time zone →
(GMT+05:30) India Standard Time*. `7b · Show trigger status` prints both timezones side by side.

**2 · Apps Script has no exact-minute recurring trigger.** `atHour(14).nearMinute(30)` is the closest
it offers, and Google fires it **within about 15 minutes** — so expect roughly 14:15–14:45, not 14:30
on the dot. The only way to hit an exact minute is an every-15-minutes trigger that returns early
unless the clock is inside the window: 96 wake-ups a day for a job that is idempotent anyway. Not
worth it. If the exact minute matters for a downstream report, say so and I will build the gated
version.

**Conflict handling.** `6 · Turn ON auto-apply` installs `scheduledDrainSync` every 10 minutes, and
that job calls `transferReadyTrips()` **with no filter** — leaving it on would send the held Adhoc and
RTO trips within ten minutes anyway, and the filter would look broken rather than off. The two are now
mutually exclusive **by construction, in both directions**: installing 6a removes the 10-minute job and
says so; turning 6 back on removes 6a and warns that auto-apply transfers Adhoc and RTO as well.

## New menu items

| item | does |
|---|---|
| `6a · Turn ON scheduled run (14:30/18:30/22:30/03:30 IST, skips Adhoc + RTO)` | installs the four triggers |
| `6b · Run the scheduled job NOW` | runs it by hand, exactly as the trigger would |
| `7a · Stop the scheduled run` | removes just these four, leaves other triggers alone |
| `7b · Show trigger status + timezone` | what is installed, and both timezones |

`6` is relabelled **"NO filter"** so the difference is visible in the menu itself.

Each of the four steps is caught separately on purpose: a failure in one must not cost the others, and
in particular **the sync runs even if the transfer threw**, so the panel never goes stale behind a bug.
The report names the failing step.

---

## Is menu 5a still needed? No — and it has been changed

**The apply half is now exactly redundant**, and that is measured, not assumed. Run over the same
stamped-but-unwritten fixture, `repairMissedResolutions(true)` and `applyResolutionsFromSheet()`
produced:

- a **byte-identical** `Trip_Level`
- the **same three cell writes**
- **zero status upserts from either** — neither reopens a trip the vendor already accepted

That is what the 27 Aug fix changed. With `resolved_at` demoted from a skip to a one-time-side-effects
gate, the applier reconciles every Resolved dispute on every pass, so it already *is* the repair —
and it runs four times a day now.

Keeping a second function able to write the same cells would mean two mappings (`MAP_LOCAL` /
`MAP_ZONAL` in 5a, the inline `ow()` calls in the applier) that can drift apart silently.

**So 5a is now read-only** and relabelled **`5a · Check resolutions are in sync (read-only)`**. It
answers "is anything out of sync, and by how much?" without touching the sheet — it still ignores
`resolved_at`, still totals the KM at stake, still names the vendors, and still calls out a missing
column instead of reporting a false all-clear. To apply what it finds: menu 4, or wait for the next
scheduled run.

**Delete it entirely once the 166-row backlog is cleared**, if you like. From then on the applier keeps
the sheet in sync within six hours, so the audit will always read zero. It costs nothing to keep as a
"prove it" button, and nothing is lost by removing it. `_kmresolvetest.js §3b` is the equivalence
proof, and it stays regardless — it is what would catch the applier regressing.

---

## To turn it on

1. Paste `Code.gs` and `Actions.gs` into Apps Script.
2. **Set the project timezone to IST** — *Project Settings → Time zone → (GMT+05:30)*. Check with
   `7b`; 6a refuses without it.
3. Run `1 · Create / verify tabs` if you have not already (the 27 Aug fix needs two new columns).
4. Run `6b · Run the scheduled job NOW` once and read the report — confirm the held count looks right
   before putting it on a timer.
5. Run `6a`. Confirm with `7b` that four `scheduledFilteredDrainSync` triggers exist **and the 10-minute
   `scheduledDrainSync` does not**.

A note on the first run: all 3,911 rows currently have `sent_to_vendor_flag = Yes`, so there is no
transfer backlog today. The filter applies to rows the data engine adds from here on.

## Tests

`testkit/_scheduledtest.js` — **64 assertions**. It pins the exact live strings (including that
`'RTO Only'` matches nothing and `Forward + RTO` is not held), that a held trip has **not one cell**
written and no log row, that **menu 4 stays unfiltered** and can still release everything, that held
trips stay eligible run after run, the four trigger hours and minutes, the timezone refusal, the
two-way mutual exclusion with auto-apply, and that a failing step still lets the sync run.

Its non-vacuity section builds the filter **exactly as the request worded it** — `billing_type_system
== 'Adhoc' && challan_type == 'RTO Only'`, case-sensitive — and asserts that it holds back nothing and
sends every trip out. That assertion is the reason this file exists.

Suite: **16 harnesses, 868 assertions**, all passing.
