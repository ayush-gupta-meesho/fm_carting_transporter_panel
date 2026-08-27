/**************************************************************************************************
 * VALMO Transporter Panel — WRITE-BACK drain  (V2, Track 2)
 * ------------------------------------------------------------------------------------------------
 * Add to the SAME Apps Script project as Code.gs + Sync.gs (reuses _up, _ss, _s, _low, _num, TABS).
 *
 * Flow:  Panel (Vercel) --confirm/dispute--> Upstash list "actions"  --drainActions()--> Google Sheet
 *   - confirm : set Trip_Level.vendor_status = Confirmed  + upsert Confirmation_Status_View
 *   - dispute : append Disputes_Log (green + teal snapshot) + set vendor_status = Disputed + status view
 *
 * Safety:
 *   - Ownership: the row's transporter_oracle_id MUST equal the action's oracle (defense in depth;
 *     Vercel already enforced it from the signed session).
 *   - Locking / idempotency: an action is applied only if the trip is still actionable
 *     (Pending/blank). Re-running the drain is a no-op. A processed-set in Upstash dedupes by action_id.
 *   - Window: disputes are rejected after dispute_window_end (server-side gate).
 *
 * Run drainActions() from the "Sync to Upstash NOW" menu path (or its own trigger). It is safe to
 * call before or after syncToUpstash().
 **************************************************************************************************/

var ACTION_QUEUE = 'actions';          // Vercel RPUSHes JSON actions here
var ACTION_DONE  = 'actions_done';     // SET of processed action_ids
var ACTION_DEAD  = 'actions_dead';     // failed actions parked for inspection
var GROUND_WINDOW_HOURS = 24;          // ground review: trip_end_time + this = ground_review_deadline
var DISPUTE_WINDOW_DAYS = 15;          // vendor dispute window opens at transfer, lasts this many days
var LOG_TABS = {
  disputes: 'Disputes_Log',
  ground:   'Ground_Confirmation_Log',
  status:   'Confirmation_Status_View'
};

/* ============================ Upstash list helpers ============================ */
function _lpop(key) { return _up(['LPOP', key]); }
function _saddNew(key, member) { return _up(['SADD', key, member]) === 1; } // true if newly added

/* ============================ sheet context helpers ============================ */
/** Load a tab: locates the header row (scans first 8 rows for keyCol), returns index map + values. */
function _ctx(tabName, keyCol) {
  var sh = _ss().getSheetByName(tabName);
  if (!sh) throw new Error('Missing tab: ' + tabName);
  var values = sh.getDataRange().getValues();
  var hr = -1, headers = null, kc = keyCol.toLowerCase();
  for (var r = 0; r < Math.min(8, values.length); r++) {
    var row = values[r].map(function (c) { return String(c).trim().toLowerCase(); });
    if (row.indexOf(kc) !== -1) { hr = r; headers = values[r].map(function (c) { return String(c).trim(); }); break; }
  }
  if (hr === -1) throw new Error('No header row (missing "' + keyCol + '") in ' + tabName);
  var idx = {}; headers.forEach(function (h, i) { if (h) idx[h] = i; });
  return { sh: sh, values: values, headerRow: hr, headers: headers, idx: idx };
}
function _findRowIndex(ctx, col, val) {
  var ci = ctx.idx[col]; if (ci === undefined) return -1;
  var target = String(val).trim();
  for (var i = ctx.headerRow + 1; i < ctx.values.length; i++) {
    if (String(ctx.values[i][ci]).trim() === target) return i; // 0-based into values
  }
  return -1;
}
function _setCell(ctx, rowIdx0, col, value) {
  var ci = ctx.idx[col]; if (ci === undefined) return;
  ctx.sh.getRange(rowIdx0 + 1, ci + 1).setValue(value);
  ctx.values[rowIdx0][ci] = value; // keep local copy consistent
}
/** Append a row to a tab, placing dict values under matching headers. */
function _appendByHeaders(tabName, keyCol, dict) {
  var ctx = _ctx(tabName, keyCol);
  var row = new Array(ctx.headers.length).fill('');
  Object.keys(dict).forEach(function (k) { if (ctx.idx[k] !== undefined) row[ctx.idx[k]] = dict[k]; });
  ctx.sh.appendRow(row);
}
function _nowIso() { return Utilities.formatDate(new Date(), _tz(), "yyyy-MM-dd'T'HH:mm:ss"); }

/* ============================ main drain ============================ */
function drainActions() {
  var applied = 0, skipped = 0, errors = 0, notes = [];
  for (var i = 0; i < 1000; i++) {                 // hard cap per run
    var raw = _lpop(ACTION_QUEUE);
    if (raw === null || raw === undefined) break;   // queue empty
    var a;
    try { a = JSON.parse(raw); } catch (e) { errors++; _up(['RPUSH', ACTION_DEAD, raw]); continue; }

    // dedupe by action_id (check only; mark done AFTER success so a config error stays retryable)
    if (a.action_id && _up(['SISMEMBER', ACTION_DONE, a.action_id]) === 1) { skipped++; continue; }

    try {
      if (a.type === 'confirm')      applied += applyConfirm(a);
      else if (a.type === 'dispute') applied += applyDispute(a);
      else { skipped++; }
      if (a.action_id) _up(['SADD', ACTION_DONE, a.action_id]);
    } catch (e) {
      errors++; notes.push('ERR ' + (a && a.action_id) + ': ' + e.message);
      _up(['RPUSH', ACTION_DEAD, raw]);
    }
  }
  var msg = 'Actions drained — applied ' + applied + ', skipped ' + skipped + ', errors ' + errors;
  Logger.log(msg); if (notes.length) Logger.log(notes.join('\n'));
  return msg + (notes.length ? ('\n' + notes.join('\n')) : '');
}

/** Menu wrapper: drain + resync so the panel reflects the writes. */
function drainAndSyncFromMenu() {
  var t = transferReadyTrips();
  var d = drainActions();
  var r = applyResolutionsFromSheet();
  var s = (typeof syncToUpstash === 'function') ? syncToUpstash() : '(sync skipped)';
  SpreadsheetApp.getUi().alert(t + '\n' + d + '\n' + r + '\n\n' + s);
}

/* ============================ appliers ============================ */
/** Confirm one or many trips. Returns count actually confirmed. */
function applyConfirm(a) {
  var ids = (a.trip_ids && a.trip_ids.length) ? a.trip_ids : (a.trip_id ? [a.trip_id] : []);
  var ctx = _ctx(TABS.tripLevel, 'trip_id');
  var n = 0;
  ids.forEach(function (tid) {
    var ri = _findRowIndex(ctx, 'trip_id', tid);
    if (ri < 0) return;
    var rv = ctx.values[ri];
    if (_s(rv[ctx.idx['transporter_oracle_id']]) !== _s(a.oracle)) return;        // ownership
    var vs = _low(rv[ctx.idx['vendor_status']]);
    if (vs === 'confirmed' || vs === 'disputed' || vs === 'reconfirmed') return;  // locked
    var isReconf = (vs === 'reconfirm');                                          // accepting a resolved correction
    var newStatus = isReconf ? 'Reconfirmed' : 'Confirmed';
    _upsertStatusView({
      row_id: rv[ctx.idx['row_id']], trip_id: tid, contract_id: _billRef(ctx, ri),
      transporter_oracle_id: a.oracle, route_scope: _s(rv[ctx.idx['route_scope']]) || 'Local',
      sent_to_vendor_timestamp: rv[ctx.idx['sent_to_vendor_timestamp']],
      vendor_status: newStatus, dispute_window_end: rv[ctx.idx['dispute_window_end']],
      reconfirm_status: isReconf ? 'Reconfirmed' : '', final_state: newStatus
    });
    _setCell(ctx, ri, 'vendor_status', newStatus);   // Trip_Level written LAST → if a log write fails, action is retryable
    n++;
  });
  return n;
}

/** Raise a dispute for one trip. Returns 1 if a dispute row was created, else 0. */
/* ===================== THE BILLING REFERENCE OF A ROW =====================
 * A local trip is referenced by contract_id. A zonal trip has no contract_id at all — its rfq_id IS its
 * contract reference (decision 2026-08-07). Every log tab writes this one value into its contract_id
 * column, with route_scope alongside so ops can tell the two apart. One helper, so the three log tabs
 * and both resolution appliers cannot drift.
 */
function _billRef(ctx, ri) {
  var rv = ctx.values[ri];
  var scope = _low(_s(rv[ctx.idx['route_scope']]) || 'Local');
  if (scope === 'zonal') {
    var rfq = _s(rv[ctx.idx['rfq_id']]);
    if (rfq) return rfq;
    // a zonal ADHOC trip bills on its amount and has no RFQ by design — say so, do not flag it
    var bill = _low(_s(rv[ctx.idx['billing_type_system']]));
    return (bill === 'adhoc') ? 'Zonal adhoc' : '(no RFQ id)';
  }
  return _s(rv[ctx.idx['contract_id']]);
}
function _isZonalRow(ctx, ri) {
  return _low(_s(ctx.values[ri][ctx.idx['route_scope']]) || 'Local') === 'zonal';
}

function applyDispute(a) {
  var ctx = _ctx(TABS.tripLevel, 'trip_id');
  var ri = _findRowIndex(ctx, 'trip_id', a.trip_id);
  if (ri < 0) return 0;
  var rv = ctx.values[ri];
  if (_s(rv[ctx.idx['transporter_oracle_id']]) !== _s(a.oracle)) return 0;         // ownership
  var vs = _low(rv[ctx.idx['vendor_status']]);
  if (vs === 'disputed' || vs === 'confirmed' || vs === 'reconfirmed') return 0;   // locked
  var isRedispute = (vs === 'reconfirm');                                          // re-dispute after resolution

  // window gate — only for the ORIGINAL dispute (a re-dispute has no original window)
  if (!isRedispute) {
    var dwe = _toDate(rv[ctx.idx['dispute_window_end']]);
    if (dwe && new Date() > dwe) throw new Error('dispute window closed for ' + a.trip_id);
  }

  var g = function (col) { return _s(rv[ctx.idx[col]]); };
  var disputeId = 'DSP-' + Utilities.formatDate(new Date(), _tz(), 'yyyyMMddHHmmss') + '-' + Math.floor(Math.random() * 9000 + 1000);
  var origRoute = [g('source_node')].concat(g('dest_fmh_nodes') ? g('dest_fmh_nodes').split(/[,>|;/]+/) : [])
                  .map(function (x) { return String(x).trim(); }).filter(String).join(' > ');

  _appendByHeaders(LOG_TABS.disputes, 'dispute_id', {
    // green (panel submit)
    dispute_id: disputeId, row_id: g('row_id'), trip_id: a.trip_id, contract_id: _billRef(ctx, ri),
    transporter_oracle_id: a.oracle, vendor_name: _s(a.vendor_name), raised_at: _nowIso(),
    categories: (a.categories || []).join('|'),
    claim_billing_type: _s(a.claim_billing_type), claim_aggregate_vehicle: _s(a.claim_aggregate_vehicle),
    claim_km: (a.claim_km === '' || a.claim_km == null) ? '' : a.claim_km,
    claim_amount: (a.claim_amount === '' || a.claim_amount == null) ? '' : a.claim_amount,
    claim_zonal_amount: (a.claim_zonal_amount === '' || a.claim_zonal_amount == null) ? '' : a.claim_zonal_amount,
    claim_rfq_id: _s(a.claim_rfq_id),
    /* An RTO trip pays nothing whatever its scope, so claiming a KM or an amount on one is implicitly a
       claim that it was NOT an RTO. challan_type_final is the ONLY lever that clears RTO — without this
       field an upheld amount/KM dispute on an RTO trip is a no-op. */
    claim_challan_type: _s(a.claim_challan_type),
    claim_contract_id: _s(a.claim_contract_id), vendor_description: _s(a.vendor_description),
    proof_url: _s(a.proof_url), callback_number: _s(a.callback_number),
    // teal (original snapshot from Trip_Level at submit)
    orig_vehicle_number: g('vehicle_number'), orig_vehicle_size: g('vehicle_size'),
    orig_trip_cluster: g('trip_cluster'), orig_route: origRoute,
    // scope/RFQ/amount snapshots — without these the dispute card cannot show "was X, you claim Y"
    orig_route_scope: g('route_scope') || 'Local', orig_rfq_id: g('rfq_id'),
    orig_completed_time: g('trip_end_time'),
    orig_billing_type: _s(rv[ctx.idx['billing_type_final']]) || _s(rv[ctx.idx['billing_type_system']]),
    orig_replaced_default_vehicle: _s(rv[ctx.idx['replaced_default_vehicle_final']]) || _s(rv[ctx.idx['replaced_default_vehicle_system']]),
    orig_total_km: g('total_trip_km'), orig_adhoc_amount: g('adhoc_amount'),
    orig_challan_type: _s(rv[ctx.idx['challan_type_final']]) || g('challan_type'),
    orig_zonal_rfq_amount: _s(rv[ctx.idx['zonal_rfq_amount_final']]) || _s(rv[ctx.idx['zonal_rfq_amount']]),
    // red block left blank; initial open status
    dispute_status: 'Open', reconfirm_status: isRedispute ? 'Re-disputed' : ''
  });

  _upsertStatusView({
    row_id: g('row_id'), trip_id: a.trip_id, contract_id: _billRef(ctx, ri), transporter_oracle_id: a.oracle,
    route_scope: g('route_scope') || 'Local',
    sent_to_vendor_timestamp: g('sent_to_vendor_timestamp'), vendor_status: 'Disputed',
    dispute_id: disputeId, dispute_status: 'Open', dispute_window_end: g('dispute_window_end'),
    final_state: 'Disputed'
  });
  _setCell(ctx, ri, 'vendor_status', 'Disputed');   // Trip_Level written LAST
  return 1;
}

/* ============================ Confirmation_Status_View upsert ============================ */
function _upsertStatusView(o) {
  var ctx = _ctx(LOG_TABS.status, 'trip_id');
  var ri = _findRowIndex(ctx, 'trip_id', o.trip_id);
  o.status_updated_at = _nowIso();
  if (ri < 0) {
    _appendByHeaders(LOG_TABS.status, 'trip_id', o);
  } else {
    Object.keys(o).forEach(function (k) { if (ctx.idx[k] !== undefined) _setCell(ctx, ri, k, o[k]); });
  }
}

/* ============================ transfer step (writes Ground_Confirmation_Log) ============================ *
 * Optional: if the data engine already flips sent_to_vendor_flag and writes Ground_Confirmation_Log,
 * leave this unused. Otherwise call transferReadyTrips() to transfer trips past their review deadline:
 * stamps sent_to_vendor_flag/timestamp and appends a Ground_Confirmation_Log row.
 * ============================================================================================ */
function transferReadyTrips() {
  var ctx = _ctx(TABS.tripLevel, 'trip_id');
  var now = new Date(), moved = 0;
  var _cv = _readTab('Contract_Vehicles', 'contract_id');
  var defBy = {};   // contract_id -> { vehicle_number: true }  (default / contracted vehicles)
  _cv.forEach(function (v) { var cd = _s(v.contract_id); (defBy[cd] = defBy[cd] || {})[_s(v.vehicle_number)] = true; });
  var vehHome = {};   // vehicle_number -> a REAL contract where it is a default (misattribution hint)
  _cv.forEach(function (v) { var no = _s(v.vehicle_number); if (no && !vehHome[no]) vehHome[no] = _s(v.contract_id); });
  var iso = function (d) { return Utilities.formatDate(d, _tz(), "yyyy-MM-dd'T'HH:mm:ss"); };
  for (var i = ctx.headerRow + 1; i < ctx.values.length; i++) {
    var rv = ctx.values[i];
    if (!_s(rv[ctx.idx['trip_id']])) continue;
    if (_yes(rv[ctx.idx['sent_to_vendor_flag']])) continue;          // already transferred

    // ground_review_deadline = trip_end_time + GROUND_WINDOW_HOURS (derive + persist if engine didn't set it)
    var dl = _toDate(rv[ctx.idx['ground_review_deadline']]);
    if (!dl) {
      var te = _toDate(rv[ctx.idx['trip_end_time']]);
      if (!te) continue;                                             // no completion time yet
      dl = new Date(te.getTime() + GROUND_WINDOW_HOURS * 3600000);
      _setCell(ctx, i, 'ground_review_deadline', iso(dl));
    }
    if (now < dl) continue;                                          // still inside the ground window

    var ts = iso(now);
    var notes_resolvedStray = false;
    var groundConfirmed = _yes(rv[ctx.idx['ground_confirmed']]);

    // GUARD: a Regular classification on a NON-default vehicle needs a valid replaced-default mapping,
    // else its KM cannot fold into any default. If incomplete, discard the ground edit and transfer the
    // earlier (system) info instead; the trip still transfers but the ground log is marked partial.
    var _cid = _s(rv[ctx.idx['contract_id']]), _vno = _s(rv[ctx.idx['vehicle_number']]);
    var _scope  = _s(rv[ctx.idx['route_scope']]) || 'Local';
    var _isZonal = _low(_scope) === 'zonal';
    var _finalBill = _low(rv[ctx.idx['billing_type_final']]) || _low(rv[ctx.idx['billing_type_system']]);
    var _isDefault = !!(defBy[_cid] && defBy[_cid][_vno]);
    var _replTarget = _s(rv[ctx.idx['replaced_default_vehicle_final']]) || _s(rv[ctx.idx['replaced_default_vehicle_system']]);
    var _replOK = !!(_replTarget && defBy[_cid] && defBy[_cid][_replTarget]);

    /* ZONAL GUARD — must run BEFORE the reclassification guard.
     * Zonal vehicles are not contract defaults by design, so the reclassification guard below would
     * bounce every single zonal trip to Adhoc and stamp it NEEDS_ATTRIBUTION_FIX. Zonal is therefore
     * exempt from it. Separately, route_scope and billing on zonal are SYSTEM outcomes: any ground
     * edit to billing_type_final or replaced_default_vehicle_final is cleared and flagged, so
     * "zonal adhoc cannot be reverted to Regular" holds in the sheet as well as in the classifier. */
    /* billing_type_resolved is written ONLY by the resolution appliers, and a resolution cannot exist
       before a dispute, which cannot exist before the trip is transferred. So a value on a row that has
       never been sent to a vendor was typed by hand — clear it, on BOTH scopes, rather than let a
       hand-typed cell outrank the engine. */
    if (_s(rv[ctx.idx['billing_type_resolved']])) {
      _setCell(ctx, i, 'billing_type_resolved', '');
      notes_resolvedStray = true;
    }
    var _zonalEdit = false;
    if (_isZonal) {
      if (_s(rv[ctx.idx['billing_type_final']])) { _setCell(ctx, i, 'billing_type_final', ''); _zonalEdit = true; }
      if (_s(rv[ctx.idx['replaced_default_vehicle_final']])) { _setCell(ctx, i, 'replaced_default_vehicle_final', ''); _zonalEdit = true; }
    }
    var _partial = (!_isZonal && _finalBill === 'regular' && !_isDefault && !_replOK);
    if (_partial) {
      if (_s(rv[ctx.idx['billing_type_final']])) _setCell(ctx, i, 'billing_type_final', '');
      if (_s(rv[ctx.idx['replaced_default_vehicle_final']])) _setCell(ctx, i, 'replaced_default_vehicle_final', '');
    }

    // Attribution flag: Regular set on an ADHOC-bucket trip, or on a trip whose vehicle is actually a
    // default of a DIFFERENT real contract -> the fix is to correct contract_id, not the billing type.
    var _isAdhocBucket = _cid.toUpperCase().indexOf('ADHOC') === 0;
    var _home = vehHome[_vno] || '';
    var _flagAttr = _partial && (_isAdhocBucket || (_home && _home !== _cid));
    var _actionState = _zonalEdit ? 'ZONAL_NOT_EDITABLE'
      : (_flagAttr ? 'NEEDS_ATTRIBUTION_FIX' : (groundConfirmed ? 'GROUND_CONFIRMED' : 'NO_GROUND_ACTION'));
    var _dataSent = _zonalEdit
      ? ('ZONAL_NOT_EDITABLE: route_scope=Zonal on RFQ ' + (_s(rv[ctx.idx['rfq_id']]) || '(no RFQ id)') + ' \u2014 a zonal trip has no contract_id; billing type and replacement vehicle are system outcomes on zonal and were cleared. Fix the classification in the data engine, not in the sheet.')
      : (_flagAttr
        ? ('ATTRIBUTION_FIX: Regular set on ' + _cid + (_home ? (' \u2014 vehicle ' + _vno + ' is a default of ' + _home + '; set contract_id to it') : ' \u2014 vehicle is not a default of any contract'))
        : (_partial ? 'SYSTEM_ORIGINAL (incomplete reclassification)' : (groundConfirmed ? 'GROUND_FINAL' : 'SYSTEM_ORIGINAL')));

    // Ground_Confirmation_Log FIRST → a log failure leaves the trip un-transferred / retryable
    _appendByHeaders(LOG_TABS.ground, 'log_id', {
      log_id: 'GCL-' + Utilities.formatDate(now, _tz(), 'yyyyMMddHHmmss') + '-' + i,
      row_id: _s(rv[ctx.idx['row_id']]), trip_id: _s(rv[ctx.idx['trip_id']]),
      contract_id: _billRef(ctx, i), transporter_oracle_id: _s(rv[ctx.idx['transporter_oracle_id']]),
      route_scope: _scope,
      trip_end_time: _s(rv[ctx.idx['trip_end_time']]), ground_review_deadline: iso(dl),
      sent_to_vendor_timestamp: ts,
      ground_action_state: _actionState,
      billing_before: _s(rv[ctx.idx['billing_type_system']]), billing_after: _s(rv[ctx.idx['billing_type_final']]) || _s(rv[ctx.idx['billing_type_system']]),
      replaced_vehicle_before: _s(rv[ctx.idx['replaced_default_vehicle_system']]),
      replaced_vehicle_after: _s(rv[ctx.idx['replaced_default_vehicle_final']]) || _s(rv[ctx.idx['replaced_default_vehicle_system']]),
      data_sent: _dataSent + (notes_resolvedStray
        ? ' | CLEARED a hand-typed billing_type_resolved: that column belongs to dispute resolution only.'
        : ''),
      partial_edit_flag: (_partial || _zonalEdit || notes_resolvedStray) ? 'Yes' : 'No'
    });

    // open the vendor dispute window (if not already set) + default status
    if (!_toDate(rv[ctx.idx['dispute_window_end']])) {
      _setCell(ctx, i, 'dispute_window_end', iso(new Date(now.getTime() + DISPUTE_WINDOW_DAYS * 86400000)));
    }
    if (!_s(rv[ctx.idx['vendor_status']])) _setCell(ctx, i, 'vendor_status', 'Pending');
    _setCell(ctx, i, 'sent_to_vendor_timestamp', ts);
    _setCell(ctx, i, 'sent_to_vendor_flag', 'Yes');                 // flag LAST → marks the trip transferred
    moved++;
  }
  return 'Transferred ' + moved + ' trip(s) to vendor.';
}


/* ==================================================================================================
 * ADMIN — Import resolved-disputes CSV (C5) → fills Disputes_Log red block, overwrites Trip_Level,
 * sets the trip to "Reconfirm" (Pending Reconfirmation) so it re-surfaces to the vendor (C6).
 * CSV columns (header row, dispute_id required): dispute_id, row_id, resolution_note,
 *   resolved_billing_type, resolved_km, resolved_amount, resolved_aggregate_vehicle,
 *   resolved_contract_id, resolved_by
 * Blank resolved_* cells leave the original Trip_Level value intact (§G16). Needs Drive scope.
 * ============================================================================================ */
function importResolvedDisputes() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Import resolved disputes',
    'Paste the Google Drive file ID or URL of the resolved-disputes CSV:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var idOrUrl = resp.getResponseText().trim();
  var m = idOrUrl.match(/[-\w]{25,}/);
  var fileId = m ? m[0] : idOrUrl;
  try {
    var csv = DriveApp.getFileById(fileId).getBlob().getDataAsString();
    var rows = Utilities.parseCsv(csv);
    ui.alert(_applyResolvedRows(rows));
  } catch (e) {
    ui.alert('Import failed: ' + e.message);
  }
}

function _applyResolvedRows(rows) {
  if (!rows || rows.length < 2) return 'CSV had no data rows.';
  var head = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var col = {}; head.forEach(function (h, i) { col[h] = i; });
  if (col['dispute_id'] === undefined) return 'CSV must have a dispute_id column.';

  var dl = _ctx(LOG_TABS.disputes, 'dispute_id');
  var tl = _ctx(TABS.tripLevel, 'trip_id');
  var applied = 0, missing = 0, notes = [];
  var now = _nowIso();
  var get = function (r, name) { return col[name] !== undefined ? String(r[col[name]]).trim() : ''; };

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var did = get(r, 'dispute_id'); if (!did) continue;
    var dr = _findRowIndex(dl, 'dispute_id', did);
    if (dr < 0) { missing++; notes.push('no dispute ' + did); continue; }
    var tripId = _s(dl.values[dr][dl.idx['trip_id']]);

    // fill Disputes_Log RED block
    var setDL = function (c, v) { if (dl.idx[c] !== undefined && v !== '') _setCell(dl, dr, c, v); };
    setDL('resolution_note', get(r, 'resolution_note'));
    setDL('resolved_billing_type', get(r, 'resolved_billing_type'));
    setDL('resolved_km', get(r, 'resolved_km'));
    setDL('resolved_amount', get(r, 'resolved_amount'));
    setDL('resolved_zonal_amount', get(r, 'resolved_zonal_amount'));
    setDL('resolved_rfq_id', get(r, 'resolved_rfq_id'));
    setDL('resolved_aggregate_vehicle', get(r, 'resolved_aggregate_vehicle'));
    setDL('resolved_contract_id', get(r, 'resolved_contract_id'));
    _setCell(dl, dr, 'resolved_at', now);
    setDL('resolved_by', get(r, 'resolved_by'));
    _setCell(dl, dr, 'dispute_status', 'Resolved');
    _setCell(dl, dr, 'reconfirm_status', 'Pending Reconfirmation');

    // overwrite Trip_Level in place (only where a resolved value is present)
    var tr = _findRowIndex(tl, 'trip_id', tripId);
    if (tr >= 0) {
      var ow = function (tlCol, v) { if (v !== '') _setCell(tl, tr, tlCol, v); };
      /* A resolution is the ONLY path allowed to change a zonal amount, and it must not become a back
       * door into the rules the ZONAL_NOT_EDITABLE guard closes. On a zonal trip, billing type, KM and
       * replacement vehicle are system outcomes (no slab, no vehicle mapping), so those three are
       * ignored here however the resolution CSV is filled in. */
      var _rz = _low(_s(tl.values[tr][tl.idx['route_scope']]) || 'Local') === 'zonal';
      /* The challan applies to BOTH scopes — an RTO marking is a fact about the trip, not a routing
         classification the engine owns. This is what un-RTOs a trip so its KM or amount comes back. */
      ow('challan_type_final', get(r, 'resolved_challan_type'));
      if (_rz) {
        ow('zonal_rfq_amount_final', get(r, 'resolved_zonal_amount'));
        /* An upheld billing-type dispute on zonal DOES flip the trip (decision 2026-08-07). A zonal
           Adhoc trip bills adhoc_amount, so refuse a flip that would silently zero the trip. */
        var _nb = _low(get(r, 'resolved_billing_type'));
        if (_nb === 'adhoc' && !_num(get(r, 'resolved_amount')) && !_num(tl.values[tr][tl.idx['adhoc_amount']])) {
          notes.push('ZONAL ' + tripId + ': REFUSED flip to Adhoc \u2014 adhoc_amount is blank and no resolved_amount given; the trip would pay 0. Fill resolved_amount and re-run.');
        } else {
            // billing_type_RESOLVED, not _final: ground owns _final and must never be able to fake this
          ow('billing_type_resolved', get(r, 'resolved_billing_type'));
          ow('adhoc_amount_resolved', get(r, 'resolved_amount'));
        }
        if (get(r, 'resolved_km') || get(r, 'resolved_aggregate_vehicle')) {
          notes.push('ZONAL ' + tripId + ': ignored resolved_km / resolved_aggregate_vehicle (no KM slab and no vehicle level on zonal)');
        }
      } else {
        // same column on local as on zonal: resolution > ground > system, one destination
        ow('billing_type_resolved', get(r, 'resolved_billing_type'));
        /* total_trip_km_RESOLVED, not total_trip_km. Writing into the system column destroyed the
           original, left no audit trail, and made the correction vulnerable to any re-push of
           Trip_Level. _classifyTrip reads resolved-then-system. (2026-08-27) */
        ow('total_trip_km_resolved', get(r, 'resolved_km'));
        ow('adhoc_amount_resolved', get(r, 'resolved_amount'));
        ow('replaced_default_vehicle_final', get(r, 'resolved_aggregate_vehicle'));
      }
      // the billing reference: contract_id on local, rfq_id on zonal (a zonal row has no contract_id)
      if (_rz) ow('rfq_id', get(r, 'resolved_rfq_id'));
      else        ow('contract_id', get(r, 'resolved_contract_id'));
      _setCell(tl, tr, 'vendor_status', 'Reconfirm');   // re-surface to vendor
      _upsertStatusView({
        row_id: _s(tl.values[tr][tl.idx['row_id']]), trip_id: tripId,
        contract_id: _billRef(tl, tr),
        transporter_oracle_id: _s(tl.values[tr][tl.idx['transporter_oracle_id']]),
        route_scope: _s(tl.values[tr][tl.idx['route_scope']]) || 'Local',
        vendor_status: 'Reconfirm', dispute_id: did, dispute_status: 'Resolved',
        reconfirm_status: 'Pending Reconfirmation', final_state: 'Pending Reconfirmation'
      });
    }
    applied++;
  }
  return 'Resolved-disputes import: applied ' + applied + ', unmatched ' + missing +
         (notes.length ? ('\n' + notes.join('\n')) : '');
}


/* Every column ops can put a correction in. Used to decide whether a Resolved row actually carries a
 * resolution, and by repairMissedResolutions(). One list, so the two cannot drift. */
/* Is a resolved value already sitting in its destination cell?
 *
 * The numeric leg is deliberately strict. A first cut compared _num(cur) === _num(v) whenever both
 * sides merely CONTAINED a digit, and _num() strips non-numerics — so "RJK7-X" and "RJK10-Y" both
 * reduced to 0 and a contract_id correction was silently treated as already applied. Only compare as
 * numbers when both sides ARE numbers; everything else is an exact string match. The point of the
 * numeric leg at all is that a sheet cell holding 180 and a CSV string "180" are the same value, and
 * "180.0" vs 180 must not cause an endless rewrite. */
var _NUMERIC_RE = /^-?\d+(\.\d+)?$/;
function _sameCell(cur, v) {
  cur = _s(cur); v = _s(v);
  if (cur === v) return true;
  if (cur === '' || v === '') return false;
  if (_NUMERIC_RE.test(cur.replace(/,/g, '')) && _NUMERIC_RE.test(v.replace(/,/g, ''))) {
    return Number(cur.replace(/,/g, '')) === Number(v.replace(/,/g, ''));
  }
  return false;
}

var _RESOLVED_COLS = ['resolved_billing_type', 'resolved_km', 'resolved_amount', 'resolved_zonal_amount',
  'resolved_rfq_id', 'resolved_challan_type', 'resolved_aggregate_vehicle', 'resolved_contract_id'];

/* ==================================================================================================
 * IN-SHEET resolution (no CSV) — the resolution team edits Disputes_Log directly.
 * TRIGGER : set  dispute_status = "Resolved"  on the dispute row (after filling the resolved_* cells).
 * GUARD   : resolved_at is the "already applied" marker. A row is applied once, then skipped forever
 *           (idempotent), so this is safe to run on a timer as often as you like.
 * ACTION  : overwrite Trip_Level (only where a resolved_* value is present), set the trip to
 *           Reconfirm, stamp resolved_at + reconfirm_status = Pending Reconfirmation, update the view.
 * Fill any subset of: resolved_billing_type, resolved_km, resolved_amount,
 *   resolved_aggregate_vehicle, resolved_contract_id, resolution_note, resolved_by. Blank = unchanged.
 * ================================================================================================== */
function applyResolutionsFromSheet() {
  var dl = _ctx(LOG_TABS.disputes, 'dispute_id');
  var tl = _ctx(TABS.tripLevel, 'trip_id');
  var applied = 0, reconciled = 0, firstPassWrites = 0, notes = [], now = _nowIso();
  var val = function (row, c) { return dl.idx[c] !== undefined ? _s(dl.values[row][dl.idx[c]]) : ''; };

  for (var i = dl.headerRow + 1; i < dl.values.length; i++) {
    var did = val(i, 'dispute_id'); if (!did) continue;
    if (val(i, 'dispute_status').toLowerCase() !== 'resolved') continue;   // TRIGGER: human set Resolved

    /* resolved_at NO LONGER SKIPS THE ROW.  (2026-08-27 — this is the fix for 166 lost resolutions.)
     *
     * It used to: `if (val(i,'resolved_at')) continue;`. resolved_at was stamped at the top of this
     * loop, unconditionally, before any resolved_* value was read. So the ordinary ops sequence —
     * mark the dispute Resolved, then type the resolved_km — meant the applier fired on the still-empty
     * row, stamped the guard, flipped the trip to Reconfirm, wrote nothing, and locked the row out of
     * this function forever. The number then lived in Disputes_Log only: the panel's View-Dispute
     * dialog read it, the trip row and the billing MIS never did. Silent, and worth 1,974 km on the
     * live sheet.
     *
     * Now resolved_at gates only the ONE-TIME side effects — flipping the trip to Reconfirm and
     * upserting Confirmation_Status_View — because those notify the vendor and must happen exactly
     * once. The VALUE writes below run every pass and are idempotent: each resolved_* cell is compared
     * to its Trip_Level destination and written only if it differs. That makes the function
     * self-healing (a value filled in later still lands) while never reopening a trip the vendor has
     * already accepted. */
    var alreadyApplied = val(i, 'resolved_at') !== '';

    var tripId = val(i, 'trip_id');

    /* A Resolved row with nothing on it at all is almost always a half-finished edit — ops set the
       status, then went to type the number. It is NOT skipped (a deliberate "reviewed, no change"
       rejection is a real outcome and the vendor is owed the answer), but it IS called out, because
       the number typed a minute later used to be lost forever. See the note on _RESOLVED_COLS. */
    var _hasVal = _RESOLVED_COLS.some(function (c) { return val(i, c) !== ''; });
    if (!_hasVal && val(i, 'resolution_note') === '') {
      notes.push('EMPTY ' + did + ' (' + tripId + '): dispute_status is Resolved but every resolved_* '
        + 'cell AND resolution_note are blank. The trip will re-surface to the vendor with no '
        + 'correction on it. Fill a resolved_* value \u2014 it will still apply on a later run.');
    }

    if (!alreadyApplied) {
      _setCell(dl, i, 'resolved_at', now);                                 // stamp: the vendor has been told
      if (!val(i, 'reconfirm_status')) _setCell(dl, i, 'reconfirm_status', 'Pending Reconfirmation');
    }

    /* trip_id first, then row_id. The fallback is not hypothetical: one live dispute row carries the
       row_id (with its _R suffix) in the trip_id column and matches no Trip_Level trip_id at all. */
    var tr = _findRowIndex(tl, 'trip_id', tripId);
    if (tr < 0) tr = _findRowIndex(tl, 'row_id', val(i, 'row_id') || tripId);
    if (tr < 0) {
      notes.push('NO TRIP ROW for ' + did + ' \u2014 trip_id "' + tripId + '", row_id "'
        + val(i, 'row_id') + '" match no Trip_Level row. The resolution cannot be applied.');
      if (!alreadyApplied) applied++;
      continue;
    }
    /* ow() writes only when the destination actually differs, so re-running this function is free and
       every pass reconciles. `changed` is what makes a reconcile pass reportable instead of silent. */
    var changed = [];
    var ow = function (tlCol, v) {
      if (v === '' || tl.idx[tlCol] === undefined) return;
      var cur = _s(tl.values[tr][tl.idx[tlCol]]);
      if (_sameCell(cur, v)) return;
      changed.push(tlCol + ': ' + (cur === '' ? '<blank>' : cur) + ' \u2192 ' + v);
      _setCell(tl, tr, tlCol, v);
    };
    // same zonal gate as the CSV importer — see the comment there
    var _rz2 = _low(_s(tl.values[tr][tl.idx['route_scope']]) || 'Local') === 'zonal';
    // same rules as the CSV importer above — see the comments there
    ow('challan_type_final', val(i, 'resolved_challan_type'));
    if (_rz2) {
      ow('zonal_rfq_amount_final', val(i, 'resolved_zonal_amount'));
      var _nb2 = _low(val(i, 'resolved_billing_type'));
      if (_nb2 === 'adhoc' && !_num(val(i, 'resolved_amount')) && !_num(tl.values[tr][tl.idx['adhoc_amount']])) {
        notes.push('ZONAL ' + tripId + ': REFUSED flip to Adhoc \u2014 adhoc_amount is blank and no resolved_amount given; the trip would pay 0. Fill resolved_amount and re-run.');
      } else {
        // billing_type_RESOLVED, not _final — see the CSV importer
        ow('billing_type_resolved', val(i, 'resolved_billing_type'));
        ow('adhoc_amount_resolved', val(i, 'resolved_amount'));
      }
      if (val(i, 'resolved_km') || val(i, 'resolved_aggregate_vehicle')) {
        notes.push('ZONAL ' + tripId + ': ignored resolved_km / resolved_aggregate_vehicle (no KM slab and no vehicle level on zonal)');
      }
    } else {
      // same column on local as on zonal — see the CSV importer
      ow('billing_type_resolved', val(i, 'resolved_billing_type'));
      ow('total_trip_km_resolved', val(i, 'resolved_km'));      // NOT total_trip_km — see the importer
      ow('adhoc_amount_resolved', val(i, 'resolved_amount'));
      ow('replaced_default_vehicle_final', val(i, 'resolved_aggregate_vehicle'));
    }
    // the billing reference: contract_id on local, rfq_id on zonal (a zonal row has no contract_id)
    if (_rz2) ow('rfq_id', val(i, 'resolved_rfq_id'));
    else        ow('contract_id', val(i, 'resolved_contract_id'));

    /* THE ONE-TIME SIDE EFFECTS — gated on resolved_at, never repeated.
       Re-surfacing a trip to the vendor is a notification, so it happens exactly once. On a reconcile
       pass the trip keeps whatever status it has: a vendor who already accepted the correction stays
       Reconfirmed and is not asked again. */
    if (!alreadyApplied) {
      _setCell(tl, tr, 'vendor_status', 'Reconfirm');                      // re-surface to vendor
      _upsertStatusView({
        row_id: _s(tl.values[tr][tl.idx['row_id']]), trip_id: tripId,
        contract_id: _billRef(tl, tr),
        transporter_oracle_id: _s(tl.values[tr][tl.idx['transporter_oracle_id']]),
        route_scope: _s(tl.values[tr][tl.idx['route_scope']]) || 'Local',
        vendor_status: 'Reconfirm', dispute_id: did, dispute_status: 'Resolved',
        reconfirm_status: 'Pending Reconfirmation', final_state: 'Pending Reconfirmation'
      });
      applied++;
      if (changed.length) firstPassWrites += changed.length;
    } else if (changed.length) {
      /* A late-filled resolution landing on an already-notified row. Under the old code this was the
         silent data loss; now it is a reported repair. */
      reconciled++;
      notes.push('RECONCILED ' + did + ' (' + tripId + ', vendor_status '
        + _s(tl.values[tr][tl.idx['vendor_status']]) + '): ' + changed.join(' | '));
    }
  }
  var msg = 'In-sheet resolutions applied: ' + applied
    + (reconciled ? ('\nLate-filled resolutions reconciled onto already-notified trips: ' + reconciled) : '');
  Logger.log(msg); if (notes.length) Logger.log(notes.join('\n'));
  return msg + (notes.length ? ('\n' + notes.join('\n')) : '');
}


/* ============================ GO-LIVE: automatic apply ============================ *
 * During testing you click "6 · Apply vendor actions". At go-live, turn on a time-driven
 * trigger so the drain + sync run on a schedule (no clicks). A vendor's confirm/dispute then
 * lands in the Sheet and refreshes the panel within the interval (default 10 min).
 * ================================================================================ */
function scheduledDrainSync() {
  try { transferReadyTrips(); } catch (e) { Logger.log('transfer error: ' + e.message); }
  try { drainActions(); } catch (e) { Logger.log('drain error: ' + e.message); }
  try { applyResolutionsFromSheet(); } catch (e) { Logger.log('resolution error: ' + e.message); }
  try { if (typeof syncToUpstash === 'function') syncToUpstash(); } catch (e) { Logger.log('sync error: ' + e.message); }
}

/** Turn ON auto-apply: time trigger running scheduledDrainSync every 10 min (replaces any sync-only trigger). */
function createDrainSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'scheduledDrainSync' || h === 'syncToUpstash') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scheduledDrainSync').timeBased().everyMinutes(10).create();
  scheduledDrainSync();
  return 'Auto-apply is ON — vendor actions drain + sync automatically every 10 min. Use "Stop auto-apply" to turn off.';
}
function createDrainSyncFromMenu() { SpreadsheetApp.getUi().alert(createDrainSyncTrigger()); }


/* ==================================================================================================
 * REPAIR — re-apply resolutions that were stamped but never written  (added 2026-08-27)
 *
 * WHY THIS EXISTS.  applyResolutionsFromSheet() stamps resolved_at as its permanent "already applied"
 * guard, and it used to stamp it BEFORE looking at whether any resolved_* value was present. Ops
 * naturally marks a dispute Resolved first and types the number second, so the applier fired on the
 * empty row, stamped the guard, flipped the trip to Reconfirm, wrote nothing, and locked the row out
 * forever. The number then sat in Disputes_Log, visible in the panel's View-Dispute dialog and
 * nowhere else. On the live sheet that was 166 Krushiv Enterprise rows / 1,974.216 km.
 *
 * The guard is now conditional, so this cannot recur. This function cleans up what it already cost.
 *
 * WHAT IT DOES.  For every Disputes_Log row that is Resolved and carries at least one resolved_*
 * value, it writes that value into its destination column on Trip_Level if the destination does not
 * already hold it. Idempotency is by COMPARING VALUES, not by a timestamp — so it is safe to run
 * repeatedly and it deliberately ignores resolved_at, which is the very thing that blocked the
 * original write.
 *
 * WHAT IT DOES NOT DO.  It never touches vendor_status. A trip the vendor already accepted stays
 * Reconfirmed — the vendor accepted this correction, so applying its number is the fix, not a reason
 * to reopen the trip. It never writes a system column (total_trip_km, adhoc_amount) and never
 * resurfaces a trip to the vendor.
 *
 * JOIN.  trip_id first, then row_id. The fallback is not theoretical: one live dispute row carries the
 * row_id (with its _R suffix) in the trip_id column, so it matches no Trip_Level trip_id at all.
 *
 * USAGE.  repairMissedResolutions()      -> DRY RUN, reports what it would change, writes nothing.
 *         repairMissedResolutions(true)  -> applies.
 * The menu item runs the dry run and then asks before applying.
 * ============================================================================================== */
function repairMissedResolutions(apply) {
  var dl = _ctx(LOG_TABS.disputes, 'dispute_id');
  var tl = _ctx(TABS.tripLevel, 'trip_id');
  var val = function (row, c) { return dl.idx[c] !== undefined ? _s(dl.values[row][dl.idx[c]]) : ''; };
  var tval = function (row, c) { return tl.idx[c] !== undefined ? _s(tl.values[row][tl.idx[c]]) : ''; };

  /* resolved_* source column -> Trip_Level destination, LOCAL rows.
     Deliberately mirrors applyResolutionsFromSheet — if that mapping changes, change it here too. */
  var MAP_LOCAL = {
    resolved_km:                'total_trip_km_resolved',
    resolved_amount:            'adhoc_amount_resolved',
    resolved_billing_type:      'billing_type_resolved',
    resolved_challan_type:      'challan_type_final',
    resolved_aggregate_vehicle: 'replaced_default_vehicle_final',
    resolved_contract_id:       'contract_id'
  };
  /* Zonal: no KM slab and no vehicle level, so resolved_km / resolved_aggregate_vehicle are ignored
     exactly as the appliers ignore them. Same rule, restated rather than shared, so a future change
     to one scope cannot silently move the other. */
  var MAP_ZONAL = {
    resolved_amount:        'adhoc_amount_resolved',
    resolved_zonal_amount:  'zonal_rfq_amount_final',
    resolved_billing_type:  'billing_type_resolved',
    resolved_challan_type:  'challan_type_final',
    resolved_rfq_id:        'rfq_id'
  };

  var scanned = 0, repaired = 0, alreadyOk = 0, noTripRow = 0, noValues = 0, missingCol = {};
  var writes = 0, lines = [], kmDelta = 0, byOracle = {};

  for (var i = dl.headerRow + 1; i < dl.values.length; i++) {
    var did = val(i, 'dispute_id'); if (!did) continue;
    if (_low(val(i, 'dispute_status')) !== 'resolved') continue;
    scanned++;

    var tripId = val(i, 'trip_id'), rowId = val(i, 'row_id');
    var tr = _findRowIndex(tl, 'trip_id', tripId);
    var via = 'trip_id';
    if (tr < 0 && rowId) { tr = _findRowIndex(tl, 'row_id', rowId); via = 'row_id'; }
    if (tr < 0 && tripId) { tr = _findRowIndex(tl, 'row_id', tripId); via = 'row_id(from trip_id)'; }
    if (tr < 0) {
      noTripRow++;
      lines.push('NO TRIP ROW  ' + did + '  trip_id=' + tripId + '  row_id=' + rowId);
      continue;
    }

    var isZonal = _low(tval(tr, 'route_scope') || 'Local') === 'zonal';
    var map = isZonal ? MAP_ZONAL : MAP_LOCAL;
    var changed = [], had = 0;

    Object.keys(map).forEach(function (src) {
      var v = val(i, src); if (v === '') return;
      had++;
      var dest = map[src];
      if (tl.idx[dest] === undefined) { missingCol[dest] = (missingCol[dest] || 0) + 1; return; }
      var cur = tval(tr, dest);
      if (_sameCell(cur, v)) return;      // same strict rule as the applier — see _sameCell
      if (src === 'resolved_km') {
        kmDelta += (_num(v) - _num(tval(tr, 'total_trip_km')));
        var orc = tval(tr, 'transporter_oracle_id');
        byOracle[orc] = (byOracle[orc] || 0) + 1;
      }
      changed.push(dest + ': ' + (cur === '' ? '<blank>' : cur) + ' -> ' + v);
      if (apply) { _setCell(tl, tr, dest, v); writes++; }
    });

    if (!had) { noValues++; continue; }
    if (!changed.length) { alreadyOk++; continue; }
    repaired++;
    lines.push((apply ? 'FIXED  ' : 'WOULD FIX  ') + did + '  (' + (isZonal ? 'zonal' : 'local')
      + ', matched on ' + via + ', trip ' + tval(tr, 'trip_id') + ', vendor_status '
      + tval(tr, 'vendor_status') + ')  ' + changed.join(' | '));
  }

  var head = (apply ? 'REPAIR APPLIED' : 'REPAIR DRY RUN — nothing written')
    + '\n  Resolved disputes scanned : ' + scanned
    + '\n  ' + (apply ? 'Rows repaired           : ' : 'Rows that would change  : ') + repaired
    + '\n  Cells written           : ' + writes
    + '\n  Already correct         : ' + alreadyOk
    + '\n  Resolved but no values  : ' + noValues
    + '\n  No Trip_Level row       : ' + noTripRow
    + '\n  KM delta vs system      : ' + (Math.round(kmDelta * 1000) / 1000)
    + '\n  Vendors affected        : ' + (Object.keys(byOracle).join(', ') || '—');
  Object.keys(missingCol).forEach(function (c) {
    head += '\n  MISSING COLUMN "' + c + '" on Trip_Level — ' + missingCol[c]
         + ' value(s) could not be written. Run "1 · Create / verify tabs" first.';
  });

  var msg = head + (lines.length ? ('\n\n' + lines.join('\n')) : '');
  Logger.log(msg);
  return msg;
}

/** Menu: dry run, show it, then ask before applying. */
function repairMissedResolutionsFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var dry = repairMissedResolutions(false);
  var head = dry.split('\n\n')[0];
  var r = ui.alert('Repair missed resolutions — DRY RUN', head
    + '\n\n(Full detail is in Extensions > Apps Script > Executions.)\n\nApply these changes now?',
    ui.ButtonSet.YES_NO);
  if (r !== ui.Button.YES) { ui.alert('Nothing applied.'); return; }
  var done = repairMissedResolutions(true);
  var s = (typeof syncToUpstash === 'function') ? syncToUpstash() : '(sync skipped)';
  ui.alert(done.split('\n\n')[0] + '\n\n' + s);
}
