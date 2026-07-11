/** POST /api/verify-otp  { email, code }  → on success, sets a signed JWT session cookie (scope = oracle). */
'use strict';
const { rget, rsetex, rdel, signJwt, sessionCookie, readBody } = require('../lib/core');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  try {
    const { email, code } = await readBody(req);
    const e = String(email || '').trim().toLowerCase();
    const c = String(code || '').trim();

    const raw = await rget('otp:' + e);
    if (!raw) return res.json({ ok: false, error: 'Code expired or not found. Please request a new one.' });
    const rec = JSON.parse(raw);

    if (rec.attempts >= 5) { await rdel('otp:' + e); return res.json({ ok: false, error: 'Too many attempts. Please request a new code.' }); }
    if (rec.code !== c) {
      rec.attempts++;
      await rsetex('otp:' + e, 600, JSON.stringify(rec));
      return res.json({ ok: false, error: 'Incorrect code. ' + (5 - rec.attempts) + ' attempt(s) left.' });
    }

    await rdel('otp:' + e); // one-time use

    const accRaw = await rget('access:' + e);
    if (!accRaw) return res.json({ ok: false, error: 'Account no longer active.' });
    const acc = JSON.parse(accRaw);
    if (acc.active === false || ['vendor', 'admin'].indexOf(acc.role || 'vendor') === -1) return res.json({ ok: false, error: 'Access not permitted.' });

    const token = signJwt({ email: e, oracle: acc.oracle, name: acc.name, role: acc.role || 'vendor' });
    res.setHeader('Set-Cookie', sessionCookie(token));
    return res.json({ ok: true, vendorName: acc.name });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
};
