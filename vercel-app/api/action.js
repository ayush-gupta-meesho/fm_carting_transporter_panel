/**
 * POST /api/action  — vendor confirm / dispute → validated → queued to Upstash "actions".
 * The Apps Script drainActions() applies the queue to the Sheet (source of truth).
 *
 * Server-side gates here (defense in depth; the drain re-checks against the Sheet):
 *   - session valid (JWT)
 *   - the trip is in THIS vendor's pre-scoped payload  -> ownership guaranteed
 *   - the trip is still actionable ('pending' or 'reconfirm')  -> locking
 *   - dispute: at least one category; proof required when PROOF_MODE=blob
 * Nothing is written to the Sheet directly — only an action is enqueued.
 */
'use strict';
const { rget, rpush, sessionFromReq, readBody } = require('../lib/core');

const mkId = () => 'act-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const ACTIONABLE = { pending: 1, reconfirm: 1 };   // statuses a vendor may act on

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ ok: false, error: 'SESSION_EXPIRED' });

  try {
    const body = await readBody(req);
    const type = String(body.type || '');

    const raw = await rget('vendor:' + s.oracle);
    const data = raw ? JSON.parse(raw) : { trips: {} };
    const index = {}; // trip_id -> { contract_id, trip }
    Object.keys(data.trips || {}).forEach((cid) => {
      (data.trips[cid] || []).forEach((t) => { index[t.id] = { contract_id: cid, trip: t }; });
    });

    if (type === 'confirm') {
      let ids = Array.isArray(body.trip_ids) && body.trip_ids.length
        ? body.trip_ids.map(String)
        : (body.trip_id ? [String(body.trip_id)] : []);
      ids = ids.filter((id) => index[id] && ACTIONABLE[index[id].trip.status]);
      if (!ids.length) return res.json({ ok: false, error: 'No trips are open for confirmation.' });

      const action = { action_id: mkId(), type: 'confirm', oracle: s.oracle, email: s.email,
                       vendor_name: s.name, trip_ids: ids, ts: Date.now() };
      await rpush('actions', JSON.stringify(action));
      return res.json({ ok: true, queued: ids.length, trip_ids: ids, state: 'pending_sync' });
    }

    if (type === 'dispute') {
      const tid = String(body.trip_id || '');
      const hit = index[tid];
      if (!hit) return res.json({ ok: false, error: 'Trip not found for your account.' });
      if (!ACTIONABLE[hit.trip.status]) return res.json({ ok: false, error: 'This trip is no longer open for dispute.' });

      const cats = Array.isArray(body.categories) ? body.categories.filter(Boolean) : [];
      if (!cats.length) return res.json({ ok: false, error: 'Select at least one dispute reason.' });

      const proofMode = process.env.PROOF_MODE || 'blob';
      if (proofMode === 'blob' && !body.proof_url) {
        return res.json({ ok: false, error: 'A proof upload is required to raise a dispute.' });
      }

      const action = {
        action_id: mkId(), type: 'dispute', oracle: s.oracle, email: s.email, vendor_name: s.name,
        trip_id: tid, contract_id: hit.contract_id, categories: cats,
        claim_billing_type: String(body.claim_billing_type || ''),
        claim_aggregate_vehicle: String(body.claim_aggregate_vehicle || ''),
        claim_km: (body.claim_km === undefined || body.claim_km === null) ? '' : body.claim_km,
        claim_amount: (body.claim_amount === undefined || body.claim_amount === null) ? '' : body.claim_amount,
        /* Zonal claims. This whitelist is the third place a dispute field has to be named — the panel
           sends it, THIS builds the queued action, and applyDispute() writes it. Omitting a field here
           drops it silently: the dispute still lands and the status still flips, but the claim arrives
           blank. Any new claim_* field must be added here too. */
        claim_zonal_amount: (body.claim_zonal_amount === undefined || body.claim_zonal_amount === null) ? '' : body.claim_zonal_amount,
        claim_rfq_id: String(body.claim_rfq_id || ''),
        claim_contract_id: String(body.claim_contract_id || ''),
        vendor_description: String(body.vendor_description || ''),
        proof_url: String(body.proof_url || ''),
        callback_number: String(body.callback_number || ''),
        ts: Date.now(),
      };
      await rpush('actions', JSON.stringify(action));
      return res.json({ ok: true, state: 'pending_sync' });
    }

    return res.json({ ok: false, error: 'Unknown action type.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error queuing action.' });
  }
};
