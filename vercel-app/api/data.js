/** GET /api/data  → the signed-in vendor's pre-scoped panel payload from Upstash,
 *  with any of their own not-yet-drained Confirm / Dispute actions overlaid on top.
 *
 *  Without the overlay the panel reverted: /api/action queues the action but does not touch the
 *  snapshot, so the next /api/data (page refresh, tab re-open, session refresh) served the old
 *  "Pending" status and the vendor's Confirm appeared to be lost. See lib/core.pendingVendorActions.
 */
'use strict';
const { rget, sessionFromReq, pendingVendorActions } = require('../lib/core');

const ACTIONABLE = { pending: 1, reconfirm: 1 };   // the only statuses an overlay may move

module.exports = async (req, res) => {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ ok: false, error: 'SESSION_EXPIRED' });
  try {
    // Admin: return the all-vendors utilization payload.
    if (s.role === 'admin') {
      const araw = await rget('admin:all');
      return res.json({ ok: true, data: araw ? JSON.parse(araw) : { admin: true, contracts: [], summary: { total: 0 } } });
    }
    // Scope is the oracle from the VERIFIED session token — never from client input (G6).
    const raw = await rget('vendor:' + s.oracle);
    if (!raw) {
      return res.json({
        ok: true,
        data: { vendor: { name: s.name, oracle: s.oracle, duration: '', mtdKm: 0, clusters: 0, contractCount: 0 },
                contracts: [], vehicles: {}, trips: {} },
      });
    }

    const data = JSON.parse(raw);
    /* Guarded: if lib/core.js has not been updated yet, serve the snapshot rather than 500. */
    const queued = (typeof pendingVendorActions === 'function')
      ? await pendingVendorActions(s.oracle).catch(() => ({}))
      : {};                                                   // trip_id -> 'confirmed' | 'disputed'
    let pending = 0;
    if (Object.keys(queued).length) {
      Object.keys(data.trips || {}).forEach((cid) => {
        (data.trips[cid] || []).forEach((t) => {
          const next = queued[String(t.id)];
          /* Only ever move a trip FORWARD out of an actionable state. If the snapshot has already
             advanced — confirmed, disputed, or back to reconfirm after a resolution — then the Sheet
             is ahead of the queue and the Sheet wins. This is what stops a stale queue entry from
             masking a real status change. */
          if (!next || !ACTIONABLE[t.status]) return;
          t.status = next;
          t._pending = true;          // the panel renders "applying on next sync…" off this flag
          t.win = null;               // the dispute window is no longer the thing to show
          pending++;
        });
      });
    }
    return res.json({ ok: true, data, pendingActions: pending });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error loading data.' });
  }
};
