/**
 * Shared server helpers for the VALMO Vercel app:
 *   - Upstash Redis REST client (get / setex / del)
 *   - Hand-rolled HS256 JWT (no external dep) for the session cookie
 *   - Cookie parsing + request-body reading
 * Scope is ALWAYS taken from the verified JWT, never from client input.
 */
'use strict';
const crypto = require('crypto');

const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UP_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const SESSION_TTL = 8 * 3600; // 8h

/* ---------------- Upstash Redis (REST) ---------------- */
async function redis(cmd) {
  if (!UP_URL || !UP_TOK) throw new Error('Upstash env not configured');
  const r = await fetch(UP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UP_TOK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j && j.error) throw new Error('Upstash: ' + j.error);
  return j ? j.result : null;
}
const rget   = (k) => redis(['GET', k]);
const rsetex = (k, ttl, v) => redis(['SET', k, v, 'EX', String(ttl)]);
const rdel   = (k) => redis(['DEL', k]);
const rpush  = (k, v) => redis(['RPUSH', k, v]);   // append action to a queue list

/* ---------------- JWT (HS256) ---------------- */
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) { return b64url(JSON.stringify(obj)); }

function signJwt(payload, ttlSec = SESSION_TTL) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET not set');
  const now = Math.floor(Date.now() / 1000);
  const h = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const p = b64urlJson({ ...payload, iat: now, exp: now + ttlSec });
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest());
  return `${h}.${p}.${sig}`;
}
function verifyJwt(token) {
  if (!token || !JWT_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expect = b64url(crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest());
  const a = Buffer.from(s), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
  catch (e) { return null; }
  if (body.exp && Math.floor(Date.now() / 1000) > body.exp) return null;
  return body;
}

/* ---------------- HTTP helpers ---------------- */
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1));
  });
  return out;
}
function sessionFromReq(req) { return verifyJwt(parseCookies(req)['valmo_session']); }

function sessionCookie(token) {
  return `valmo_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}
function clearCookie() {
  return 'valmo_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  let data = '';
  for await (const chunk of req) data += chunk;
  if (!data) return {};
  try { return JSON.parse(data); } catch (e) { return {}; }
}

const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim().toLowerCase());

module.exports = {
  rget, rsetex, rdel, rpush, redis,
  signJwt, verifyJwt, sessionFromReq, sessionCookie, clearCookie,
  parseCookies, readBody, validEmail, SESSION_TTL,
};
