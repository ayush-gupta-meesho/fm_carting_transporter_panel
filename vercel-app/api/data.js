/** GET /api/data  → returns the signed-in vendor's pre-scoped panel payload from Upstash. 401 if no session. */
'use strict';
const { rget, sessionFromReq } = require('../lib/core');

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
    return res.json({ ok: true, data: JSON.parse(raw) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error loading data.' });
  }
};
