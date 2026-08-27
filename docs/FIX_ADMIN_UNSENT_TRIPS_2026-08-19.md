# Admin view — untransferred trips were aggregated but invisible

**19 Aug 2026.** Reported: *"if a trip is not sent to vendor, will they aggregate in admin view? Currently
I cannot see them — wasn't it this feature?"*

## The feature was there. The signal was not.

`_buildAdminPayload()` builds each vendor with `allTrips: true`, and that flag bypasses the transfer gate
— `Code.gs:405`:

```js
return _s(t.transporter_oracle_id) === oracle && (opts.allTrips || _yes(t.sent_to_vendor_flag));
```

Measured on `demo-data`, which holds two rows with a blank `sent_to_vendor_flag`:

```
vendor payload : 30 trips
admin  payload : 32 trips        <- the 2 untransferred ones ARE included
in ADMIN, not in VENDOR: TR-ZT-0006, TR-ZT-0007
their status   : "pending"       <- identical to a transferred pending trip
sent flag on the trip object?  false   (i.e. no such field existed)
```

So the aggregation worked. **The problem was that `sent_to_vendor_flag` was read *only* as a filter and
never reached the payload.** An untransferred trip arrived in the admin list reporting
`status: "pending"` — pixel-identical to a trip that had been properly transferred and was waiting on the
vendor. No badge, no column, no filter, no count. Nothing to look at.

## The change

**`Code.gs` — three trip mappers, not one.** Local on-contract (~527), zonal (~609) and the Other-Adhoc
orphan bucket (~690) each build their own trip object, so each needed:

```js
// admin-only in practice: a vendor payload is already filtered to sent rows, so this is
// always true there. On the ADMIN payload (allTrips) it is the ONLY way to tell a trip that
// has been transferred from one that has not — vendor_status reads 'Pending' for both.
sent: _yes(t.sent_to_vendor_flag),
```

**`index.html` — a chip on the row and a count on the header.**

```js
if(IS_ADMIN && t.sent===false) statusCell+='<div class="st-unsent" title="sent_to_vendor_flag is not Yes …">Not yet sent to vendor</div>';
```

```
1 over-utilised · 2 under-utilised · 7 on track  ·  2 trips NOT yet sent to vendor
```

Two deliberate choices in that one line:

- **`t.sent === false`, not `!t.sent`.** Against a snapshot built before this change the field is
  `undefined`, and `!undefined` is true — which would have flagged *every* trip in the panel as unsent.
  The strict test degrades to "show nothing" instead of "show everything", which is the safe direction.
- **The header count is recomputed from the payload**, not carried in `summary{}`, for the same reason:
  it stays correct against an older `admin:all`.

## Testing — `testkit/_adminunsenttest.js`, 16 checks, real Chromium

Drives the real `index.html` against a genuine `_buildAdminPayload()`. Asserts the payload carries a
boolean `sent` on every trip, the header names the backlog and the number matches, the chip appears on the
right row with a tooltip naming the underlying column — and, in the other direction, that **no chip and no
backlog line can ever reach a vendor**, because every trip in a vendor payload is `sent === true`.

Both halves verified non-vacuous: delete the chip line from `index.html` → 3 failures; delete `sent:` from
`Code.gs` → 5 failures. The second originally failed by *crashing* on `unsent[0]`, so the harness now
reports the cause in words instead of a `TypeError`.

Suite: **13 harnesses, 690 assertions, all passing.**

## Two things this does not fix

**1. It shows nothing until `admin:all` is actually written.** `Sync.gs:82`:

```js
var hasAdmin = ac.some(function (r) { return _low(r.role) === 'admin' && …active… });
if (hasAdmin) { _up(['SET','admin:all', JSON.stringify(_buildAdminPayload())]); }
```

No active `role = admin` row in `Access_Control` → the key is never written → `/api/data` serves the empty
fallback `{admin:true, contracts:[], summary:{total:0}}`. And with the sync trigger off, `admin:all` only
refreshes on menu 3 or 4. **Check the admin row first** — no UI change can help if the key is absent.

**2. The admin oracle list comes from a different tab than the vendor one.** Vendor payloads are built
from **Access_Control** oracles (`Sync.gs:67`); the admin payload from **Contract_Info** oracles
(`Code.gs:969`). A trip whose `transporter_oracle_id` has no `Contract_Info` row is invisible in the admin
view even with `allTrips` on. Worth aligning, or at least surfacing as an exception.

## Separate finding — `logoutFn()` does not reload

Found by this harness, pre-existing, **not caused by this change**:

```js
async function logoutFn(){
  try{ await fetch('/api/logout',{method:'POST'}); }catch(e){}
  showLogin();                      // <- no location.reload()
}
```

Measured: **14 trip rows from the previous session remain in the DOM after logout.** They are hidden
(`appVisible === false`, `loginVisible === true`), so nothing is on screen — but if an admin and a vendor
share a browser tab, the previous session's rows are still retrievable in the page. A `location.reload()`
in `logoutFn` closes it.

Left unchanged deliberately: it is outside the reported issue and touches auth behaviour. The harness
asserts the *current* behaviour, so a future fix will surface here as a failure rather than passing quietly.

## Order of operations

1. Confirm `Access_Control` has an active `role = admin` row
2. Paste `apps-script/Code.gs`
3. Deploy `vercel-app/index.html`
4. Run **menu 4** — the count appears on the admin header
