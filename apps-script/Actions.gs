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
      row_id: rv[ctx.idx['row_id']], trip_id: tid, contract_id: rv[ctx.idx['contract_id']],
      transporter_oracle_id: a.oracle, sent_to_vendor_timestamp: rv[ctx.idx['sent_to_vendor_timestamp']],
      vendor_status: newStatus, dispute_window_end: rv[ctx.idx['dispute_window_end']],
      reconfirm_status: isReconf ? 'Reconfirmed' : '', final_state: newStatus
    });
    _setCell(ctx, ri, 'vendor_status', newStatus);   // Trip_Level written LAST → if a log write fails, action is retryable
    n++;
  });
  return n;
}

/** Raise a dispute for one trip. Returns 1 if a dispute row was created, else 0. */
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
    dispute_id: disputeId, row_id: g('row_id'), trip_id: a.trip_id, contract_id: g('contract_id'),
    transporter_oracle_id: a.oracle, vendor_name: _s(a.vendor_name), raised_at: _nowIso(),
    categories: (a.categories || []).join('|'),
    claim_billing_type: _s(a.claim_billing_type), claim_aggregate_vehicle: _s(a.claim_aggregate_vehicle),
    claim_km: (a.claim_km === '' || a.claim_km == null) ? '' : a.claim_km,
    claim_amount: (a.claim_amount === '' || a.claim_amount == null) ? '' : a.claim_amount,
    claim_contract_id: _s(a.claim_contract_id), vendor_description: _s(a.vendor_description),
    proof_url: _s(a.proof_url), callback_number: _s(a.callback_number),
    // teal (original snapshot from Trip_Level at submit)
    orig_vehicle_number: g('vehicle_number'), orig_vehicle_size: g('vehicle_size'),
    orig_trip_cluster: g('trip_cluster'), orig_route: origRoute, orig_completed_time: g('trip_end_time'),
    orig_billing_type: _s(rv[ctx.idx['billing_type_final']]) || _s(rv[ctx.idx['billing_type_system']]),
    orig_replaced_default_vehicle: _s(rv[ctx.idx['replaced_default_vehicle_final']]) || _s(rv[ctx.idx['replaced_default_vehicle_system']]),
    orig_total_km: g('total_trip_km'), orig_adhoc_amount: g('adhoc_amount'),
    // red block left blank; initial open status
    dispute_status: 'Open', reconfirm_status: isRedispute ? 'Re-disputed' : ''
  });

  _upsertStatusView({
    row_id: g('row_id'), trip_id: a.trip_id, contract_id: g('contract_id'), transporter_oracle_id: a.oracle,
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
    var groundConfirmed = _yes(rv[ctx.idx['ground_confirmed']]);

    // GUARD: a Regular classification on a NON-default vehicle needs a valid replaced-default mapping,
    // else its KM cannot fold into any default. If incomplete, discard the ground edit and transfer the
    // earlier (system) info instead; the trip still transfers but the ground log is marked partial.
    var _cid = _s(rv[ctx.idx['contract_id']]), _vno = _s(rv[ctx.idx['vehicle_number']]);
    var _finalBill = _low(rv[ctx.idx['billing_type_final']]) || _low(rv[ctx.idx['billing_type_system']]);
    var _isDefault = !!(defBy[_cid] && defBy[_cid][_vno]);
    var _replTarget = _s(rv[ctx.idx['replaced_default_vehicle_final']]) || _s(rv[ctx.idx['replaced_default_vehicle_system']]);
    var _replOK = !!(_replTarget && defBy[_cid] && defBy[_cid][_replTarget]);
    var _partial = (_finalBill === 'regular' && !_isDefault && !_replOK);
    if (_partial) {
      if (_s(rv[ctx.idx['billing_type_final']])) _setCell(ctx, i, 'billing_type_final', '');
      if (_s(rv[ctx.idx['replaced_default_vehicle_final']])) _setCell(ctx, i, 'replaced_default_vehicle_final', '');
    }

    // Ground_Confirmation_Log FIRST → a log failure leaves the trip un-transferred / retryable
    _appendByHeaders(LOG_TABS.ground, 'log_id', {
      log_id: 'GCL-' + Utilities.formatDate(now, _tz(), 'yyyyMMddHHmmss') + '-' + i,
      row_id: _s(rv[ctx.idx['row_id']]), trip_id: _s(rv[ctx.idx['trip_id']]),
      contract_id: _s(rv[ctx.idx['contract_id']]), transporter_oracle_id: _s(rv[ctx.idx['transporter_oracle_id']]),
      trip_end_time: _s(rv[ctx.idx['trip_end_time']]), ground_review_deadline: iso(dl),
      sent_to_vendor_timestamp: ts,
      ground_action_state: groundConfirmed ? 'GROUND_CONFIRMED' : 'NO_GROUND_ACTION',
      billing_before: _s(rv[ctx.idx['billing_type_system']]), billing_after: _s(rv[ctx.idx['billing_type_final']]) || _s(rv[ctx.idx['billing_type_system']]),
      replaced_vehicle_before: _s(rv[ctx.idx['replaced_default_vehicle_system']]),
      replaced_vehicle_after: _s(rv[ctx.idx['replaced_default_vehicle_final']]) || _s(rv[ctx.idx['replaced_default_vehicle_system']]),
      data_sent: _partial ? 'SYSTEM_ORIGINAL (incomplete reclassification)' : (groundConfirmed ? 'GROUND_FINAL' : 'SYSTEM_ORIGINAL'),
      partial_edit_flag: _partial ? 'Yes' : 'No'
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
      ow('billing_type_final', get(r, 'resolved_billing_type'));
      ow('total_trip_km', get(r, 'resolved_km'));
      ow('adhoc_amount', get(r, 'resolved_amount'));
      ow('replaced_default_vehicle_final', get(r, 'resolved_aggregate_vehicle'));
      ow('contract_id', get(r, 'resolved_contract_id'));
      _setCell(tl, tr, 'vendor_status', 'Reconfirm');   // re-surface to vendor
      _upsertStatusView({
        row_id: _s(tl.values[tr][tl.idx['row_id']]), trip_id: tripId,
        contract_id: _s(tl.values[tr][tl.idx['contract_id']]),
        transporter_oracle_id: _s(tl.values[tr][tl.idx['transporter_oracle_id']]),
        vendor_status: 'Reconfirm', dispute_id: did, dispute_status: 'Resolved',
        reconfirm_status: 'Pending Reconfirmation', final_state: 'Pending Reconfirmation'
      });
    }
    applied++;
  }
  return 'Resolved-disputes import: applied ' + applied + ', unmatched ' + missing +
         (notes.length ? ('\n' + notes.join('\n')) : '');
}


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
  var applied = 0, notes = [], now = _nowIso();
  var val = function (row, c) { return dl.idx[c] !== undefined ? _s(dl.values[row][dl.idx[c]]) : ''; };

  for (var i = dl.headerRow + 1; i < dl.values.length; i++) {
    var did = val(i, 'dispute_id'); if (!did) continue;
    if (val(i, 'dispute_status').toLowerCase() !== 'resolved') continue;   // TRIGGER: human set Resolved
    if (val(i, 'resolved_at')) continue;                                   // GUARD: already applied

    var tripId = val(i, 'trip_id');
    _setCell(dl, i, 'resolved_at', now);                                   // stamp the guard
    if (!val(i, 'reconfirm_status')) _setCell(dl, i, 'reconfirm_status', 'Pending Reconfirmation');

    var tr = _findRowIndex(tl, 'trip_id', tripId);
    if (tr < 0) { notes.push('no Trip_Level row for ' + tripId + ' (' + did + ')'); applied++; continue; }
    var ow = function (tlCol, v) { if (v !== '') _setCell(tl, tr, tlCol, v); };
    ow('billing_type_final', val(i, 'resolved_billing_type'));
    ow('total_trip_km', val(i, 'resolved_km'));
    ow('adhoc_amount', val(i, 'resolved_amount'));
    ow('replaced_default_vehicle_final', val(i, 'resolved_aggregate_vehicle'));
    ow('contract_id', val(i, 'resolved_contract_id'));
    _setCell(tl, tr, 'vendor_status', 'Reconfirm');                        // re-surface to vendor
    _upsertStatusView({
      row_id: _s(tl.values[tr][tl.idx['row_id']]), trip_id: tripId,
      contract_id: _s(tl.values[tr][tl.idx['contract_id']]),
      transporter_oracle_id: _s(tl.values[tr][tl.idx['transporter_oracle_id']]),
      vendor_status: 'Reconfirm', dispute_id: did, dispute_status: 'Resolved',
      reconfirm_status: 'Pending Reconfirmation', final_state: 'Pending Reconfirmation'
    });
    applied++;
  }
  var msg = 'In-sheet resolutions applied: ' + applied;
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
