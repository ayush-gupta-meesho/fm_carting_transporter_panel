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
  accessControl:    'Access_Control'   // 9th tab — the login/scoping table (NEW vs R1)
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
function _fmtRange(a, b) {
  var da = _toDate(a), db = _toDate(b);
  if (!da || !db) return (_s(a) + (_s(b) ? ' – ' + _s(b) : ''));
  return Utilities.formatDate(da, _tz(), 'd MMM') + ' – ' + Utilities.formatDate(db, _tz(), 'd MMM yyyy');
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

function _buildVendorPayload(oracle) {
  oracle = _s(oracle);
  var ci = _readTab(TABS.contractInfo,     'contract_id');
  var cv = _readTab(TABS.contractVehicles, 'contract_id');
  var tl = _readTab(TABS.tripLevel,        'trip_id');

  // ---- scope: this vendor's contracts, and their TRANSFERRED trips only ----
  var myContracts = ci.filter(function (c) { return _s(c.vendor_oracle_id) === oracle; });
  var myContractIds = {};
  myContracts.forEach(function (c) { myContractIds[_s(c.contract_id)] = true; });

  var myTrips = tl.filter(function (t) {
    return _s(t.transporter_oracle_id) === oracle && _yes(t.sent_to_vendor_flag);
  });

  var vehiclesByContract = {}; // contract_id -> [Contract_Vehicles rows]
  cv.forEach(function (v) {
    var cid = _s(v.contract_id);
    if (!myContractIds[cid]) return;
    (vehiclesByContract[cid] = vehiclesByContract[cid] || []).push(v);
  });

  var tripsByContract = {};
  myTrips.forEach(function (t) {
    var cid = _s(t.contract_id);
    (tripsByContract[cid] = tripsByContract[cid] || []).push(t);
  });

  var CONTRACTS = [], VEHICLES = {}, TRIPS = {};
  var vendorName = myContracts.length ? _s(myContracts[0].vendor_name) : '';
  var clusters = {}, mtdKm = 0;

  myContracts.forEach(function (c) {
    var cid = _s(c.contract_id);
    var defaults = (vehiclesByContract[cid] || []).slice();

    // Vx label map: defaults ordered by day1_order (fallback: sheet order)
    defaults.sort(function (a, b) { return _num(a.day1_order) - _num(b.day1_order); });
    var labelOf = {}; // vehicle_number -> "V1"
    defaults.forEach(function (v, i) { labelOf[_s(v.vehicle_number)] = 'V' + (i + 1); });

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

    var mappedTrips = cTrips.map(function (t) {
      var no = _s(t.vehicle_number);
      var billing = _s(t.billing_type_final) || _s(t.billing_type_system) || 'Regular';
      var isAdhoc = _low(billing) === 'adhoc';
      var isRepl  = _yes(t.replacement_flag_system) || _low(t.replacement_flag_system) === 'repl';
      var km      = _num(t.total_trip_km);
      var rto     = _low(t.challan_type) === 'rto' || (!_yes(t.km_accumulated_flag) && km === 0 && !isAdhoc && (_s(t.km_accumulated_flag) !== ''));

      if (!agg[no]) agg[no] = newAgg();
      if (isAdhoc) { agg[no].adhocTrips++; }
      else { agg[no].regTrips++; if (!rto) { agg[no].km += km; contractRegKm += km; } }

      var d = _toDate(t.trip_end_time);
      if (d && (!lastTripDate || d > lastTripDate)) lastTripDate = d;

      var replForNo = _s(t.replaced_default_vehicle_final) || _s(t.replaced_default_vehicle_system);
      var route = _buildRoute(t);

      return {
        id:        _s(t.trip_id),
        size:      _s(t.vehicle_size) || _s(c.vehicle_size),
        veh:       labelOf[no] || no,
        vehNo:     no,
        route:     route,
        billing:   isAdhoc ? 'Adhoc' : 'Regular',
        replTag:   (!isAdhoc && isRepl) ? 'repl' : 'default',
        replFor:   (!isAdhoc && isRepl) ? (labelOf[replForNo] || replForNo) : undefined,
        completed: _fmtShort(t.trip_end_time),
        km:        isAdhoc ? null : (rto ? 0 : km),
        amt:       isAdhoc ? _num(t.adhoc_amount) : null,
        rto:       rto ? true : undefined,
        status:    (function(v){ return v==='confirmed'||v==='reconfirmed' ? 'confirmed' : (v==='disputed' ? 'disputed' : (v==='reconfirm' ? 'reconfirm' : 'pending')); })(_low(t.vendor_status)),
        win:       _low(t.vendor_status) === 'confirmed' ? null : _fmtWin(t.dispute_window_end)
      };
    });

    // vehicle objects
    function vehObj(no, size, tag) {
      var a = agg[no] || newAgg();
      return { name: labelOf[no] || no, no: no, size: size, tag: tag,
               km: a.km, regTrips: a.regTrips, adhocTrips: a.adhocTrips, total: a.regTrips + a.adhocTrips };
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
  });

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
function setupSheet() {
  var ss = _ss();
  var schema = {
    'Contract_Info': ['contract_id','vendor_oracle_id','vendor_name','cluster','vehicle_size','hours_slab','no_of_vehicles','total_km_slab','fixed_monthly_value','ex_km_rate','contract_start_date','contract_end_date','contract_status'],
    'Contract_Vehicles': ['contract_id','vehicle_number','day1_order','pegged_km_slab','monthly_rate','active_days'],
    'Trip_Level': ['row_id','trip_id','transporter_oracle_id','contract_id','vehicle_number','vehicle_size','trip_cluster','trip_date','trip_start_time','trip_end_time','source_node','dest_fmh_nodes','node_count','route_name','challan_type','total_trip_km','km_accumulated_flag','billing_type_system','adhoc_reason_system','replacement_flag_system','replaced_default_vehicle_system','adhoc_amount','ground_confirmed','billing_type_final','replaced_default_vehicle_final','ground_review_deadline','sent_to_vendor_flag','sent_to_vendor_timestamp','vendor_status','dispute_window_end','retention_month','retention_state'],
    'Node_Cluster_Map': ['node_code','cluster','node_type'],
    'Access_Control': ['email','vendor_oracle_id','vendor_name','role','cluster_scope','active'],
    'Disputes_Log': ['dispute_id','row_id','trip_id','contract_id','transporter_oracle_id','vendor_name','raised_at','categories','claim_billing_type','claim_aggregate_vehicle','claim_km','claim_amount','claim_contract_id','vendor_description','proof_url','callback_number','orig_vehicle_number','orig_vehicle_size','orig_trip_cluster','orig_route','orig_completed_time','orig_billing_type','orig_replaced_default_vehicle','orig_total_km','orig_adhoc_amount','dispute_status','resolution_note','resolved_billing_type','resolved_km','resolved_amount','resolved_aggregate_vehicle','resolved_contract_id','resolved_at','resolved_by','reconfirm_status'],
    'Ground_Confirmation_Log': ['log_id','row_id','trip_id','contract_id','transporter_oracle_id','trip_end_time','ground_review_deadline','sent_to_vendor_timestamp','ground_action_state','billing_before','billing_after','replaced_vehicle_before','replaced_vehicle_after','data_sent','partial_edit_flag'],
    'Confirmation_Status_View': ['row_id','trip_id','contract_id','transporter_oracle_id','sent_to_vendor_timestamp','vendor_status','status_updated_at','dispute_id','dispute_status','reconfirm_status','dispute_window_end','final_state']
  };
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
  _writeRows('Trip_Level', [
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
  ]);
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
    .addSeparator()
    .addItem('6 · Turn ON auto-apply (drain + sync, 10 min)', 'createDrainSyncFromMenu')
    .addItem('7 · Stop auto-apply', 'stopSyncFromMenu')
    .addToUi();
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
function _buildAdminPayload() {
  var ci = _readTab(TABS.contractInfo, 'contract_id');
  var cv = _readTab(TABS.contractVehicles, 'contract_id');
  var tl = _readTab(TABS.tripLevel, 'trip_id');

  var slabBy = {};
  cv.forEach(function (v) { var cid = _s(v.contract_id); slabBy[cid] = (slabBy[cid] || 0) + _num(v.pegged_km_slab); });

  var actualBy = {};
  tl.forEach(function (t) {
    var cid = _s(t.contract_id);
    var billing = _low(t.billing_type_final) || _low(t.billing_type_system);
    var rto = _low(t.challan_type) === 'rto';
    if (billing !== 'adhoc' && !rto) actualBy[cid] = (actualBy[cid] || 0) + _num(t.total_trip_km);
  });

  var now = new Date(), out = [], over = 0, under = 0, onTrack = 0, totSlab = 0, totActual = 0;
  ci.forEach(function (c) {
    var cid = _s(c.contract_id);
    var slab = slabBy[cid] || _num(c.total_km_slab) || 0;
    var actual = Math.round(actualBy[cid] || 0);
    var start = _toDate(c.contract_start_date), end = _toDate(c.contract_end_date);
    var totalDays = (start && end) ? Math.max(1, (end - start) / 86400000) : 30;
    var elapsed = start ? Math.min(Math.max((now - start) / 86400000, 0), totalDays) : totalDays;
    var expected = slab * (elapsed / totalDays);
    var projected = elapsed > 0 ? Math.round(actual * (totalDays / elapsed)) : actual;
    var status = projected > slab * 1.02 ? 'OVER' : (projected < slab * 0.90 ? 'UNDER' : 'ON-TRACK');
    if (status === 'OVER') over++; else if (status === 'UNDER') under++; else onTrack++;
    totSlab += slab; totActual += actual;
    out.push({
      contract_id: cid, vendor_oracle_id: _s(c.vendor_oracle_id), vendor_name: _s(c.vendor_name),
      cluster: _s(c.cluster), size: _s(c.vehicle_size), hours: _s(c.hours_slab),
      slab: slab, actual: actual, expected: Math.round(expected), projected: projected,
      utilPct: slab > 0 ? Math.round(actual / slab * 100) : 0,
      projPct: slab > 0 ? Math.round(projected / slab * 100) : 0,
      overRate: _num(c.ex_km_rate), duration: _fmtRange(c.contract_start_date, c.contract_end_date), status: status
    });
  });
  return {
    admin: true,
    generated_at: Utilities.formatDate(now, _tz(), 'd MMM yyyy, HH:mm'),
    summary: { total: out.length, over: over, under: under, onTrack: onTrack, totalSlab: totSlab, totalActual: totActual },
    contracts: out
  };
}
