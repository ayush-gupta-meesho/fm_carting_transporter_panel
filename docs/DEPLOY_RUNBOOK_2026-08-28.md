# Deploy runbook — the resolution fix + the scheduled run

**28 Aug 2026.** Fourteen steps across Apps Script, GitHub and the sheet. Order is load-bearing in
Part A; two steps there fail *silently* if taken out of sequence, so each carries the check that
proves it worked.

Covers `docs/FIX_LOST_RESOLUTIONS_2026-08-27.md` and `docs/SCHEDULED_RUN_2026-08-27.md`.

---

## Where you already are (read from `.git`, not assumed)

| | |
|:-:|---|
| ✓ | **The pending-revert fix is live.** `fix/pending-action-overlay` was fast-forwarded into `main`. |
| ✓ | **The lost-resolutions fix is committed and pushed.** `main` and `origin/main` are both `55b2180`, so Vercel already has that build. |
| ✓ | **No stale `.git/index.lock`.** |
| → | **Today's scheduled-run changes are uncommitted** — the Adhoc/RTO filter, the four triggers, 5a going read-only, `_scheduledtest.js`. |
| → | **Nothing has reached Apps Script yet.** Every `.gs` change from both sessions is still only on disk, so the 166 lost resolutions are still lost. |

---

## Part A — Apps Script and the sheet (~15 min)

The half that touches live billing data, and the only half where sequence matters. **A1–A4 must run in
order:** paste the code before the columns exist and a firing trigger writes resolutions into columns
that aren't there — silently, which is the exact failure that cost 166 corrections.

### A1 · Turn every trigger off first — ORDER CRITICAL
Menu `7 · Stop auto-apply`. Then **Extensions → Apps Script → Triggers** and confirm the list is empty.

> Between pasting the new code and creating the columns there is a window where the applier has a
> destination it cannot find. It writes nothing and says nothing. A trigger firing inside that window
> reproduces the original bug on fresh data.

### A2 · Paste `Code.gs` and `Actions.gs`
Replace wholesale, don't merge by hand — both changed substantially across the two sessions. Save.

**Check:** no red errors; `Actions.gs` contains `_holdFromVendor` and `scheduledFilteredDrainSync`.

### A3 · Set the project time zone to IST — once, forever
**Apps Script → Project Settings → Time zone → (GMT+05:30) India Standard Time.**

Clock triggers fire in the *Apps Script project's* time zone — a different setting from the
spreadsheet's, and not what `_tz()` returns. Get it wrong and the schedule runs 12½ hours out with
nothing to tell you. C2 refuses to install unless this reads `Asia/Kolkata`.

### A4 · Reload the sheet, then run `1 · Create / verify tabs` — ORDER CRITICAL
The menu only rebuilds on open, so reload the tab first or the new items won't be there.

**Verify before going on:** scroll `Trip_Level` to the far right. Columns **41 and 42** must read
`total_trip_km_resolved` and `adhoc_amount_resolved`. If they aren't there, stop — nothing below will
work, and it will look like it did.

### A5 · Run `5a · Check resolutions are in sync`
Read-only. Reports what the applier is about to fix, before anything is written.

**Expect:** `Rows OUT OF SYNC : 166`, `KM delta vs system : 1974.216`, vendor `18838`.
If it names a **MISSING COLUMN** instead, A4 didn't take.

### A6 · Run `6b · Run the scheduled job NOW`
Applies the 166 backlog and pushes a fresh snapshot.

> **Use 6b, not menu 4, for this step.** Menu 4 transfers *unfiltered*. All 3,911 rows are already
> sent so today it makes no difference — but if the data engine added rows overnight, menu 4 would
> push Adhoc and RTO trips to vendors before the filter is even on.

**Check:** `In-sheet resolutions applied`, a run of `RECONCILED DSP-…` lines, ending in a successful sync.

### A7 · Run `5a` again
**Must read `Rows OUT OF SYNC : 0`** — the backlog cleared, confirmed by the audit rather than assumed
from the applier's own report.

---

## Part B — the panel (~5 min)

Independent of Part A; before, after or in parallel. The new fields are additive both ways — a new
panel against an old snapshot shows no chips, an old panel ignores fields it doesn't know. There is no
window where the two are incompatible.

### B1 · Review what changed
```
cd "C:\Users\Ayush Gupta\Desktop\MIGRATION_BACKUP\07-Code-Projects-from-Downloads\VALMO_Transporter_Panel"
git status
git diff --stat
```

> Run git yourself, in your own terminal. Running `git status` across the device bridge once left a
> `.git/index.lock` the bridge couldn't remove and blocked a commit. I don't touch git in this repo.

### B2 · Commit and push
```
git add apps-script vercel-app/index.html testkit docs
git commit -m "feat: scheduled run 14:30/18:30/22:30/03:30 IST skipping Adhoc + RTO" -m "Filter delegates to _classifyTrip: 'RTO Only' as literally requested matched 0 of 3911 rows (sheet stores 'RTO only'). Holds 451 rows (Adhoc OR RTO), not the 13-row intersection. Menu 4 stays unfiltered as the release valve. Installer refuses a non-IST project timezone. Menu 5a demoted to read-only. 16 harnesses / 868 assertions."
git push
```
Single-line `-m` flags on purpose: PowerShell has no heredocs and no `&&`.

### B3 · Wait for Vercel to go green
Production builds from `main`. Confirm the newest deployment carries your commit message and finished
before checking the panel in Part D.

---

## Part C — turning the schedule on (~3 min)

Only once Part A verifies clean. After this the job runs unattended four times a day.

### C1 · Read the held count from A6's run
The line reads `Held back N (x Adhoc, y RTO) — release with menu 4`, or is absent when nothing was
eligible.

> Today it will almost certainly say nothing: all 3,911 rows already have `sent_to_vendor_flag = Yes`.
> The filter applies to rows the data engine adds from here on. No held count now is correct.

### C2 · Run `6a · Turn ON scheduled run`
Installs four daily triggers at 03:30, 14:30, 18:30, 22:30 IST and removes the 10-minute auto-apply if
it is on.

> Google fires these **within ~15 minutes** of the stated time — roughly 14:15–14:45, not 14:30 exactly.
> Apps Script has no exact-minute recurring trigger. If a downstream report needs the precise minute,
> the alternative is an every-15-min trigger gated on the clock (96 wake-ups a day).

### C3 · Run `7b · Show trigger status + timezone`
**All four must be true:** project time zone `Asia/Kolkata`; exactly four `scheduledFilteredDrainSync`
triggers; **no** `scheduledDrainSync`; no time-zone warning.

If `scheduledDrainSync` is still listed, the 10-minute unfiltered job is running alongside and would
transfer Adhoc and RTO trips within ten minutes — the filter would look broken rather than off. Run
`7 · Stop auto-apply`, then `6a` again.

---

## Part D — proving it worked (~10 min)

| # | Where | Look at | Should show |
|---|---|---|---|
| D1 | Sheet | `Trip_Level`, trip `TR-59335170-3079` | `total_trip_km_resolved` = **183**, `total_trip_km` still **167.074** — the original survives |
| D2 | Panel (Krushiv) | that same trip | **183 km** + green **revised from 167.074 km** chip, and **View resolution** still present on the settled row |
| D3 | Panel (admin) | the header line | any held trips as **N held (Adhoc / RTO)**, counted apart from not-yet-sent |
| D4 | Apps Script | Executions, after the first slot | `scheduledFilteredDrainSync` · **Completed** — open it for the run report |

---

## If it goes wrong

- **Stop the schedule:** `7a · Stop the scheduled run` removes the four triggers, leaves everything else.
- **Revert the panel:** `git revert --no-edit HEAD` then `git push`; Vercel redeploys the previous build.
- **Revert the Apps Script:** recover the previous `.gs` from git, or use **File → See version history**
  in the Apps Script editor.
- **Leave the two new columns in place.** They are additive, old code ignores them, and deleting them
  would throw away the corrections you just applied.

---

## One thing to pass on to ops

The old sequence — mark a dispute `Resolved`, then type the `resolved_km` a minute later — is what
silently lost 166 corrections. **That sequence is now safe:** the applier reconciles every resolved
dispute on every run, so a number filled in afterwards lands on the next pass and is logged as
`RECONCILED` rather than dropped. Worth saying out loud, because nobody had reason to think the order
mattered — and now it genuinely doesn't.
