/** POST /api/request-otp  { email }  → emails a 6-digit code (Meesho SMTP) if the email is a registered vendor. */
'use strict';
const { rget, rsetex, readBody, validEmail } = require('../lib/core');
const nodemailer = require('nodemailer');

let _transport = null;
function transport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true', // true for 465
    auth: (process.env.SMTP_USER || process.env.SMTP_PASS)
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return _transport;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  try {
    const { email } = await readBody(req);
    const e = String(email || '').trim().toLowerCase();
    if (!validEmail(e)) return res.json({ ok: false, error: 'Please enter a valid email address.' });

    const accRaw = await rget('access:' + e);
    if (!accRaw) return res.json({ ok: false, error: 'This email is not registered for the transporter portal. Please contact your VALMO ops SPOC.' });
    const acc = JSON.parse(accRaw);
    if (acc.active === false) return res.json({ ok: false, error: 'This account is disabled. Please contact your VALMO ops SPOC.' });
    if (['vendor', 'admin'].indexOf(acc.role || 'vendor') === -1) return res.json({ ok: false, error: 'This portal is for transporters/admins only.' });

    if (await rget('otpcd:' + e)) return res.json({ ok: false, error: 'A code was just sent. Please wait a few seconds and check your inbox/spam.' });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await rsetex('otp:' + e, 600, JSON.stringify({ code, attempts: 0 }));  // 10 min
    await rsetex('otpcd:' + e, 30, '1');                                    // 30s resend cooldown

    await transport().sendMail({
      from: process.env.SMTP_FROM || 'VALMO Portal <no-reply@meesho.com>',
      to: e,
      subject: 'VALMO Transporter Portal — your login code: ' + code,
      html:
        '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1A2A3A">' +
        '<p>Hello ' + (acc.name || 'Transporter') + ',</p>' +
        '<p>Your one-time login code for the VALMO Transporter Portal is:</p>' +
        '<p style="font-size:30px;font-weight:bold;letter-spacing:5px;color:#123A6B">' + code + '</p>' +
        '<p>This code expires in 10 minutes. If you did not request it, ignore this email.</p>' +
        '<hr style="border:none;border-top:1px solid #E2E8F0">' +
        '<p style="font-size:11px;color:#6B7C8F">VALMO — automated message, do not reply.</p></div>',
    });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error sending code. Please try again.' });
  }
};
