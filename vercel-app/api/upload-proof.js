/**
 * POST /api/upload-proof  — stores a dispute proof file in Vercel Blob, returns a private URL.
 * Client sends JSON: { filename, contentType, dataBase64, trip_id }  (base64 keeps body-parsing simple).
 * Active only when PROOF_MODE=blob. To switch to the Google-Forms proof route later, set PROOF_MODE=form
 * and this endpoint is unused (the panel links to the form instead) — no other code changes.
 *
 * Requires env: BLOB_READ_WRITE_TOKEN (Vercel → Storage → Blob → connect).
 */
'use strict';
const { sessionFromReq, readBody } = require('../lib/core');
const { put } = require('@vercel/blob');

const MAX_BYTES = 4 * 1024 * 1024; // ~4 MB (base64 body stays under Vercel's function payload limit)

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ ok: false, error: 'SESSION_EXPIRED' });
  if ((process.env.PROOF_MODE || 'blob') !== 'blob') {
    return res.status(400).json({ ok: false, error: 'Blob uploads are disabled (PROOF_MODE != blob).' });
  }
  try {
    const { filename, contentType, dataBase64, trip_id } = await readBody(req);
    if (!dataBase64) return res.json({ ok: false, error: 'No file provided.' });

    const buf = Buffer.from(String(dataBase64), 'base64');
    if (!buf.length) return res.json({ ok: false, error: 'Empty file.' });
    if (buf.length > MAX_BYTES) return res.json({ ok: false, error: 'File too large (max 4 MB).' });

    const clean = (x, d) => String(x || d).replace(/[^\w.\-]/g, '_').slice(0, 80);
    const path = `proofs/${clean(s.oracle, 'oracle')}/${clean(trip_id, 'trip')}-${clean(filename, 'proof')}`;

    const blob = await put(path, buf, {
      access: 'public',                 // URL is unguessable (random suffix); fine for pilot proofs
      addRandomSuffix: true,
      contentType: contentType || 'application/octet-stream',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return res.json({ ok: true, url: blob.url });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Upload failed: ' + (err && err.message ? err.message : 'unknown (check BLOB_READ_WRITE_TOKEN)') });
  }
};
