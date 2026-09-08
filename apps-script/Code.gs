/**************************************************************************************************
 * VALMO Transporter Panel — Apps Script backend  (Stage 1: Login + read-only vendor view)
 * ------------------------------------------------------------------------------------------------
 * Responsibilities (per VALMO_Build_Plan §C2 + §C3, read side only):
 *   - Serve the single-page web app (login + panel).
 *   - Email-OTP authentication (no Google account required for vendors).
 *   - Server-side session tokens; scope is ALWAYS derived from the token, never trusted from client.
 *   - Return each vendor ONLY their own transferred trips
 *        (transporter_oracle_id == their oracle  AND  sent_to_vendor_flag == "Yes").
 *   - Map the R1 sheet schema -> the shape the panel UI renders from.
 *
 * The panel NEVER classifies. It only DISPLAYS engine/ground outcomes and (Stage 1) is read-only.
 * Gateways covered here: G6 (oracle-scoping), G7 (state-scoping).
 **************************************************************************************************/

/* ============================== CONFIG ============================== */
// If this script is container-bound to the Sheet, leave SHEET_ID = '' and getActive() is used.
// If standalone, paste the Spreadsheet ID here.
var SHEET_ID = '';

var TABS = {
  contractInfo:     'Contract_Info',
  contractVehicles: 'Contract_Vehicles',
  tripLevel:        'Trip_Level',
  nodeMap:          'Node_Cluster_Map',
  accessControl:    'Access_Control',  // 9th tab — the login/scoping table (NEW vs R1)
  /* Placement Failure — contracted vehicle-days the vendor did not honour. LH fill it; the billing
     engine reads it and turns each row into a deduction line on that vendor's MIS. The tab name has a
     SPACE in it, matching what LH already call it. (2026-09-04) */
  placementFailure: 'Placement Failure'
};

var OTP_TTL_SECONDS      = 600;      // OTP valid for 10 minutes
var OTP_RESEND_COOLDOWN  = 30;       // seconds between OTP requests for one email
var OTP_MAX_ATTEMPTS     = 5;        // wrong-code attempts before the OTP is burned
var SESSION_TTL_SECONDS  = 8 * 3600; // session valid for 8 hours
var APP_NAME             = 'VALMO Transporter Portal';

/* ============================== WEB APP ENTRY ============================== */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/* ============================== SHEET HELPERS ============================== */
function _ss() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActive();
}

/**
 * Read a tab into an array of row-objects. Robust to the R1 "decorative" layout:
 * finds the header row by scanning the first 8 rows for one that contains `keyColumn`.
 * Headers are matched case-insensitively and trimmed.
 */
function _readTab(tabName, keyColumn) {
  var sh = _ss().getSheetByName(tabName);
  if (!sh) throw new Error('Missing tab: ' + tabName);
  var values = sh.getDataRange().getValues();
  if (!values.length) return [];

  var headerRow = -1, headers = null;
  var kc = keyColumn.toLowerCase();
  for (var r = 0; r < Math.min(8, values.length); r++) {
    var row = values[r].map(function (c) { return String(c).trim().toLowerCase(); });
    if (row.indexOf(kc) !== -1) { headerRow = r; headers = values[r].map(function (c) { return String(c).trim(); }); break; }
  }
  if (headerRow === -1) return [];

  var out = [];
  for (var i = headerRow + 1; i < values.length; i++) {
    var raw = values[i];
    // skip blank rows and the "(enter rows below…)" placeholder row
    if (raw.every(function (c) { return c === '' || c === null; })) continue;
    var first = String(raw[0]).trim();
    if (first.charAt(0) === '(' ) continue;
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      if (!headers[j]) continue;
      obj[headers[j]] = raw[j];
    }
    out.push(obj);
  }
  return out;
}

/* ============================== VALUE COERCION / FORMATTING ============================== */
function _s(v)   { return (v === null || v === undefined) ? '' : String(v).trim(); }
function _low(v) { return _s(v).toLowerCase(); }
function _num(v) { var n = Number(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
function _yes(v) { var s = _low(v); return s === 'yes' || s === 'true' || s === 'y' || s === '1'; }

/* First argument that is actually filled in. Needed because `_num(a) || _num(b)` treats a legitimate
   resolved value of 0 as "not set" and silently falls through to the system value. Resolution
   precedence has to distinguish "blank" from "zero" — a dispute resolved to 0 km is a real outcome. */
function _firstSet() {
  for (var i = 0; i < arguments.length; i++) {
    if (_s(arguments[i]) !== '') return arguments[i];
  }
  return '';
}

function _tz() { return _ss().getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'Asia/Kolkata'; }

// "3 Jul 2026, 11:53 pm"
function _fmtLong(v) {
  var d = _toDate(v); if (!d) return _s(v);
  return Utilities.formatDate(d, _tz(), 'd MMM yyyy, hh:mm a').replace('AM', 'am').replace('PM', 'pm');
}
// "2 Jul, 11:53 pm"
function _fmtShort(v) {
  var d = _toDate(v); if (!d) return _s(v);
  return Utilities.formatDate(d, _tz(), 'd MMM, hh:mm a').replace('AM', 'am').replace('PM', 'pm');
}
// "2 Aug 26"
function _fmtWin(v) {
  var d = _toDate(v); if (!d) return _s(v);
  return Utilities.formatDate(d, _tz(), 'd MMM yy');
}
// "15 Jul – 31 Jul 2026"
/* ===================== ZONAL IDENTITY =====================
 * A zonal trip has no contract_id. Its rfq_id is its contract reference, so the panel card id is
 * ZONAL_PREFIX + rfq_id and the MIS keys its zonal lines on the same string. Both live here so the
 * panel and Billing.gs cannot drift.
 */
var ZONAL_PREFIX = 'ZONAL::';
var NO_RFQ_KEY   = '(no RFQ id)';        // zonal REGULAR with a blank rfq_id: a data problem, gated
/* A zonal ADHOC trip is billed on its amount, not on an RFQ rate, so it legitimately has NO rfq_id.
   That is not a missing value and must never read as one, or be gated as one. It gets its own label. */
var ZONAL_ADHOC_REF = 'Zonal adhoc';
function _zonalCardId(rfq) { return ZONAL_PREFIX + (_s(rfq) || NO_RFQ_KEY); }
function _zonalRfqOf(cardId) {           // 'ZONAL::FM-Zonal-x' -> 'FM-Zonal-x'; anything else -> ''
  var s = _s(cardId);
  return s.indexOf(ZONAL_PREFIX) === 0 ? s.slice(ZONAL_PREFIX.length) : '';
}
/* most frequent key in a {key: count} map. Used to derive a zonal card's cluster and vehicle size from
   its own trips, since by decision there is no RFQ master tab to read them from. */
function _modeKey(o) {
  var best = '', n = -1;
  Object.keys(o || {}).forEach(function (k) { if (o[k] > n) { n = o[k]; best = k; } });
  return best;
}

function _fmtRange(a, b) {
  var da = _toDate(a), db = _toDate(b);
  if (!da || !db) return (_s(a) + (_s(b) ? ' – ' + _s(b) : ''));
  return Utilities.formatDate(da, _tz(), 'd MMM') + ' – ' + Utilities.formatDate(db, _tz(), 'd MMM yyyy');
}
// compact vehicle active period: "20\u201331 Jul" (same month) or "28 Jul \u2013 3 Aug"
function _fmtVehPeriod(a, b) {
  var da = _toDate(a), db = _toDate(b); if (!da || !db) return '';
  var tz = _tz();
  var sameMon = Utilities.formatDate(da, tz, 'MMM yyyy') === Utilities.formatDate(db, tz, 'MMM yyyy');
  return sameMon
    ? Utilities.formatDate(da, tz, 'd') + '\u2013' + Utilities.formatDate(db, tz, 'd MMM')
    : Utilities.formatDate(da, tz, 'd MMM') + ' \u2013 ' + Utilities.formatDate(db, tz, 'd MMM');
}
function _toDate(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (v === '' || v === null || v === undefined) return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/* ============================== ACCESS CONTROL ============================== */
/** Returns { email, oracle, name, role, cluster } for a registered email, or null. */
function _lookupUser(email) {
  var e = _low(email);
  if (!e) return null;
  var rows = _readTab(TABS.accessControl, 'email');
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (_low(r.email) !== e) continue;
    if (r.active !== undefined && r.active !== '' && !_yes(r.active)) return null; // disabled
    return {
      email:   e,
      oracle:  _s(r.vendor_oracle_id),
      name:    _s(r.vendor_name),
      role:    _low(r.role) || 'vendor',
      cluster: _s(r.cluster_scope)
    };
  }
  return null;
}

/* ============================== OTP + SESSION ============================== */
function _cache()  { return CacheService.getScriptCache(); }
function _props()  { return PropertiesService.getScriptProperties(); }
function _otpKey(email)  { return 'otp_' + _low(email); }
function _sessKey(token) { return 'sess_' + token; }

/** STEP 1 — vendor requests a login code. */
function requestOtp(email) {
  email = _low(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Please enter a valid email address.' };

  var user = _lookupUser(email);
  if (!user) return { ok: false, error: 'This email is not registered for the transporter portal. Please contact your VALMO ops SPOC.' };
  if (user.role !== 'vendor') return { ok: false, error: 'This portal is for transporters only.' };

  // resend cooldown
  var last = _cache().get('otpcd_' + email);
  if (last) return { ok: false, error: 'A code was just sent. Please wait a few seconds and check your inbox/spam.' };

  var code = ('' + Math.floor(100000 + Math.random() * 900000)); // 6-digit
  _cache().put(_otpKey(email), JSON.stringify({ code: code, attempts: 0 }), OTP_TTL_SECONDS);
  _cache().put('otpcd_' + email, '1', OTP_RESEND_COOLDOWN);

  MailApp.sendEmail({
    to: email,
    subject: APP_NAME + ' — your login code: ' + code,
    htmlBody:
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1A2A3A">' +
      '<p>Hello ' + (user.name || 'Transporter') + ',</p>' +
      '<p>Your one-time login code for the ' + APP_NAME + ' is:</p>' +
      '<p style="font-size:30px;font-weight:bold;letter-spacing:5px;color:#123A6B">' + code + '</p>' +
      '<p>This code expires in ' + (OTP_TTL_SECONDS / 60) + ' minutes. If you did not request it, ignore this email.</p>' +
      '<hr style="border:none;border-top:1px solid #E2E8F0"><p style="font-size:11px;color:#6B7C8F">VALMO — automated message, do not reply.</p></div>'
  });
  return { ok: true, message: 'Code sent to ' + email + '.' };
}

/** STEP 2 — vendor submits the code; on success we issue a session token. */
function verifyOtp(email, code) {
  email = _low(email);
  code = _s(code);
  var raw = _cache().get(_otpKey(email));
  if (!raw) return { ok: false, error: 'Code expired or not found. Please request a new one.' };

  var rec = JSON.parse(raw);
  if (rec.attempts >= OTP_MAX_ATTEMPTS) { _cache().remove(_otpKey(email)); return { ok: false, error: 'Too many attempts. Please request a new code.' }; }
  if (rec.code !== code) {
    rec.attempts++;
    _cache().put(_otpKey(email), JSON.stringify(rec), OTP_TTL_SECONDS);
    return { ok: false, error: 'Incorrect code. ' + (OTP_MAX_ATTEMPTS - rec.attempts) + ' attempt(s) left.' };
  }

  _cache().remove(_otpKey(email)); // burn OTP (one-time use)

  var user = _lookupUser(email);
  if (!user) return { ok: false, error: 'Account no longer active.' };

  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  var session = { email: user.email, oracle: user.oracle, name: user.name, role: user.role,
                  exp: Date.now() + SESSION_TTL_SECONDS * 1000 };
  _props().setProperty(_sessKey(token), JSON.stringify(session));
  return { ok: true, token: token, vendorName: user.name };
}

/** Validate a token -> session object, or null. Deletes expired sessions. */
function _session(token) {
  if (!token) return null;
  var raw = _props().getProperty(_sessKey(token));
  if (!raw) return null;
  var s = JSON.parse(raw);
  if (Date.now() > s.exp) { _props().deleteProperty(_sessKey(token)); return null; }
  return s;
}

function validateSession(token) {
  var s = _session(token);
  return s ? { ok: true, vendorName: s.name } : { ok: false };
}

function logout(token) {
  if (token) _props().deleteProperty(_sessKey(token));
  return { ok: true };
}

/* ============================== SCOPED DATA API ============================== */
/**
 * Returns { ok, vendor, contracts, vehicles, trips } for the logged-in vendor ONLY.
 * Scope is derived from the SESSION (oracle), never from any client-supplied value  -> G6.
 * Only rows with sent_to_vendor_flag == "Yes" are ever returned                       -> G7.
 */
function getVendorData(token) {
  var s = _session(token);
  if (!s) return { ok: false, error: 'SESSION_EXPIRED' };
  try {
    return { ok: true, data: _buildVendorPayload(s.oracle) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/* Latest dispute per trip for THIS vendor, shaped for the read-only View-Dispute dialog.
 * Reads Disputes_Log (returns {} if the tab/rows don't exist yet). Keeps the newest by raised_at,
 * so a re-disputed trip shows its most recent round + the resolution that preceded it. */
function _disputesTab() {
  try { return _readTab('Disputes_Log', 'dispute_id'); } catch (e) { return []; }
}
function _buildDisputeMap(oracle) {
  var rows = _disputesTab(), map = {}, orc = _s(oracle);
  rows.forEach(function (d) {
    if (_s(d.transporter_oracle_id) !== orc) return;              // scope to this vendor
    var tid = _s(d.trip_id); if (!tid) return;
    var ts = _s(d.raised_at);
    if (map[tid] && _s(map[tid]._raised) >= ts) return;          // keep the latest round
    map[tid] = {
      _raised: ts,
      id: _s(d.dispute_id), raised_at: _s(d.raised_at) ? _fmtShort(d.raised_at) : '',
      categories: _s(d.categories) ? _s(d.categories).split('|') : [],
      claim_billing_type: _s(d.claim_billing_type), claim_aggregate_vehicle: _s(d.claim_aggregate_vehicle),
      claim_km: _s(d.claim_km), claim_amount: _s(d.claim_amount), claim_contract_id: _s(d.claim_contract_id),
      // zonal claims — without these the View-Dispute dialog cannot render a zonal dispute at all
      claim_zonal_amount: _s(d.claim_zonal_amount), claim_rfq_id: _s(d.claim_rfq_id),
      description: _s(d.vendor_description), callback: _s(d.callback_number), proof_url: _s(d.proof_url),
      status: _s(d.dispute_status), reconfirm_status: _s(d.reconfirm_status),
      orig_billing_type: _s(d.orig_billing_type), orig_total_km: _s(d.orig_total_km), orig_adhoc_amount: _s(d.orig_adhoc_amount),
      orig_route_scope: _s(d.orig_route_scope), orig_rfq_id: _s(d.orig_rfq_id),
      orig_zonal_rfq_amount: _s(d.orig_zonal_rfq_amount),
      resolution_note: _s(d.resolution_note), resolved_billing_type: _s(d.resolved_billing_type),
      resolved_km: _s(d.resolved_km), resolved_amount: _s(d.resolved_amount),
      resolved_zonal_amount: _s(d.resolved_zonal_amount), resolved_rfq_id: _s(d.resolved_rfq_id),
      resolved_aggregate_vehicle: _s(d.resolved_aggregate_vehicle), resolved_contract_id: _s(d.resolved_contract_id),
      resolved_by: _s(d.resolved_by), resolved_at: _s(d.resolved_at) ? _fmtShort(d.resolved_at) : ''
    };
  });
  Object.keys(map).forEach(function (k) { delete map[k]._raised; });
  return map;
}

/* ===================== SINGLE SOURCE OF TRUTH: per-trip classification =====================
 * _buildVendorPayload (the panel) and Billing.gs (the billing MIS) BOTH call this function.
 * That is deliberate: it is the only way the MIS and the panel cannot drift apart.
 * Do not inline these rules anywhere else — extend them here.
 *
 *   billing   = billing_type_resolved || billing_type_final(local only) || billing_type_system
 *   rto       = (challan_type_final || challan_type) startsWith 'rto',
 *               or the zero-km + km_accumulated_flag='No' fallback on a Regular trip
 *   isDefault = the (contract_id, vehicle_number) pair exists in Contract_Vehicles (exact string)
 *   foldTo    = replaced_default_vehicle_final || replaced_default_vehicle_system
 */
function _classifyTrip(t, defSet, defaultBilling) {
  defSet = defSet || {};
  var no      = _s(t.vehicle_number);

  // ---- route scope: SYSTEM ONLY. There is no route_scope_final; ground cannot revert it. ----
  var scope   = _s(t.route_scope) || 'Local';
  var isZonal = _low(scope) === 'zonal';

  /* ONE precedence, both scopes:   resolution  >  ground  >  system
   *
   *   billing_type_resolved  written ONLY by the two dispute-resolution appliers. Highest authority on
   *                          BOTH scopes, so `resolved_billing_type` always lands in one predictable
   *                          column and Trip_Level can be read without knowing the trip's scope.
   *   billing_type_final     ground's column. Counts on LOCAL only — on zonal it stays ignored outright,
   *                          which is rule (iii) holding by construction, not just by the guard.
   *   billing_type_system    the engine.
   *
   * The two must never share a column: a stray ground edit on a row the transfer guard never saw would
   * otherwise silently re-price the trip. The TR-ZT-0006 test row is exactly that case. (2026-08-07) */
  var billing = _s(t.billing_type_resolved)
    || (isZonal ? '' : _s(t.billing_type_final))
    || _s(t.billing_type_system) || (defaultBilling || 'Regular');
  var isAdhoc = _low(billing) === 'adhoc';

  /* KM PRECEDENCE:  resolution > system.   (2026-08-27)
   * Until now this read total_trip_km alone, and the resolution appliers wrote resolved_km straight
   * INTO total_trip_km — destroying the system value, leaving no audit trail, and losing the
   * correction outright whenever the applier ran before resolved_km was filled in. Every other
   * resolvable field already has its own destination (billing_type_resolved, challan_type_final,
   * zonal_rfq_amount_final, replaced_default_vehicle_final); KM and the adhoc amount were the only
   * two written destructively. They now have one too, and this is what reads it.
   * Ground deliberately gets NO km column: there is no total_trip_km_final and must not be one. */
  var kmSys   = _num(t.total_trip_km);
  var kmRes   = _s(t.total_trip_km_resolved);
  var km      = kmRes !== '' ? _num(kmRes) : kmSys;
  var cf      = _low(t.challan_type_final);      // ground override of RTO wins over the system column
  var rto     = cf ? (cf.indexOf('rto') === 0)
                   : (_low(t.challan_type).indexOf('rto') === 0 ||
                      (!_yes(t.km_accumulated_flag) && km === 0 && !isAdhoc && (_s(t.km_accumulated_flag) !== '')));

  var isRepl  = (!!no && !defSet[no]) || _yes(t.replacement_flag_system) || _low(t.replacement_flag_system) === 'repl';
  var foldTo  = _s(t.replaced_default_vehicle_final) || _s(t.replaced_default_vehicle_system);
  var vs      = _low(t.vendor_status);
  var settled = (vs === 'confirmed' || vs === 'reconfirmed');

  // ---- money ----------------------------------------------------------------------------------
  // zonalAmt is the RESOLVED zonal rate (an upheld dispute wins over the system value).
  var zonalAmt = _num(t.zonal_rfq_amount_final) || _num(t.zonal_rfq_amount);
  // same precedence as KM, same reason — see the comment on kmRes above
  var amtSys   = _num(t.adhoc_amount);
  var amtRes   = _s(t.adhoc_amount_resolved);
  var adhocAmt = amtRes !== '' ? _num(amtRes) : amtSys;
  /* THE RTO RULE, TWO PARTS  (2026-09-08 — this REPLACES the old blanket "an RTO trip pays nothing")
   *
   *   REGULAR, either scope, replacement included  ->  pays NOTHING, and its KM reaches no slab.
   *        A replacement row is a Regular row, so it is covered by this arm without a special case.
   *   ADHOC, either scope                          ->  IS PAID, at the adhoc amount the row carries.
   *        An RTO-only adhoc run is still a vehicle hired for a job, so it earns its trip amount.
   *
   * Why it changed: adhoc RTO used to be zero, and ops were lifting the RTO marking through dispute
   * resolution to get such trips paid. That workaround is what put a rupee figure into
   * challan_type_final on four Pune Logistics rows on 03 Sep. Paying it by rule removes the need for
   * the dispute, so the challan column stops being used as a payment switch.
   *
   * kmToSlab below is deliberately untouched: adhoc KM never reached a grouped slab, RTO or not.
   * Order matters — isAdhoc is tested BEFORE rto, which is the whole of the change. */
  var payable  = isAdhoc ? adhocAmt : (rto ? 0 : (isZonal ? zonalAmt : 0));
  // Only Local + Regular + non-RTO KM ever reaches the grouped KM slab.
  var kmToSlab = (!isZonal && !isAdhoc && !rto);

  return {
    no:        no,
    scope:     isZonal ? 'Zonal' : 'Local',
    isZonal:   isZonal,
    rfqId:     _s(t.rfq_id),
    /* ref = the trip's OWN billing reference: contract_id on local, rfq_id on zonal. Same rule as
       _billRef() in Actions.gs, so a panel row, a log row and an MIS line all name a trip identically.
       Needed because a bucket card holds trips from several different references. */
    ref:       isZonal ? (_s(t.rfq_id) || (isAdhoc ? ZONAL_ADHOC_REF : NO_RFQ_KEY))
                       : _s(t.contract_id),
    billing:   isAdhoc ? 'Adhoc' : 'Regular',
    isAdhoc:   isAdhoc,
    km:        km,
    /* kmWas / amtWas = the SYSTEM value a resolution replaced, or null when nothing was resolved.
       The panel shows it as "revised from N km" so the vendor can see the correction landed, and the
       MIS can show what changed. Never bill off these — bill off km / payable. */
    kmWas:     (kmRes !== '' && _num(kmRes) !== kmSys) ? kmSys : null,
    amtWas:    (amtRes !== '' && _num(amtRes) !== amtSys) ? amtSys : null,
    rto:       rto,
    isRepl:    isRepl,
    isDefault: (!!no && !!defSet[no]),
    foldTo:    foldTo,
    foldValid: (!!foldTo && !!defSet[foldTo]),
    settled:   settled,
    amt:       adhocAmt,      // raw sheet value
    zonalAmt:  zonalAmt,      // raw resolved zonal rate
    payable:   payable,       // what actually bills — RTO-aware. USE THIS, not amt/zonalAmt.
    kmToSlab:  kmToSlab,
    statusUi:  settled ? 'confirmed' : (vs === 'disputed' ? 'disputed' : (vs === 'reconfirm' ? 'reconfirm' : 'pending'))
  };
}

function _buildVendorPayload(oracle, opts) {
  opts = opts || {};
  oracle = _s(oracle);
  var ci = _readTab(TABS.contractInfo,     'contract_id');
  var cv = _readTab(TABS.contractVehicles, 'contract_id');
  var tl = _readTab(TABS.tripLevel,        'trip_id');

  // ---- scope: this vendor's contracts, and their TRANSFERRED trips only ----
  var myContracts = ci.filter(function (c) { return _s(c.vendor_oracle_id) === oracle; });
  var myContractIds = {};
  myContracts.forEach(function (c) { myContractIds[_s(c.contract_id)] = true; });

  var myTrips = tl.filter(function (t) {
    return _s(t.transporter_oracle_id) === oracle && (opts.allTrips || _yes(t.sent_to_vendor_flag));
  });

  var dmap = _buildDisputeMap(oracle);   // trip_id -> latest dispute detail (for the View-Dispute dialog)

  var vehiclesByContract = {}; // contract_id -> [Contract_Vehicles rows]
  cv.forEach(function (v) {
    var cid = _s(v.contract_id);
    if (!myContractIds[cid]) return;
    (vehiclesByContract[cid] = vehiclesByContract[cid] || []).push(v);
  });

  /* ---- Split the two axes BEFORE anything else.
     A zonal trip has no contract_id — its rfq_id IS its contract reference (decision 2026-08-07).
     So zonal never enters tripsByContract and is never touched by the per-contract loop below. ---- */
  var zonalAll = [], localAll = [];
  myTrips.forEach(function (t) {
    if (_low(_s(t.route_scope) || 'Local') === 'zonal') zonalAll.push(t); else localAll.push(t);
  });

  var tripsByContract = {};
  localAll.forEach(function (t) {
    var cid = _s(t.contract_id);
    (tripsByContract[cid] = tripsByContract[cid] || []).push(t);
  });

  var CONTRACTS = [], VEHICLES = {}, TRIPS = {};
  var ZADHOC = [], ZADHOC_TOTAL = 0;
  var vendorName = myContracts.length ? _s(myContracts[0].vendor_name) : '';
  var clusters = {}, mtdKm = 0;

  myContracts.forEach(function (c) {
    var cid = _s(c.contract_id);
    var defaults = (vehiclesByContract[cid] || []).slice();

    // Vx label map: defaults ordered by day1_order (fallback: sheet order)
    defaults.sort(function (a, b) { return _num(a.day1_order) - _num(b.day1_order); });
    var labelOf = {}; // vehicle_number -> "V1"
    var defSet = {};  // default (contracted) vehicle numbers for this contract
    defaults.forEach(function (v, i) { labelOf[_s(v.vehicle_number)] = 'V' + (i + 1); defSet[_s(v.vehicle_number)] = true; });
    var vehDates = {};  // vehicle_number -> {start,end}  (per-vehicle active period; subset of contract period)
    defaults.forEach(function (v) { vehDates[_s(v.vehicle_number)] = { start: _s(v.start_date), end: _s(v.end_date) }; });

    // tripsByContract holds LOCAL trips only — zonal is keyed on rfq_id and built after this loop.
    var cTrips = tripsByContract[cid] || [];

    // replacement vehicles = trip vehicle_numbers not in defaults, in first-appearance order
    var nextIdx = defaults.length;
    var replVehicles = []; // {no}
    cTrips.forEach(function (t) {
      var no = _s(t.vehicle_number);
      if (!no || labelOf[no]) return;
      labelOf[no] = 'V' + (++nextIdx);
      replVehicles.push({ no: no });
    });

    // ---- tiers grouped from Contract_Vehicles (pegged_km_slab, monthly_rate) ----
    var groups = {}, order = [];
    defaults.forEach(function (v) {
      var slab = _num(v.pegged_km_slab), rate = _num(v.monthly_rate);
      var k = slab + '|' + rate;
      if (!groups[k]) { groups[k] = { count: 0, slabPerVeh: slab, valuePerVeh: rate }; order.push(k); }
      groups[k].count++;
    });
    var tiers = order.map(function (k) { return groups[k]; });
    if (!tiers.length) tiers = [{ count: defaults.length || 1, slabPerVeh: _num(c.total_km_slab), valuePerVeh: _num(c.fixed_monthly_value) }];

    // ---- per-vehicle & per-contract aggregates from transferred trips ----
    function newAgg() { return { km: 0, regTrips: 0, adhocTrips: 0 }; }
    var agg = {}; // vehicle_number -> agg
    defaults.concat(replVehicles).forEach(function (v) { agg[_s(v.vehicle_number || v.no)] = newAgg(); });

    var contractRegKm = 0;
    var lastTripDate = null;

    var foldKm = {}, foldCnt = {};   // admin: replacement KM/trips folded into the default they stood in for
    var vehSlab = {};                // vehicle_number -> pegged_km_slab (defaults only)
    defaults.forEach(function (v) { vehSlab[_s(v.vehicle_number)] = _num(v.pegged_km_slab); });

    var mappedTrips = cTrips.map(function (t) {
      var _x      = _classifyTrip(t, defSet, 'Regular');   // shared classifier — see _classifyTrip
      var no      = _x.no;
      var isAdhoc = _x.isAdhoc;
      var isRepl  = _x.isRepl;
      var km      = _x.km;
      var rto     = _x.rto;

      if (!agg[no]) agg[no] = newAgg();
      if (isAdhoc) { agg[no].adhocTrips++; }
      else { agg[no].regTrips++; if (!rto) { agg[no].km += km; contractRegKm += km; } }

      var d = _toDate(t.trip_end_time);
      if (d && (!lastTripDate || d > lastTripDate)) lastTripDate = d;

      var replForNo = _x.foldTo;
      if (!isAdhoc && isRepl && !rto && replForNo) {
        foldKm[replForNo] = (foldKm[replForNo] || 0) + km; foldCnt[replForNo] = (foldCnt[replForNo] || 0) + 1;
      }
      var route = _buildRoute(t);

      return {
        id:        _s(t.trip_id),
        size:      _s(t.vehicle_size) || _s(c.vehicle_size),
        veh:       labelOf[no] || no,
        vehNo:     no,
        route:     route,
        billing:   isAdhoc ? 'Adhoc' : 'Regular',
        scope:     _x.scope,
        ref:       _x.ref,
        replTag:   (!isAdhoc && isRepl) ? 'repl' : 'default',
        replFor:   (!isAdhoc && isRepl) ? (labelOf[replForNo] || replForNo) : undefined,
        completed: _fmtShort(t.trip_end_time),
        km:        isAdhoc ? null : (rto ? 0 : km),
        amt:       isAdhoc ? _x.payable : null,          // RTO adhoc pays 0 — screen must match the bill
        /* the value a resolution replaced, so the row can say "revised from N". null = nothing was
           resolved. The View-Dispute dialog is not enough on its own: it is only reachable while the
           trip is still open, so once the vendor accepts, the row itself has to carry the evidence. */
        kmWas:     isAdhoc ? null : (rto ? null : _x.kmWas),
        amtWas:    isAdhoc ? _x.amtWas : null,
        rto:       rto ? true : undefined,
        challan:   _s(t.challan_type_final) || _s(t.challan_type),   // shown when disputing an RTO trip
        status:    _x.statusUi,
        win:       _low(t.vendor_status) === 'confirmed' ? null : _fmtWin(t.dispute_window_end),
        winTs:     _s(t.dispute_window_end),   // raw + comparable; blank = no window recorded = open
        // admin-only in practice: a vendor payload is already filtered to sent rows, so this is
        // always true there. On the ADMIN payload (allTrips) it is the ONLY way to tell a trip that
        // has been transferred from one that has not — vendor_status reads 'Pending' for both.
        sent:      _yes(t.sent_to_vendor_flag),
        /* admin only, and only on an untransferred trip: why the scheduled run is holding it back.
           Without this the admin sees "Not yet sent" on a trip that is being held DELIBERATELY and on
           one that is merely inside its ground window, with nothing to tell them apart. */
        hold:      _yes(t.sent_to_vendor_flag) ? undefined
                     : ((typeof _holdFromVendor === 'function') ? (_holdFromVendor(t) || undefined) : undefined),
        disp:      dmap[_s(t.trip_id)] || null
      };
    });

    // vehicle objects
    function vehObj(no, size, tag) {
      var a = agg[no] || newAgg();
      var o = { name: labelOf[no] || no, no: no, size: size, tag: tag,
               km: a.km, regTrips: a.regTrips, adhocTrips: a.adhocTrips, total: a.regTrips + a.adhocTrips };
      // per-vehicle active period — shown only when it is a strict subset of the contract period (mid-month add/removal)
      var vd = vehDates[no] || {};
      o.periodLabel = _fmtVehPeriod(vd.start || c.contract_start_date, vd.end || c.contract_end_date);  // shown for ALL vehicles (own period, else contract period)
      // fold replacement KMs into the default + per-vehicle utilisation — shown on BOTH vendor and admin
      var isDef = (tag === 'default');
      o.slab = isDef ? (vehSlab[no] || 0) : 0;
      o.replFoldedKm = isDef ? (foldKm[no] || 0) : 0;
      o.replFolded = isDef ? (foldCnt[no] || 0) : 0;
      o.effectiveKm = a.km + o.replFoldedKm;                   // default vehicle KM incl. its replacements
      if (isDef && o.slab > 0) {
        var _ps = vd.start || c.contract_start_date, _pe = vd.end || c.contract_end_date;  // project on the vehicle's OWN period
        var pf = _projFields(o.effectiveKm, o.slab, _ps, _pe);
        o.projKm = pf.projected; o.projPct = pf.projPct; o.sizing = pf.sizing;
      }
      return o;
    }
    var vehList = defaults.map(function (v) { return vehObj(_s(v.vehicle_number), _s(c.vehicle_size), 'default'); })
      .concat(replVehicles.map(function (v) { return vehObj(v.no, _s(c.vehicle_size), 'repl'); }));

    VEHICLES[cid] = vehList;
    TRIPS[cid] = mappedTrips;

    if (_s(c.cluster)) clusters[_s(c.cluster)] = true;
    mtdKm += contractRegKm;

    CONTRACTS.push({
      id:       cid,
      vendor:   vendorName,
      size:     _s(c.vehicle_size),
      cluster:  _s(c.cluster),
      nveh:     defaults.length || _num(c.no_of_vehicles),
      hours:    _s(c.hours_slab),
      regKm:    Math.round(contractRegKm),
      overRate: _num(c.ex_km_rate),
      duration: _fmtRange(c.contract_start_date, c.contract_end_date),
      lastTrip: lastTripDate ? _fmtLong(lastTripDate) : '—',
      tiers:    tiers
    });
    if (opts.admin) {
      var _c = CONTRACTS[CONTRACTS.length - 1];
      var _slabKm = tiers.reduce(function (s, r) { return s + r.count * r.slabPerVeh; }, 0);
      var _cpf = _projFields(_c.regKm, _slabKm, c.contract_start_date, c.contract_end_date);
      _c.oracle = oracle; _c.slabKm = _slabKm;
      _c.projKm = _cpf.projected; _c.projPct = _cpf.projPct; _c.sizing = _cpf.sizing;
    }
  });

  /* ══════════════════ ZONAL: ONE CARD PER rfq_id ══════════════════
     A zonal trip carries no contract_id — the rfq_id IS its contract reference. So zonal is grouped
     by rfq_id at VENDOR level (vendor comes from transporter_oracle_id on the trip row, which every
     row has), never by contract. Cluster, vehicle size, period and last-trip date are derived from the
     trips themselves; there is deliberately no RFQ master tab (decision 2026-08-07).
     Zonal ADHOC still goes to the vendor-level <oracle>_Zonal_Adhoc_Trips bucket — an adhoc trip is
     billed on its amount, not on an RFQ rate, so it does not belong to an RFQ card. ---- */
  var _zG = {}, _zOrder = [];
  zonalAll.forEach(function (t) {
    var zx = _classifyTrip(t, {}, 'Regular');          // no defSet: zonal has no default-vehicle notion
    var mapped = {
      id: _s(t.trip_id), size: _s(t.vehicle_size),
      veh: zx.no, vehNo: zx.no, route: _buildRoute(t),
      billing: zx.billing, scope: 'Zonal', rfq: zx.rfqId, ref: zx.ref,
      replTag: 'default', replFor: undefined,
      completed: _fmtShort(t.trip_end_time),
      km: null, amt: null, zamt: zx.payable,
      kmWas: null, amtWas: zx.amtWas,     // zonal has no KM slab; a zonal adhoc amount can be resolved
      rto: zx.rto ? true : undefined,
      challan: _s(t.challan_type_final) || _s(t.challan_type),
      status: zx.statusUi,
      win: zx.settled ? null : _fmtWin(t.dispute_window_end),
      winTs: _s(t.dispute_window_end),
      // admin-only in practice: a vendor payload is already filtered to sent rows, so this is
      // always true there. On the ADMIN payload (allTrips) it is the ONLY way to tell a trip that
      // has been transferred from one that has not — vendor_status reads 'Pending' for both.
      sent: _yes(t.sent_to_vendor_flag),
      disp: dmap[_s(t.trip_id)] || null
    };
    if (zx.isAdhoc) {
      mapped.amt = zx.payable; mapped.zamt = null;
      ZADHOC.push(mapped); ZADHOC_TOTAL += zx.payable;
      return;
    }
    var k = zx.rfqId || NO_RFQ_KEY;
    if (!_zG[k]) { _zG[k] = { rfq: k, trips: [], total: 0, clusters: {}, sizes: {}, minD: null, maxD: null }; _zOrder.push(k); }
    var g = _zG[k];
    g.trips.push(mapped); g.total += zx.payable;
    var _cl = _s(t.trip_cluster); if (_cl) g.clusters[_cl] = (g.clusters[_cl] || 0) + 1;
    var _sz = _s(t.vehicle_size);  if (_sz) g.sizes[_sz]   = (g.sizes[_sz]   || 0) + 1;
    var _d = _toDate(t.trip_date) || _toDate(t.trip_end_time);
    if (_d) { if (!g.minD || _d < g.minD) g.minD = _d; if (!g.maxD || _d > g.maxD) g.maxD = _d; }
  });
  _zOrder.sort();                                       // stable, readable RFQ order on the L1 list
  _zOrder.forEach(function (k) {
    var g = _zG[k];
    var ZID = _zonalCardId(k);                         // internal id; _cidLabel() strips the prefix
    VEHICLES[ZID] = [];                                 // no vehicle level for zonal
    TRIPS[ZID] = g.trips;
    var card = {
      id: ZID, rfqId: k, srcContract: k,                // srcContract === the RFQ id: it IS the contract ref
      vendor: vendorName, size: _modeKey(g.sizes) || '—', cluster: _modeKey(g.clusters) || 'Zonal',
      nveh: 0, hours: '—', regKm: 0, overRate: 0,
      duration: (g.minD && g.maxD) ? _fmtRange(g.minD, g.maxD) : '—',
      lastTrip: g.maxD ? _fmtLong(g.maxD) : '—',
      tiers: [], isZonalCard: true,
      zonalTotal: Math.round(g.total), zonalTrips: g.trips.length,
      rfqGroups: [{ rfq: k, trips: g.trips.length, amt: Math.round(g.total) }]
    };
    if (opts.admin) { card.oracle = oracle; card.slabKm = 0; card.projKm = 0; card.projPct = 0; card.sizing = 'good'; }
    CONTRACTS.push(card);
  });

  // ---- Zonal Adhoc bucket: vendor level, mirrors the Other-Adhoc bucket. Zonal adhoc has no
  //      contract slab and no vehicle level, so it never sits on a contract card. ----
  if (ZADHOC.length) {
    var ZBID = oracle + '_Zonal_Adhoc_Trips';
    VEHICLES[ZBID] = [];
    TRIPS[ZBID] = ZADHOC;
    CONTRACTS.push({
      id: ZBID, vendor: vendorName, size: '\u2014', cluster: 'Zonal Adhoc', nveh: 0,
      hours: '\u2014', regKm: 0, overRate: 0, duration: '\u2014', lastTrip: '\u2014',
      tiers: [], isZonalAdhocBucket: true, isAdhocBucket: true,
      adhocTotal: Math.round(ZADHOC_TOTAL), zonalTrips: ZADHOC.length, zonalTotal: 0
    });
    if (opts.admin) {
      var _zb = CONTRACTS[CONTRACTS.length - 1];
      _zb.oracle = oracle; _zb.slabKm = 0; _zb.projKm = 0; _zb.projPct = 0; _zb.sizing = 'good';
    }
  }

  // ---- Other Adhoc bucket: this vendor's trips whose contract_id is NOT one of their real contracts ----
  var _orphan = localAll.filter(function (t) { return !myContractIds[_s(t.contract_id)]; });
  if (_orphan.length) {
    var BID = 'ADHOC-' + oracle;
    var oAgg = {};
    var oTrips = _orphan.map(function (t) {
      var _x = _classifyTrip(t, {}, 'Adhoc');   // shared classifier; no defSet — bucket trips have no contract
      var no = _x.no;
      var isAdhoc = _x.isAdhoc;
      var km = _x.km;
      var rto = _x.rto;
      if (!oAgg[no]) oAgg[no] = { km: 0, regTrips: 0, adhocTrips: 0 };
      if (isAdhoc) oAgg[no].adhocTrips++; else { oAgg[no].regTrips++; if (!rto) oAgg[no].km += km; }
      return {
        id: _s(t.trip_id), size: _s(t.vehicle_size), veh: no, vehNo: no, route: _buildRoute(t),
        billing: isAdhoc ? 'Adhoc' : 'Regular', scope: _x.scope, ref: _x.ref,
        replTag: 'default', replFor: undefined,
        completed: _fmtShort(t.trip_end_time), km: isAdhoc ? null : (rto ? 0 : km),
        amt: isAdhoc ? _x.payable : null, rto: rto ? true : undefined,
        kmWas: isAdhoc ? null : (rto ? null : _x.kmWas), amtWas: isAdhoc ? _x.amtWas : null,
        challan: _s(t.challan_type_final) || _s(t.challan_type),
        status: _x.statusUi,
        win: _low(t.vendor_status) === 'confirmed' ? null : _fmtWin(t.dispute_window_end),
        winTs: _s(t.dispute_window_end),
        // admin-only in practice: a vendor payload is already filtered to sent rows, so this is
        // always true there. On the ADMIN payload (allTrips) it is the ONLY way to tell a trip that
        // has been transferred from one that has not — vendor_status reads 'Pending' for both.
        sent: _yes(t.sent_to_vendor_flag),
        disp: dmap[_s(t.trip_id)] || null
      };
    });
    var oVeh = Object.keys(oAgg).map(function (no) {
      var a = oAgg[no];
      return { name: no, no: no, size: '', tag: 'default', km: a.km, regTrips: a.regTrips, adhocTrips: a.adhocTrips, total: a.regTrips + a.adhocTrips };
    });
    var adhocTotal = 0;
    _orphan.forEach(function (t) {
      var _ox = _classifyTrip(t, {}, 'Adhoc');
      if (_ox.isAdhoc) adhocTotal += _ox.payable;    // RTO adhoc pays 0
    });
    VEHICLES[BID] = oVeh; TRIPS[BID] = oTrips;
    CONTRACTS.push({
      id: BID, vendor: vendorName, size: '\u2014', cluster: 'Other Adhoc', nveh: oVeh.length,
      hours: '\u2014', regKm: 0, overRate: 0, duration: '\u2014', lastTrip: '\u2014',
      tiers: [], isAdhocBucket: true, adhocTotal: Math.round(adhocTotal)
    });
    if (opts.admin) {
      var _b = CONTRACTS[CONTRACTS.length - 1];
      _b.oracle = oracle; _b.slabKm = 0; _b.projKm = 0; _b.projPct = 0; _b.sizing = 'good';
    }
  }

  return {
    vendor: {
      name:          vendorName,
      oracle:        oracle,
      duration:      CONTRACTS.length ? CONTRACTS[0].duration : '',
      mtdKm:         Math.round(mtdKm),
      clusters:      Object.keys(clusters).length,
      contractCount: CONTRACTS.length
    },
    contracts: CONTRACTS,
    vehicles:  VEHICLES,
    trips:     TRIPS
  };
}

/** Build a node route array from Trip_Level source/dest columns. */
function _buildRoute(t) {
  var src = _s(t.source_node);
  var dest = _s(t.dest_fmh_nodes);
  var parts = dest ? dest.split(/[,>|;/]+/).map(function (x) { return x.trim(); }).filter(String) : [];
  var route = [];
  if (src) route.push(src);
  route = route.concat(parts);
  if (!route.length && _s(t.route_name)) route = _s(t.route_name).split(/[-,>|;/]+/).map(function (x) { return x.trim(); }).filter(String);
  return route;
}

/* ==================================================================================================
 * SETUP UTILITIES — run once from the editor. Not part of the runtime path.
 * ================================================================================================*/

/** Create all tabs (headers on row 1), including the 9th Access_Control tab. Safe to re-run. */
/* ============================ TAB SCHEMAS — single source of truth ============================
 * setupSheet() creates tabs from this, and seedDemo() remaps its legacy row arrays onto it. Keep it
 * in step with the live sheet: reads are by header name, so an out-of-date list here only bites when
 * a tab is CREATED or SEEDED, which is exactly when it is hardest to notice.
 * Zonal/local columns added 2026-08-07 — see docs/ZONAL_LOCAL_SCHEMA.md.
 */
var TAB_SCHEMA = {
    'Contract_Info': ['contract_id','vendor_oracle_id','vendor_name','cluster','vehicle_size','hours_slab','no_of_vehicles','total_km_slab','fixed_monthly_value','ex_km_rate','contract_start_date','contract_end_date','contract_status'],
    'Contract_Vehicles': ['contract_id','vehicle_number','day1_order','pegged_km_slab','monthly_rate','active_days','default_vehicle_id','start_date','end_date'],
    /* Placement Failure.
     * GRAIN: one row = one contracted vehicle-day not honoured, identified by
     *        (trip_date, vendor_oracle_id, vehicle_size, pegged_km_slab, hours_slab).
     * There is deliberately NO vehicle_number: which physical vehicle runs against a slot is not
     * fixed, so LH record "on the 18th you could not put out one 7 FT / 1500 km / 12hr vehicle".
     * hours_slab IS required — without it a 19434 / 7 FT / 1500 km row could belong to the 12hr
     * contract (Rs 23,500 a vehicle) or the 24hr one (Rs 38,000), and the deduction differs.
     * vehicles_failed lets two failures of the same shape on one day be ONE row with a count,
     * instead of two identical rows nobody can tell apart from an accidental paste. */
    'Placement Failure': ['trip_date','vendor_oracle_id','vendor_name','vehicle_size','pegged_km_slab','hours_slab','vehicles_failed','remarks','recorded_by','recorded_at'],
    'Trip_Level': ['row_id','trip_id','transporter_oracle_id','Vendor Name','contract_id','vehicle_number','vehicle_size','trip_cluster','route_scope','rfq_id','trip_date','trip_start_time','trip_end_time','source_node','dest_fmh_nodes','node_count','route_name','challan_type','total_trip_km','km_accumulated_flag','billing_type_system','adhoc_reason_system','replacement_flag_system','replaced_default_vehicle_system','zonal_rfq_amount','adhoc_amount','ground_confirmed','billing_type_final','replaced_default_vehicle_final','challan_type_final','zonal_rfq_amount_final','billing_type_resolved','Remarks','ground_review_deadline','sent_to_vendor_flag','sent_to_vendor_timestamp','vendor_status','dispute_window_end','retention_month','retention_state','total_trip_km_resolved','adhoc_amount_resolved'],
    'Node_Cluster_Map': ['node_code','cluster','node_type'],
    'Access_Control': ['email','vendor_oracle_id','vendor_name','role','cluster_scope','active'],
    'Disputes_Log': ['dispute_id','row_id','trip_id','contract_id','transporter_oracle_id','vendor_name','raised_at','categories','claim_billing_type','claim_aggregate_vehicle','claim_km','claim_amount','claim_zonal_amount','claim_rfq_id','claim_challan_type','claim_contract_id','vendor_description','proof_url','callback_number','orig_vehicle_number','orig_vehicle_size','orig_trip_cluster','orig_route','orig_route_scope','orig_rfq_id','orig_completed_time','orig_billing_type','orig_replaced_default_vehicle','orig_total_km','orig_adhoc_amount','orig_challan_type','orig_zonal_rfq_amount','dispute_status','resolution_note','resolved_billing_type','resolved_km','resolved_amount','resolved_zonal_amount','resolved_rfq_id','resolved_challan_type','resolved_aggregate_vehicle','resolved_contract_id','resolved_at','resolved_by','reconfirm_status'],
    'Ground_Confirmation_Log': ['log_id','row_id','trip_id','contract_id','transporter_oracle_id','route_scope','trip_end_time','ground_review_deadline','sent_to_vendor_timestamp','ground_action_state','billing_before','billing_after','replaced_vehicle_before','replaced_vehicle_after','data_sent','partial_edit_flag'],
    'Confirmation_Status_View': ['row_id','trip_id','contract_id','transporter_oracle_id','route_scope','sent_to_vendor_timestamp','vendor_status','status_updated_at','dispute_id','dispute_status','reconfirm_status','dispute_window_end','final_state']
};

function setupSheet() {
  var ss = _ss();
  var schema = TAB_SCHEMA;
  Object.keys(schema).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = schema[name];
    var top = sh.getRange(1, 1, 1, headers.length);
    top.setValues([headers]).setFontWeight('bold').setBackground('#123A6B').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  });
  SpreadsheetApp.getUi && SpreadsheetApp.getUi().alert('Tabs created / verified. Headers are on row 1.');
}

/**
 * Optional DEMO seed for end-to-end testing of auth + scoping BEFORE real Rajkot data.
 * Seeds two vendors (ORC-4521 registered to YOU, ORC-9902 to a dummy) so you can prove G6/G7.
 * Registers the currently-logged-in Google account's email as the ORC-4521 vendor.
 */
function seedDemo() {
  setupSheet();
  var ss = _ss();
  var myEmail = Session.getActiveUser().getEmail() || 'you@example.com';

  _writeRows('Access_Control', [
    [myEmail, 'ORC-4521', 'Vendor_1 Logistics Pvt Ltd', 'vendor', '', 'Yes'],
    ['other.vendor@example.com', 'ORC-9902', 'Vendor_2 Transport Co', 'vendor', '', 'Yes']
  ]);

  _writeRows('Contract_Info', [
    ['SUR-4521-19186-20260701-JUL','ORC-4521','Vendor_1 Logistics Pvt Ltd','Surat','7ft','12hr',3,7000,260000,20,'2026-07-15','2026-07-31','Active'],
    ['AMD-4521-19186-20260701-JUL','ORC-4521','Vendor_1 Logistics Pvt Ltd','Ahmedabad','10ft','24hr',2,3200,96000,20,'2026-07-15','2026-07-31','Active'],
    ['RJK-9902-30011-20260701-JUL','ORC-9902','Vendor_2 Transport Co','Rajkot','7ft','12hr',2,4000,120000,20,'2026-07-15','2026-07-31','Active']
  ]);

  _writeRows('Contract_Vehicles', [
    ['SUR-4521-19186-20260701-JUL','GJ05-AB-1234',1,2000,64000,17],
    ['SUR-4521-19186-20260701-JUL','GJ05-CD-5678',2,2000,64000,17],
    ['SUR-4521-19186-20260701-JUL','GJ05-EF-9012',3,3000,132000,17],
    ['AMD-4521-19186-20260701-JUL','GJ01-MN-7801',1,1600,48000,17],
    ['AMD-4521-19186-20260701-JUL','GJ01-MN-7802',2,1600,48000,17],
    ['RJK-9902-30011-20260701-JUL','GJ03-XY-1111',1,2000,60000,17],
    ['RJK-9902-30011-20260701-JUL','GJ03-XY-2222',2,2000,60000,17]
  ]);

  // Trip_Level — mixed: regular, replacement-regular, adhoc, RTO; both vendors; one NOT-yet-sent row (proves G7).
  // 32 columns, exactly in header order:
  // row_id, trip_id, transporter_oracle_id, contract_id, vehicle_number, vehicle_size, trip_cluster, trip_date,
  // trip_start_time, trip_end_time, source_node, dest_fmh_nodes, node_count, route_name, challan_type, total_trip_km,
  // km_accumulated_flag, billing_type_system, adhoc_reason_system, replacement_flag_system, replaced_default_vehicle_system,
  // adhoc_amount, ground_confirmed, billing_type_final, replaced_default_vehicle_final, ground_review_deadline,
  // sent_to_vendor_flag, sent_to_vendor_timestamp, vendor_status, dispute_window_end, retention_month, retention_state
  /* seedDemo's rows below are written in the ORIGINAL 33-column Trip_Level order. The live schema is
     now 39 columns (Vendor Name, route_scope, rfq_id, zonal_rfq_amount, zonal_rfq_amount_final,
     Remarks were added), so they are remapped by header name here rather than left to misalign
     silently. Add new seed values by name in _TL_SEED_DEFAULTS, never by pushing onto the array. */
  var _TL_OLD = ['row_id','trip_id','transporter_oracle_id','contract_id','vehicle_number','vehicle_size',
    'trip_cluster','trip_date','trip_start_time','trip_end_time','source_node','dest_fmh_nodes','node_count',
    'route_name','challan_type','total_trip_km','km_accumulated_flag','billing_type_system','adhoc_reason_system',
    'replacement_flag_system','replaced_default_vehicle_system','adhoc_amount','ground_confirmed',
    'billing_type_final','replaced_default_vehicle_final','challan_type_final','ground_review_deadline',
    'sent_to_vendor_flag','sent_to_vendor_timestamp','vendor_status','dispute_window_end','retention_month',
    'retention_state'];
  var _TL_SEED_DEFAULTS = { route_scope: 'Local' };     // seed data is all local
  function _tlRemap(rows) {
    var target = TAB_SCHEMA['Trip_Level'];
    return rows.map(function (r) {
      var o = {};
      _TL_OLD.forEach(function (h, i) { o[h] = (r[i] === undefined ? '' : r[i]); });
      Object.keys(_TL_SEED_DEFAULTS).forEach(function (k) { o[k] = _TL_SEED_DEFAULTS[k]; });
      return target.map(function (h) { return o[h] === undefined ? '' : o[h]; });
    });
  }
  _writeRows('Trip_Level', _tlRemap([
    // ORC-4521 / Surat — transferred (regular default)
    ['r1','TR-95998983-4331','ORC-4521','SUR-4521-19186-20260701-JUL','GJ05-AB-1234','7ft','Surat','2026-07-02','2026-07-02 20:10','2026-07-02 23:53','SUS','IPS,NMP,DJT,IDF',5,'','Regular',118,'Yes','Regular','','No','',0,'No','Regular','','2026-07-03 23:53','Yes','2026-07-03 08:00','Pending','2026-08-02','2026-07','LIVE'],
    // replacement-regular (V4 GJ05-GH-3456 replacing V1 GJ05-AB-1234)
    ['r2','TR-99160813-2626','ORC-4521','SUR-4521-19186-20260701-JUL','GJ05-GH-3456','7ft','Surat','2026-07-02','2026-07-02 20:00','2026-07-02 23:32','SUS','IH6,RWS',3,'','Regular',72,'Yes','Regular','','Yes','GJ05-AB-1234',0,'No','Regular','GJ05-AB-1234','2026-07-03 23:32','Yes','2026-07-03 08:00','Pending','2026-08-01','2026-07','LIVE'],
    // adhoc
    ['r3','TR-33471209-5567','ORC-4521','SUR-4521-19186-20260701-JUL','GJ05-EF-9012','7ft','Surat','2026-07-01','2026-07-01 18:00','2026-07-01 21:44','SUS','K19,TQR',3,'','Adhoc',0,'No','Adhoc','Outside cluster','No','',1450,'No','Adhoc','','2026-07-02 21:44','Yes','2026-07-02 08:00','Pending','2026-08-01','2026-07','LIVE'],
    // RTO (0 km, not accumulated) — already confirmed
    ['r4','TR-88120934-1102','ORC-4521','SUR-4521-19186-20260701-JUL','GJ05-AB-1234','7ft','Surat','2026-07-01','2026-07-01 17:00','2026-07-01 20:15','H2E','SUS',2,'','RTO',0,'No','Regular','','No','',0,'No','Regular','','2026-07-02 20:15','Yes','2026-07-02 08:00','Confirmed','2026-08-01','2026-07','LIVE'],
    // ORC-4521 / Ahmedabad — transferred (regular default)
    ['r5','TR-50188211-3390','ORC-4521','AMD-4521-19186-20260701-JUL','GJ01-MN-7801','10ft','Ahmedabad','2026-07-02','2026-07-02 15:00','2026-07-02 19:20','AMS','D22,KJP',3,'','Regular',76,'Yes','Regular','','No','',0,'No','Regular','','2026-07-03 19:20','Yes','2026-07-03 08:00','Pending','2026-08-02','2026-07','LIVE'],
    // ORC-4521 — NOT yet sent (sent_to_vendor_flag=No -> must NOT appear -> proves G7)
    ['r6','TR-70000000-9999','ORC-4521','SUR-4521-19186-20260701-JUL','GJ05-CD-5678','7ft','Surat','2026-07-04','2026-07-04 18:00','2026-07-04 21:00','SUS','NMP',2,'','Regular',60,'Yes','Regular','','No','',0,'No','Regular','','2026-07-05 21:00','No','','','','2026-07','LIVE'],
    // ORC-9902 / Rajkot — the OTHER vendor (must NOT appear for ORC-4521 -> proves G6)
    ['r7','TR-40012388-1191','ORC-9902','RJK-9902-30011-20260701-JUL','GJ03-XY-1111','7ft','Rajkot','2026-07-02','2026-07-02 19:00','2026-07-02 22:14','RJS','L4E,MQP',3,'','Regular',142,'Yes','Regular','','No','',0,'No','Regular','','2026-07-03 22:14','Yes','2026-07-03 08:00','Pending','2026-08-02','2026-07','LIVE']
  ]));
  SpreadsheetApp.getUi && SpreadsheetApp.getUi().alert('Demo data seeded. You are registered as ORC-4521 (' + myEmail + '). Log in to the web app to test.');
}

/** Append rows under the header row of a tab (used by seedDemo). */
function _writeRows(tabName, rows) {
  var sh = _ss().getSheetByName(tabName);
  var last = sh.getLastRow();
  var start = Math.max(last + 1, 2);
  if (rows.length) sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}

/** Menu for convenience when the Sheet is open. */
/** Menu wrapper: stop the automatic sync trigger and confirm. */
function stopSyncFromMenu() {
  SpreadsheetApp.getUi().alert(stopSyncTrigger());
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('VALMO Panel')
    .addItem('1 · Create / verify tabs', 'setupSheet')
    .addItem('2 · Seed demo data (testing)', 'seedDemo')
    .addSeparator()
    .addItem('3 · Refresh panel data (sync only)', 'syncNowFromMenu')
    .addItem('4 · Apply vendor actions NOW (drain + sync)', 'drainAndSyncFromMenu')
    .addItem('5 · Import resolved disputes (CSV)', 'importResolvedDisputes')
    .addItem('5a · Check resolutions are in sync (read-only)', 'repairMissedResolutionsFromMenu')
    .addSeparator()
    .addItem('6 · Turn ON auto-apply (drain + sync, 10 min — NO filter)', 'createDrainSyncFromMenu')
    .addItem('7 · Stop auto-apply', 'stopSyncFromMenu')
    .addSeparator()
    .addItem('6a · Turn ON scheduled run (14:30/18:30/22:30/03:30 IST, skips Adhoc + RTO)', 'createScheduledFilteredFromMenu')
    .addItem('6b · Run the scheduled job NOW', 'runScheduledFilteredNow')
    .addItem('7a · Stop the scheduled run', 'stopScheduledFilteredFromMenu')
    .addItem('7b · Show trigger status + timezone', 'showTriggerStatusFromMenu')
    .addSeparator()
    .addItem('8 · Set vehicle dropdowns on Trip_Level', 'applyReplacedVehicleValidationFromMenu')
    .addSeparator()
    .addItem('9 · Refresh cost view + gates (all vendors)', 'refreshCostViewFromMenu')
    .addItem('10 · Generate vendor MIS \u2192 Excel', 'generateVendorMisFromMenu')
    .addToUi();
}

/* ============================ Data-validation: replaced_default_vehicle_final ============================ *
 * Per-row DEPENDENT dropdown. For each Trip_Level row, the allowed values on
 * replaced_default_vehicle_final are the DEFAULT vehicles of that row's contract_id (column D),
 * read from Contract_Vehicles. Contract ids with no defaults (e.g. Other Adhoc "ADHOC-<oracle>")
 * get their validation cleared (blank allowed) — an adhoc trip has no default to fold into.
 * Re-run this from the menu after new trips / contracts load. Keys purely on whether the contract_id
 * exists in Contract_Vehicles, so the exact adhoc-id format does not matter.
 * ============================================================================================== */
function applyReplacedVehicleValidationFromMenu() {
  SpreadsheetApp.getUi().alert(applyReplacedVehicleValidation());
}
function applyReplacedVehicleValidation() {
  var ctx = _ctx(TABS.tripLevel, 'trip_id');
  var cIdx = ctx.idx['contract_id'], rIdx = ctx.idx['replaced_default_vehicle_final'], tIdx = ctx.idx['trip_id'];
  if (cIdx === undefined) throw new Error('Trip_Level: contract_id column not found.');
  if (rIdx === undefined) throw new Error('Trip_Level: replaced_default_vehicle_final column not found.');

  var byC = {};
  _readTab('Contract_Vehicles', 'contract_id').forEach(function (v) {
    var cd = _s(v.contract_id), no = _s(v.vehicle_number);
    if (cd && no) (byC[cd] = byC[cd] || []).push(no);
  });

  var sh = ctx.sh;
  var scIdx = ctx.idx['route_scope'];
  var firstRow = ctx.headerRow + 2;                 // 1-based first data row
  var lastRow = sh.getLastRow();
  var applied = 0, cleared = 0, skippedZonal = 0;
  for (var r = firstRow; r <= lastRow; r++) {
    var row = ctx.values[r - 1];
    if (!row || !_s(row[tIdx])) continue;           // skip blank rows
    // Zonal has no vehicle-level mapping, so replaced_default_vehicle is meaningless there. Offering a
    // dropdown would invite exactly the edit the ZONAL_NOT_EDITABLE guard then strips out.
    if (scIdx !== undefined && _low(row[scIdx]) === 'zonal') {
      sh.getRange(r, rIdx + 1).clearDataValidations();
      skippedZonal++;
      continue;
    }
    var cid = _s(row[cIdx]);
    var cell = sh.getRange(r, rIdx + 1);
    var list = cid ? byC[cid] : null;
    if (list && list.length) {
      cell.setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(list, true)
          .setAllowInvalid(false)
          .setHelpText('Must be a default vehicle of ' + cid + ' (from Contract_Vehicles).')
          .build()
      );
      applied++;
    } else {
      cell.clearDataValidations();                  // ADHOC-<oracle> / no defaults -> leave free
      cleared++;
    }
  }
  return 'replaced_default_vehicle_final — dropdown set on ' + applied + ' row(s), cleared on ' + cleared + ', skipped ' + skippedZonal + ' zonal row(s).';
}

/** Menu wrapper: run the sync on demand and show the result (handy for testing). */
function syncNowFromMenu() {
  try {
    var msg = syncToUpstash();
    SpreadsheetApp.getUi().alert('Sync complete\n\n' + msg);
  } catch (e) {
    SpreadsheetApp.getUi().alert('Sync failed\n\n' + e.message +
      '\n\nCheck that UPSTASH_URL and UPSTASH_TOKEN are set in Project Settings → Script properties.');
  }
}

/* ==================================================================================================
 * ADMIN — all-vendors KM utilization payload (read-only). Written to Upstash key admin:all by Sync.
 * Utilization vs contract KM slab, projected to period end:
 *   expected_to_date = slab × elapsed/total ;  projected = actual × total/elapsed
 *   status: OVER (projected > slab), UNDER (projected < 90% slab), else ON-TRACK.
 * ================================================================================================*/
function _projFields(actual, slab, startRaw, endRaw) {
  var now = new Date();
  var start = _toDate(startRaw), end = _toDate(endRaw);
  var totalDays = (start && end) ? Math.max(1, (end - start) / 86400000) : 30;
  var elapsed = start ? Math.min(Math.max((now - start) / 86400000, 0), totalDays) : totalDays;
  var projected = elapsed > 0 ? Math.round(actual * (totalDays / elapsed)) : actual;
  var projPct = slab > 0 ? Math.round(projected / slab * 100) : 0;
  var sizing = projected > slab * 1.02 ? 'over' : (projected < slab * 0.90 ? 'under' : 'good');
  return { projected: projected, projPct: projPct, sizing: sizing, expected: Math.round(slab * (elapsed / totalDays)) };
}

/* ADMIN payload = the SAME vendor screens (contracts -> vehicles -> trips) across ALL vendors,
 * built over ALL completed trips (opts.allTrips) and read-only (opts.admin adds projection tags +
 * folds replacement KMs into the default they stood in for). No new enums — reuses _buildVendorPayload. */
function _buildAdminPayload() {
  var ci = _readTab(TABS.contractInfo, 'contract_id');
  var oracles = [], seen = {};
  ci.forEach(function (c) { var o = _s(c.vendor_oracle_id); if (o && !seen[o]) { seen[o] = 1; oracles.push(o); } });

  var CONTRACTS = [], VEHICLES = {}, TRIPS = {}, clusters = {};
  var over = 0, under = 0, onTrack = 0, totSlab = 0, totActual = 0;
  oracles.forEach(function (o) {
    var p = _buildVendorPayload(o, { allTrips: true, admin: true });
    p.contracts.forEach(function (c) {
      CONTRACTS.push(c);
      if (c.sizing === 'over') over++; else if (c.sizing === 'under') under++; else onTrack++;
      totSlab += (c.slabKm || 0); totActual += (c.regKm || 0);
      if (c.cluster) clusters[c.cluster] = true;
    });
    Object.keys(p.vehicles).forEach(function (k) { VEHICLES[k] = p.vehicles[k]; });
    Object.keys(p.trips).forEach(function (k) { TRIPS[k] = p.trips[k]; });
  });

  return {
    admin: true,
    generated_at: Utilities.formatDate(new Date(), _tz(), 'd MMM yyyy, HH:mm'),
    vendor: { name: 'All Vendors \u2014 Sizing View', oracle: 'ADMIN',
              contractCount: CONTRACTS.length, clusters: Object.keys(clusters).length, mtdKm: Math.round(totActual) },
    summary: { total: CONTRACTS.length, over: over, under: under, onTrack: onTrack, totalSlab: totSlab, totalActual: totActual },
    contracts: CONTRACTS, vehicles: VEHICLES, trips: TRIPS
  };
}

/* ============================ DEBUG: inspect what the sync produces for one contract ============================ *
 * Run this from the Apps Script editor (change contractId below to the one you're debugging), then open
 * View -> Logs (or Executions) and read the output. It shows, straight from the live sheet:
 *   - the Contract_Vehicles default rows for the contract (vehicle_number + day1_order)
 *   - the distinct vehicle numbers actually used by that contract's trips (with counts)
 *   - any TRIP vehicle that is NOT in the default list (these render as "Replacement" on the panel)
 *   - the vehicle list the panel payload would actually show (Vx | number | tag)
 * Quotes are printed around vehicle numbers so trailing spaces / case are visible.
 * ============================================================================================== */
function debugContract() {
  var contractId = 'RJK10-18838-20260717-01';   // <-- change to the contract you want to inspect

  var ci = _readTab(TABS.contractInfo, 'contract_id').filter(function (r) { return _s(r.contract_id) === _s(contractId); });
  if (!ci.length) { Logger.log('!! contract_id "' + contractId + '" NOT found in Contract_Info (check exact spelling/spaces)'); return; }
  var oracle = _s(ci[0].vendor_oracle_id);
  Logger.log('contract=' + contractId + '  oracle=' + oracle);

  var cv = _readTab(TABS.contractVehicles, 'contract_id').filter(function (r) { return _s(r.contract_id) === _s(contractId); });
  Logger.log('--- Contract_Vehicles default rows: ' + cv.length + ' ---');
  var cvset = {};
  cv.forEach(function (r) { var v = _s(r.vehicle_number); cvset[v] = 1; Logger.log('   "' + v + '"  day1_order=' + _s(r.day1_order)); });

  var tl = _readTab(TABS.tripLevel, 'trip_id').filter(function (r) { return _s(r.contract_id) === _s(contractId); });
  var tv = {};
  tl.forEach(function (t) { var v = _s(t.vehicle_number); tv[v] = (tv[v] || 0) + 1; });
  Logger.log('--- distinct trip vehicles: ' + Object.keys(tv).length + ' ---');
  Object.keys(tv).forEach(function (v) { Logger.log('   "' + v + '"  trips=' + tv[v] + (cvset[v] ? '' : '   <-- NOT a default -> shows as Replacement')); });

  var p = _buildVendorPayload(oracle);
  var vs = (p.vehicles[contractId] || []);
  Logger.log('--- payload vehicle list the panel would render: ' + vs.length + ' ---');
  vs.forEach(function (v) { Logger.log('   ' + v.name + ' | "' + v.no + '" | tag=' + v.tag); });
}
