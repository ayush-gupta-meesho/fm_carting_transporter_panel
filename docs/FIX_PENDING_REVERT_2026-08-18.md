# Fix — confirmed / disputed trips reverting to "Pending Confirmation"

**18 Aug 2026.** Vendor report: trips they Confirm or Dispute go back to *Pending Confirmation* on the
dashboard. (The video did not come through, but the cause is reproducible from the code and is below.)

---

## Your premise was the bug

> *"even though confirmed / disputed trips do not flow into sync at the same time, they are stored on the
> vendor side"*

They were **not**. The action was stored **server-side in the Upstash queue**, and the panel showed the
new status **only in memory**. Nothing on the *read* path knew the queue existed, so the moment the page
reloaded the optimistic update was thrown away.

Reproduced end to end against the real `api/action.js`:

```
1. after menu 4 sync, the snapshot /api/data serves says : pending
2. vendor clicks Confirm -> /api/action responds         : {"ok":true,"state":"pending_sync"}
   actions queue now holds                               : 1 action
   panel sets t.status="confirmed" IN MEMORY  -> renders  : Confirmed, applying on next sync
3. the snapshot vendor:ORC-4521 still says               : pending   <<< UNCHANGED
4. vendor refreshes -> loadPanel() runs
   TRIPS = d.trips   (wholesale overwrite from /api/data)
   the in-memory status and _pending flag are DISCARDED
   panel renders                                         : Pending Confirmation   <<< THE BUG
5. vendor confirms a second time -> accepted again
   queue now holds                                       : 2 actions for ONE trip
```

Three facts, in three files:

- `api/action.js` — `await rpush('actions', …)` and nothing else. The snapshot `vendor:<oracle>` is never
  written.
- `api/data.js` — `return res.json({ ok: true, data: JSON.parse(raw) })`. Serves the snapshot verbatim; no
  knowledge of the queue.
- `index.html:1193` — `var t=_findTrip(cid,id); if(t){t.status='confirmed';t._pending=true;}` — a mutation
  on a plain JS object, and `loadPanel()` does `TRIPS=d.trips` on every load.

So *any* reload reverted it: refresh, tab re-open, back-navigation, session refresh, phone waking. And it
stayed reverted until someone ran **menu 4** — `drainActions()` → `applyConfirm()` writes `Trip_Level` →
`syncToUpstash()` rewrites the snapshot.

---

## The fix — overlay the un-drained queue on the read path

The queue was already the right place to store the action; the read path just had to look at it.
`/api/data` now reads the `actions` list **non-destructively** (`LRANGE`, never `LPOP` — only the drain may
consume it), filters to the signed-in vendor's own actions, and applies them to the snapshot on the way out.

Chosen over a client-side `localStorage` cache deliberately: the queue is already the single source of
truth for "submitted but not yet applied", it works on **any device or browser** the vendor signs in from,
and it **self-clears** — once the drain pops the action and re-syncs, the queue no longer carries it and
the snapshot carries the truth. No TTL to tune, no local state to go stale.

### Three files

**1. `vercel-app/lib/core.js`** — append `pendingVendorActions()` (delivered as
`lib/core.pendingActions.append.js`) below the existing `rpush` definition, and add
`pendingVendorActions` to the `module.exports` list. It needs no new Upstash helper — `redis(cmd)` is
already exported.

**2. `vercel-app/api/data.js`** — replaced. The overlay, with one hard rule:

```js
/* Only ever move a trip FORWARD out of an actionable state. If the snapshot has already advanced —
   confirmed, disputed, or back to reconfirm after a resolution — then the Sheet is ahead of the queue
   and the Sheet wins. This is what stops a stale queue entry from masking a real status change. */
if (!next || !ACTIONABLE[t.status]) return;
t.status = next; t._pending = true; t.win = null;
```

**3. `vercel-app/api/action.js`** — the gate now also treats an already-queued trip as not actionable, so
step 5 above cannot happen:

```
POST /api/action confirm (again) -> {"ok":false,"error":"Already submitted — it applies on the next sync."}
queue still holds exactly 1 action for TR-1
```

Both call sites are **guarded** — `typeof pendingVendorActions === 'function' ? … : {}` — so if `core.js`
is deployed after the routes, vendors can still confirm and dispute. Losing the duplicate check for a few
minutes is an annoyance; a 500 on every dispute is not. **`index.html` is unchanged** — it already renders
`_pending` as *"applying on next sync…"*, and now that flag arrives from the server.

### Deploy order

`lib/core.js` → `api/data.js` → `api/action.js`. Any order works because of the guards, but this one never
shows a vendor a degraded gate.

---

## Verified

New harness **`testkit/_pendingtest.js` — 16 checks**, driving the real `api/action.js` and `api/data.js`
against a stubbed Upstash:

| | |
|---|---|
| the fix | a Confirm and a Dispute both survive a refresh, flagged `_pending` |
| untouched rows | another trip on the same contract is left alone |
| no double-queue | a second Confirm is refused; the queue still holds exactly 1 action |
| **the Sheet always wins** | snapshot `disputed` + queue `confirmed` → panel shows **disputed** |
| no leakage | another vendor's `/api/data` never sees `ORC-4521`'s queued actions |
| read, not consume | after 6 GETs the queue still holds every action |
| resilience | a malformed queue row is skipped; the rest still overlay |

**Non-vacuous:** with the overlay line removed, 6 of the 16 fail. With it in, all 16 pass.

Full suite after the change: **12 harnesses, 674 assertions, all passing** (`_uitest` 225 · `_guardtest` 81
· `_rtotest` 75 · `_datetest` 69 · `_importtest` 60 · `_billtest` 37 · `_paritytest` 35 · `_matrixtest` 23
· `_apitest` 22 · `_resolvetest` 21 · `_pendingtest` 16 · `_flowtest` 10).

`_apitest` initially broke on this change — its stub `lib/core` had no `pendingVendorActions`, so every
dispute 500'd. That is exactly the deployment hazard the guards now cover; the stub has been updated to
mirror the real export surface.

---

## Two things this does not fix

**1. The "applying on next sync…" window is still as long as the gap between drains.** The overlay makes
the status stick; it does not make it land. If the 10-minute auto-apply trigger is not on, that window is
unbounded and the vendor waits for someone to click a menu.

→ Run **`createDrainSyncFromMenu()`** ("Start auto-apply") once. It replaces any sync-only trigger with
`scheduledDrainSync` every 10 minutes — transfer → drain → resolutions → sync. **Please confirm whether
this is currently enabled on the Rajkot sheet**; if it is not, that alone would explain how visible this
bug became.

**2. A failed action disappears silently.** If `applyConfirm` / `applyDispute` throws inside the drain, the
action is popped from `actions` and parked in `actions_dead`. The overlay then stops applying it and the
trip reverts to Pending — correctly, since the action really did fail, but **the vendor gets no signal and
no explanation**. Worth surfacing on the panel as "we could not apply this — please retry" rather than a
silent revert. Not urgent; nothing is in `actions_dead` today.
