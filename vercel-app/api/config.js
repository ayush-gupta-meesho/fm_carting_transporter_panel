/**
 * GET /api/config — non-secret client config so the panel can render the right proof flow
 * without a rebuild. Switching PROOF_MODE env (blob <-> form) changes the panel's dispute UI.
 */
'use strict';
module.exports = async (req, res) => {
  res.json({
    ok: true,
    proofMode: process.env.PROOF_MODE || 'blob',
    disputeFormAdhoc: process.env.DISPUTE_FORM_ADHOC || '',
    disputeFormRegular: process.env.DISPUTE_FORM_REGULAR || '',
  });
};
