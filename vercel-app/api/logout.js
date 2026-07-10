/** POST /api/logout → clears the session cookie. */
'use strict';
const { clearCookie } = require('../lib/core');

module.exports = async (req, res) => {
  res.setHeader('Set-Cookie', clearCookie());
  return res.json({ ok: true });
};
