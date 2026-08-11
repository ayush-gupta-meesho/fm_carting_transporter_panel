/**************************************************************************************************
 * VALMO Transporter Panel — BILLING MIS builder
 * ------------------------------------------------------------------------------------------------
 * Add this file to the SAME Apps Script project as Code.gs / Actions.gs / Sync.gs. It reuses
 * Code.gs's _readTab, _s, _low, _num, _yes, _toDate, _projFields, _fmtVehPeriod, _fmtShort, _tz and
 * — critically — _classifyTrip(). The classifier is shared with _buildVendorPayload so the MIS and
 * the Vercel panel cannot drift apart. Never re-implement a classification rule in this file.
 *
 * TWO ARTEFACTS, DELIBERATELY SEPARATE
 *
 *   1. The WORKING WORKBOOK (MIS_SHEET_ID) — what ops and finance keep open. Four tabs:
 *        1 Cost_View_All      all vendors, all contracts, incl. zonal   (regenerated each run)
 *        2 Zonal              the paste area — INPUT, never cleared
 *        3 Validation_Gates   Contract_Vehicles vs Contract_Info
 *        4 Exceptions         data-quality findings
 *      No per-vendor MIS is ever written here.
 *
 *   2. The VENDOR MIS — a standalone spreadsheet per vendor, produced by menu 10 and sent as a
 *      downloadable Excel (File -> Download -> Microsoft Excel). Four tabs:
 *        Local · Zonal · Adhoc · Summary
 *      Because it is built fresh from the model and never from the working workbook, there is no
 *      path by which one vendor could receive another vendor's numbers.
 *
 * BILLING FORMULA, per contract
 *   payable = fixed_monthly_value
 *           + MAX(0, SUM(local Regular non-RTO KM) - grouped_km_slab) * ex_km_rate
 *           + SUM(local Adhoc trip amounts)
 *           + SUM(Zonal rfq_rate)            <- rfq_rate IS the payable amount for the trip
 *   Excess is computed at GROUPED CONTRACT level, never per vehicle.
 *
 * SETUP (one-time)
 *   1. Create a Google Sheet named "FM Carting - Billing MIS". Share it to ops + finance as Viewer.
 *      Paste its id into MIS_SHEET_ID below.
 *   2. Add menu items 9 and 10 to Code.gs onOpen() (already done in the shipped Code.gs).
 *   3. Run menu 9 once and authorise when prompted.
 **************************************************************************************************/

/* ================================== CONFIG ================================== */
var MIS_SHEET_ID = '';                       // <-- PASTE the FM Carting - Billing MIS sheet id here

var MIS_EXCLUDE_ORACLES = ['ORC-4521'];      // dummy vendor data — excluded from the MIS by id.
                                             // It stays visible on the admin panel by design.
var MIS_NEAR_MISS_ED    = 2;                 // flag a non-default plate within this edit distance
                                             // of a default of the SAME contract as a likely typo
var MIS_TZ_FMT          = 'dd MMM yyyy HH:mm';

/* Working-workbook tab names. There is no Control / Local / Adhoc / Summary here — those live only
 * in the per-vendor Excel produced by menu 10. */
var MIS = {
  zonal: 'Zonal', costAll: 'Cost_View_All', gates: 'Validation_Gates', exceptions: 'Exceptions'
};

/* Zonal paste schema — header order is fixed. Only billing_type and rfq_rate drive money, and
 * everything is read BY HEADER NAME, so extra columns can be added without breaking this. */
var MIS_ZONAL_HEADERS = ['transporter_oracle_id', 'transporter_id', 'billing_type', 'trip_id',
  'rfq_id', 'vehicle_size', 'vehicle_number', 'transporter_name', 'driver_name', 'haul_type',
  'placement_date', 'trip_start_time', 'trip_end_time', 'source_node', 'planned_route',
  'actual_route', 'rfq_rate', 'source'];

/* Vendor-facing notice, shown as a highlighted banner at the top of the Summary tab.
 * Kept here so the wording can be changed without touching the writer. Set it to '' to hide it. */
var MIS_VENDOR_NOTICE =
  'This Summary is the main page — it carries the final payable for the period. The Local, Zonal and '
  + 'Adhoc tabs are the working detail (trip-by-trip backup) behind these numbers. '
  + 'If anything needs clarifying, please reach out to your AM or TM — happy to help.';

/* Style */
var C_NAVY = '#1F3864', C_PURPLE = '#5B2C87', C_LBLUE = '#DCE6F1', C_GREY = '#F2F2F2',
    C_AMBER = '#FFF2CC', C_RED = '#F8CBAD', C_GREEN = '#E2EFDA', C_MUTED = '#7F7F7F';
var FMT_MONEY = '#,##0;(#,##0);–', FMT_KM = '#,##0;(#,##0);–', FMT_PCT = '0.0%';

/* ================================== MENU ENTRY POINTS ================================== */

/**
 * VALMO Panel -> 9 - Refresh cost view + gates.
 * Rebuilds Cost_View_All, Validation_Gates and Exceptions in the working workbook.
 * The Zonal tab is created if missing and otherwise left completely alone — it is your input.
 * Nothing is ever written back to FM Carting - Panel; every read here is getValues().
 */
function refreshCostViewFromMenu() {
  var ui = SpreadsheetApp.getUi();
  if (!MIS_SHEET_ID) { ui.alert('Set MIS_SHEET_ID at the top of Billing.gs first.'); return; }

  var mis = SpreadsheetApp.openById(MIS_SHEET_ID);
  _misEnsureZonal(mis);

  var d = _misReadSource();                   // d.zonal is already indexed by oracle
  _misWriteCostViewAll(mis, d);
  _misWriteGates(mis, d);
  _misWriteExceptions(mis, d);
  _misOrderTabs(mis);

  var zRows = 0;
  Object.keys(d.zonal).forEach(function (k) { zRows += d.zonal[k].rows.length; });
  var zo = d.zonalOrphans || [];
  var blocked = [];
  Object.keys(d.info).forEach(function (cid) {
    var defs = d.vehs[cid] || [], slab = 0, fixed = 0;
    defs.forEach(function (v) { slab += _num(v.pegged_km_slab); fixed += _num(v.monthly_rate); });
    var c = d.info[cid];
    if (defs.length !== _num(c.no_of_vehicles)
        || Math.abs(slab - _num(c.total_km_slab)) > 0.5
        || Math.abs(fixed - _num(c.fixed_monthly_value)) > 0.5) blocked.push(cid);
  });

  ui.alert('Cost view refreshed'
    + '\n\nContracts: ' + Object.keys(d.info).length
    + '\nZonal rows read: ' + zRows
    + (blocked.length ? ('\n\n*** ' + blocked.length + ' contract(s) BLOCK — Contract_Info disagrees with '
        + 'Contract_Vehicles. Do not bill these:\n  ' + blocked.join('\n  ')) : '\n\nAll gates clear.')
    + (zo.length ? ('\n\n*** ' + zo.length + ' zonal oracle(s) match NO contract — ₹'
        + Math.round(zo.reduce(function (t, x) { return t + x.amt; }, 0))
        + ' will not be billed: ' + zo.map(function (x) { return x.oracle; }).join(', ') + ' ***') : ''));
}

/** Keep the working workbook in a fixed, predictable tab order. */
function _misOrderTabs(mis) {
  [MIS.costAll, MIS.zonal, MIS.gates, MIS.exceptions].forEach(function (name, i) {
    var sh = mis.getSheetByName(name);
    if (sh) { mis.setActiveSheet(sh); mis.moveActiveSheet(i + 1); }
  });
}

/**
 * VALMO Panel -> 10 - Generate vendor MIS (downloadable Excel).
 *
 * Builds a standalone spreadsheet for ONE vendor. You then open it and use
 * File -> Download -> Microsoft Excel (.xlsx) to send it.
 *
 * Never send the working workbook: Cost_View_All carries every other vendor's rates, fixed monthly
 * values and payables, and Validation_Gates / Exceptions carry internal findings. This function
 * renders one vendor from scratch and never reads those tabs, so that mistake is impossible.
 *
 * Deliberately withheld from the vendor MIS:
 *   - adhoc_reason_system                      (internal, per earlier decision)
 *   - projection and utilisation-sizing signals (internal commercial view)
 *   - gate results and data-quality findings
 *   - other vendors' rows, everywhere
 */
function generateVendorMisFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var vendors = _misVendors();
  if (!vendors.length) { ui.alert('No billable vendors found in Contract_Info.'); return; }

  var lines = vendors.map(function (v, i) { return (i + 1) + ') ' + v.oracle + '  ' + v.name; }).join('\n');
  var res = ui.prompt('Generate vendor MIS',
    'Type the transporter_oracle_id (or its number):\n\n' + lines, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var raw = _s(res.getResponseText()); if (!raw) return;

  var pick = null, n = parseInt(raw, 10);
  if (!isNaN(n) && String(n) === raw && n >= 1 && n <= vendors.length) pick = vendors[n - 1];
  if (!pick) {
    for (var i = 0; i < vendors.length; i++) {
      if (_misOrcKey(vendors[i].oracle) === _misOrcKey(raw)) { pick = vendors[i]; break; }
    }
  }
  if (!pick) { ui.alert('Could not match "' + raw + '" to a vendor.'); return; }

  var d = _misReadSource();
  var model = buildBillingModel(pick.oracle, d);

  var blockers = runGates(model, d).filter(function (g) { return g.verdict === 'BLOCK'; });
  if (blockers.length) {
    var go = ui.alert('Gates are NOT clear for ' + model.vendorName,
      blockers.map(function (g) { return '• ' + g.name + '\n   ' + g.detail; }).join('\n\n')
      + '\n\nGenerate the MIS anyway?', ui.ButtonSet.YES_NO);
    if (go !== ui.Button.YES) return;
  }

  var ss = _misWriteVendorMis(model);
  ui.alert('Vendor MIS created\n\n' + ss.getName()
    + '\n\nTotal payable: ₹' + Math.round(model.totals.payable).toLocaleString('en-IN')
    + '\n\nTo send it: open the link, then File → Download → Microsoft Excel (.xlsx)\n\n'
    + ss.getUrl());
}

/* ============================ THE VENDOR MIS (Local · Zonal · Adhoc · Summary) ============================
 * Rendered fresh from the model, in the tab order agreed with the business. Every trip in the period
 * appears exactly once across Local, Zonal and Adhoc, each carrying its trip_id, so the vendor can
 * reconcile line by line and quote an id when disputing.
 */
function _misWriteVendorMis(m) {
  var ss = SpreadsheetApp.create('Billing MIS - ' + m.vendorName + ' - ' + m.periodLabel);
  _vmSummary(ss, m);      // tab 1 — the headline. Everything after it is supporting detail.
  _vmLocal(ss, m);
  _vmZonal(ss, m);
  _vmAdhoc(ss, m);
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  return ss;
}

function _vmHead(sh, cols, l1, l2) {
  sh.getRange(1, 1, 1, cols).merge().setValue('  ' + l1)
    .setBackground(C_NAVY).setFontColor('#FFFFFF').setFontFamily('Arial')
    .setFontSize(14).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(1, 30);
  sh.getRange(2, 1, 1, cols).merge().setValue('  ' + l2)
    .setFontFamily('Arial').setFontSize(10).setFontColor(C_MUTED).setVerticalAlignment('middle');
  sh.setRowHeight(2, 20);
  sh.setHiddenGridlines(true);
}

function _vmHdr(sh, row, labels) {
  sh.getRange(row, 1, 1, labels.length).setValues([labels])
    .setBackground(C_LBLUE).setFontFamily('Arial').setFontWeight('bold').setFontSize(9)
    .setWrap(true).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setRowHeight(row, 28);
}

function _vmBand(sh, row, cols, text) {
  sh.getRange(row, 1, 1, cols).merge().setValue('  ' + text)
    .setBackground(C_PURPLE).setFontColor('#FFFFFF').setFontFamily('Arial')
    .setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  sh.setRowHeight(row, 20);
}

function _vmNote(sh, row, cols, text) {
  sh.getRange(row, 1, 1, cols).merge().setValue(text).setWrap(true)
    .setFontFamily('Arial').setFontSize(9).setFontColor(C_MUTED).setVerticalAlignment('top');
}

/* ---------- LOCAL: grouped-KM slab, vehicle breakdown, then the local trip list ---------- */
function _vmLocal(ss, m) {
  var sh = ss.insertSheet('Local');
  var NC = 13;
  var W = [70, 150, 190, 116, 52, 176, 104, 84, 78, 90, 126, 100, 92];
  for (var i = 0; i < W.length; i++) sh.setColumnWidth(i + 1, W[i]);
  _vmHead(sh, NC, m.vendorName + '  ·  Local trips — grouped KM against the contract slab',
          'Contract period ' + m.periodLabel + '   ·   only these KM count towards the slab');

  var r = 4;
  m.contracts.forEach(function (c) {
    _vmBand(sh, r, NC, c.cid + '   ·   ' + c.size + ' · ' + c.hours + ' · ' + c.duration); r++;

    /* -- vehicle breakdown -- */
    _vmHdr(sh, r, ['V#', 'Vehicle number', 'Active period', 'Days', 'Contracted KM', 'KM run',
                   'Used %', 'Trips', 'Note', '', '', '', '']); r++;
    var vFirst = r;
    var vBody = c.vehicles.map(function (v) {
      return [v.label, v.no, v.period, v.days, v.slab, Math.round(v.effKm),
              v.slab ? (v.effKm / v.slab) : '', v.trips,
              v.foldN ? ('includes ' + v.foldN + ' replacement trip' + (v.foldN > 1 ? 's' : '')) : ''];
    });
    if (vBody.length) sh.getRange(r, 1, vBody.length, 9).setValues(vBody).setFontFamily('Arial').setFontSize(10);
    r += vBody.length;
    c.repls.forEach(function (x) {
      sh.getRange(r, 2).setValue(x.no).setFontColor('#808080');
      sh.getRange(r, 6).setValue(Math.round(x.ownKm)).setFontColor('#AEB7C2');
      sh.getRange(r, 9).setValue('replacement — KM shown against the contracted vehicle above')
        .setFontSize(9).setFontColor(C_MUTED);
      r++;
    });
    if (c.unattrKm > 0) {
      sh.getRange(r, 2).setValue('Not mapped to a vehicle');
      sh.getRange(r, 6).setValue(Math.round(c.unattrKm));
      sh.getRange(r, 9).setValue('included in the contract KM total below')
        .setFontSize(9).setFontColor(C_MUTED);
      r++;
    }
    sh.getRange(r, 2).setValue('CONTRACT TOTAL').setFontWeight('bold');
    sh.getRange(r, 5).setValue(c.slabCV).setFontWeight('bold');
    sh.getRange(r, 6).setValue(Math.round(c.regKm)).setFontWeight('bold');
    sh.getRange(r, 1, 1, 9).setBackground(C_LBLUE);
    sh.getRange(vFirst, 5, r - vFirst + 1, 2).setNumberFormat(FMT_KM);
    sh.getRange(vFirst, 7, r - vFirst + 1, 1).setNumberFormat(FMT_PCT);
    r += 2;

    /* -- billing for this contract -- */
    var labels = ['Grouped KM slab', 'KM run (regular, non-RTO)', 'Over / (under) slab',
                  'Excess KM charged', 'Rate per extra KM', 'Excess amount',
                  'Fixed monthly amount', 'LOCAL PAYABLE'];
    var vals = [c.slabCV, Math.round(c.regKm), Math.round(c.regKm) - c.slabCV,
                Math.round(c.excessKm), c.exRate, c.excessAmt, c.fixedCV,
                c.fixedCV + c.excessAmt];
    for (var k = 0; k < labels.length; k++) {
      sh.getRange(r + k, 2).setValue(labels[k]).setFontWeight('bold').setFontFamily('Arial').setFontSize(10);
      sh.getRange(r + k, 6).setValue(vals[k]).setFontFamily('Arial').setFontSize(10)
        .setNumberFormat(k < 4 ? FMT_KM : (k === 4 ? '0.00' : FMT_MONEY));
    }
    sh.getRange(r + 7, 2, 1, 5).setBackground(C_GREEN);
    sh.getRange(r + 7, 6).setBackground(C_GREEN).setFontSize(11).setFontWeight('bold');
    r += labels.length + 2;

    /* -- the local trips behind those KM -- */
    _vmHdr(sh, r, ['Date', 'Trip id', 'Vehicle', 'Size', 'Route', 'Challan type', 'Billing type',
                   'KM billed', 'KM counted against', 'Completed', 'Status', '', '']); r++;
    var t = c.allTrips.filter(function (x) { return x.type !== 'Adhoc'; })
                      .sort(function (a, b) { return a.sortKey - b.sortKey; });
    if (!t.length) { _vmNote(sh, r, NC, 'no local trips in this period'); r += 2; return; }
    var tBody = t.map(function (x) {
      return [x.date, x.id, x.no, x.size, x.route, x.challan, x.type, x.km,
              x.countedTo, x.completed, x.status];
    });
    sh.getRange(r, 1, tBody.length, 11).setValues(tBody).setFontFamily('Arial').setFontSize(10);
    sh.getRange(r, 8, tBody.length, 1).setNumberFormat(FMT_KM);
    t.forEach(function (x, i) {
      if (x.type === 'RTO') sh.getRange(r + i, 7).setFontColor('#9C0006');
      if (x.countedTo === 'not mapped') sh.getRange(r + i, 9).setFontColor('#9C0006');
      var st = _low(x.status);
      if (st !== 'confirmed' && st !== 'reconfirmed') sh.getRange(r + i, 11).setBackground(C_AMBER);
    });
    r += tBody.length;
    _vmNote(sh, r, NC, 'RTO trips are listed at 0 KM and are not added to the slab.  '
      + '"KM counted against" is filled only for a replacement vehicle, and names the contracted '
      + 'vehicle its KM was added to.  Quote the Trip id when raising a dispute on the panel.');
    sh.setRowHeight(r, 26);
    r += 3;
  });
  sh.setFrozenRows(2);
}

/* ---------- ZONAL: grouped by RFQ id ---------- */
function _vmZonal(ss, m) {
  var sh = ss.insertSheet('Zonal');
  var NC = 10;
  var W = [80, 150, 116, 56, 200, 190, 88, 74, 100, 96];
  for (var i = 0; i < W.length; i++) sh.setColumnWidth(i + 1, W[i]);
  _vmHead(sh, NC, m.vendorName + '  \u00B7  Zonal trips',
          'Paid at a fixed amount per trip from the zonal RFQ  \u00B7  not part of any KM slab');

  /* One source: the vendor-level zonal read (Trip_Level rows, or the legacy paste tab while the engine
     is still being wired). A zonal trip has no contract_id, so there is nothing per-contract to merge. */
  var rows = ((m.zonal && m.zonal.rows) || []).map(function (z) {
    return { id: z.tripId, date: z.date, no: z.no, size: z.size, rfq: z.rfqId,
             route: z.actual || z.planned, billing: z.billing, rto: !!z.rto,
             amt: z.amt, status: z.status || '', challan: '', _cid: z.contractId || '' };
  });
  if (!rows.length) { _vmNote(sh, 4, NC, 'no zonal trips in this period'); sh.setFrozenRows(4); return; }

  // group by RFQ id — this is what separates the migration set from the standard one
  /* Band by RFQ for Regular trips. Adhoc has no RFQ rate by design, so it bands on its own at the end
     rather than under a "(no RFQ id)" heading that would read like missing data. */
  var ADHOC_BAND = 'Zonal adhoc \u2014 billed on amount, no RFQ rate';
  var byRfq = {}, order = [];
  rows.forEach(function (z) {
    var k = (_low(z.billing) === 'adhoc' && !z.rfq) ? ADHOC_BAND : (z.rfq || '(no RFQ id)');
    if (!byRfq[k]) { byRfq[k] = []; order.push(k); }
    byRfq[k].push(z);
  });
  order.sort(function (a, b) {                       // adhoc always last
    if (a === ADHOC_BAND) return 1;
    if (b === ADHOC_BAND) return -1;
    return a < b ? -1 : (a > b ? 1 : 0);
  });

  var r = 4, grand = 0;
  order.forEach(function (k) {
    var g = byRfq[k];
    var sub = g.reduce(function (t, z) { return t + (z.amt || 0); }, 0);
    grand += sub;
    _vmBand(sh, r, NC, (k === ADHOC_BAND ? k : ('RFQ  ' + k))
      + '   \u00B7   ' + g.length + ' trip' + (g.length > 1 ? 's' : '')); r++;
    _vmHdr(sh, r, ['Date', 'Trip id', 'Vehicle', 'Size', 'Route', 'RFQ ID (contract ref)',
                   'Challan type', 'Type', 'Status', 'Amount']); r++;
    var first = r;
    var body = g.sort(function (x, y) { return String(x.date) < String(y.date) ? -1 : 1; })
      .map(function (z) {
        return [z.date, z.id, z.no, z.size, z.route,
                z.rfq || (_low(z.billing) === 'adhoc' ? 'Zonal adhoc' : '(no RFQ id)'), z.challan || '',
                z.billing + (z.rto ? ' · RTO' : ''), z.status || '', z.amt || 0];
      });
    sh.getRange(r, 1, body.length, NC).setValues(body).setFontFamily('Arial').setFontSize(10);
    sh.getRange(r, 10, body.length, 1).setNumberFormat(FMT_MONEY);
    g.forEach(function (z, i) {
      if (z.rto) sh.getRange(r + i, 8).setFontColor('#9C0006');
      var st = _low(z.status);
      if (st && st !== 'confirmed' && st !== 'reconfirmed') sh.getRange(r + i, 9).setBackground(C_AMBER);
    });
    r += body.length;
    sh.getRange(r, 9).setValue(k === ADHOC_BAND ? 'ADHOC TOTAL' : 'RFQ TOTAL').setFontWeight('bold');
    sh.getRange(r, 10).setFormula('=SUM(J' + first + ':J' + (r - 1) + ')')
      .setFontWeight('bold').setNumberFormat(FMT_MONEY);
    sh.getRange(r, 1, 1, NC).setBackground(C_LBLUE);
    r += 2;
  });

  sh.getRange(r, 9).setValue('TOTAL ZONAL').setFontSize(12).setFontWeight('bold');
  sh.getRange(r, 10).setValue(grand).setFontSize(12).setFontWeight('bold').setNumberFormat(FMT_MONEY);
  sh.getRange(r, 1, 1, NC).setBackground(C_GREEN);
  r += 2;
  _vmNote(sh, r, NC, 'A zonal trip has no contract ID \u2014 its RFQ ID is the contract reference, and '
    + 'each trip is paid a fixed amount from that RFQ. Zonal KM is not added to any contract KM slab. '
    + 'An RTO zonal trip is shown for your records and is not payable.');
  sh.setFrozenRows(4);
}

/* ---------- ADHOC ---------- */
function _vmAdhoc(ss, m) {
  var sh = ss.insertSheet('Adhoc');
  var NC = 10;
  var W = [70, 150, 190, 116, 52, 190, 104, 96, 100, 92];
  for (var i = 0; i < W.length; i++) sh.setColumnWidth(i + 1, W[i]);
  _vmHead(sh, NC, m.vendorName + '  ·  Adhoc trips',
          'Paid at a fixed amount per trip  ·  outside the KM slab');

  var r = 4;
  _vmHdr(sh, r, ['Date', 'Trip id', 'Contract', 'Vehicle', 'Size', 'Route', 'Challan type',
                 'Amount', 'Completed', 'Status']); r++;
  var rows = [];
  m.contracts.forEach(function (c) {
    c.allTrips.filter(function (x) { return x.type === 'Adhoc'; }).forEach(function (x) {
      rows.push([x.date, x.id, c.cid, x.no, x.size, x.route, x.challan, x.amt, x.completed,
                 x.status, x.sortKey]);
    });
  });
  if (m.bucket) {
    m.bucket.trips.forEach(function (x) {
      rows.push([x.date, x.id, 'Other adhoc (no contract)', x.no, x.size, x.route, '',
                 x.amt, '', x.status, 0]);
    });
  }
  rows.sort(function (a, b) { return a[10] - b[10]; });
  if (!rows.length) { _vmNote(sh, r, NC, 'no adhoc trips in this period'); sh.setFrozenRows(4); return; }

  var body = rows.map(function (x) { return x.slice(0, NC); });
  sh.getRange(r, 1, body.length, NC).setValues(body).setFontFamily('Arial').setFontSize(10);
  sh.getRange(r, 8, body.length, 1).setNumberFormat(FMT_MONEY);
  rows.forEach(function (x, i) {
    var st = _low(x[9]);
    if (st !== 'confirmed' && st !== 'reconfirmed') sh.getRange(r + i, 10).setBackground(C_AMBER);
  });
  r += body.length;
  sh.getRange(r, 7).setValue('TOTAL').setFontWeight('bold');
  sh.getRange(r, 8).setFormula('=SUM(H' + (r - body.length) + ':H' + (r - 1) + ')')
    .setFontWeight('bold').setNumberFormat(FMT_MONEY);
  sh.getRange(r, 1, 1, NC).setBackground(C_GREEN);
  r += 2;
  _vmNote(sh, r, NC, 'Adhoc trips are paid per trip and do not contribute KM to the contract slab. '
    + 'Quote the Trip id when raising a dispute on the panel.');
  sh.setFrozenRows(4);
}

/* ---------- SUMMARY: the final amount ---------- */
function _vmSummary(ss, m) {
  var sh = ss.insertSheet('Summary');
  var NC = 12;
  var W = [250, 88, 86, 92, 78, 74, 92, 96, 96, 96, 96, 112];
  for (var i = 0; i < W.length; i++) sh.setColumnWidth(i + 1, W[i]);
  _vmHead(sh, NC, m.vendorName + '  ·  Billing Summary',
          'Contract period ' + m.periodLabel + '   ·   issued ' + m.generatedAt);

  /* Highlighted notice — this is the page vendors land on, so it says so, and points them at the
     right person for a query rather than at a reply to the file. */
  if (MIS_VENDOR_NOTICE) {
    sh.getRange(3, 1, 1, NC).merge().setValue('  ' + MIS_VENDOR_NOTICE)
      .setBackground(C_AMBER).setFontColor(C_NAVY).setFontFamily('Arial')
      .setFontSize(10.5).setFontWeight('bold').setWrap(true)
      .setVerticalAlignment('middle').setHorizontalAlignment('left');
    sh.setRowHeight(3, 40);
  }

  var r = 5;
  _vmHdr(sh, r, ['Contract', 'Vehicle size', 'Contracted vehicles', 'Grouped KM slab', 'KM run',
                 'Excess KM', 'Rate / extra KM', 'Excess amount', 'Fixed amount', 'Adhoc amount',
                 'Zonal amount', 'Total payable']); r++;
  var first = r, body = [];
  m.contracts.forEach(function (c) {
    body.push([c.cid, c.size, c.nvehCV, c.slabCV, Math.round(c.regKm), Math.round(c.excessKm),
               c.exRate, c.excessAmt, c.fixedCV, c.adhocAmt, 0,
               c.excessAmt + c.fixedCV + c.adhocAmt]);
  });
  if (m.bucket && m.bucket.adhocAmt) {
    body.push(['Other adhoc trips (no contract)', '—', '', '', '', '', '', 0, 0,
               m.bucket.adhocAmt, 0, m.bucket.adhocAmt]);
  }
  /* Zonal: one line PER RFQ ID, then a Zonal subtotal. The rfq_id is the contract reference for a
     zonal trip, so each RFQ is its own billing line and a vendor can reconcile the MIS against their
     invoice RFQ by RFQ. (decision 2026-08-07) */
  var zTot = m.totals.zonal;
  var zGroups = (m.zonal && m.zonal.rfqGroups) || [];
  if (zGroups.length) {
    zGroups.forEach(function (g) {
      var label = g.isAdhoc
        ? ('Zonal adhoc trips  \u2014  ' + g.trips + ' trip' + (g.trips === 1 ? '' : 's')
           + ', billed on amount (no RFQ rate applies)')
        : ('Zonal RFQ  ' + g.rfq + '  \u2014  ' + g.trips + ' trip' + (g.trips === 1 ? '' : 's'));
      body.push([label, '\u2014', '', '', '', '', '', 0, 0, 0, g.amt, g.amt]);
    });
    var _nRfq = zGroups.filter(function (g) { return !g.isAdhoc; }).length;
    body.push(['Zonal subtotal \u2014 ' + m.totals.zonalTrips + ' trip(s) across ' + _nRfq
               + ' RFQ' + (_nRfq === 1 ? '' : 's')
               + (zGroups.length > _nRfq ? ' plus adhoc' : ''),
               '\u2014', '', '', '', '', '', 0, 0, 0, zTot, zTot]);
  } else if (zTot) {
    body.push(['Zonal trips \u2014 ' + m.totals.zonalTrips + ' trip(s), fixed amount per trip from the RFQ',
               '\u2014', '', '', '', '', '', 0, 0, 0, zTot, zTot]);
  }
  sh.getRange(r, 1, body.length, NC).setValues(body).setFontFamily('Arial').setFontSize(10);
  r += body.length;
  var last = r - 1;

  /* The Zonal subtotal row repeats the per-RFQ lines above it, so it is EXCLUDED from the grand total
     and tinted so it reads as a subtotal. Without this, zonal would be counted twice. */
  var _zSubRow = zGroups.length ? last : 0;
  sh.getRange(r, 1).setValue('TOTAL PAYABLE').setFontSize(12).setFontWeight('bold');
  [4, 5, 6, 8, 9, 10, 11, 12].forEach(function (col) {
    var L = String.fromCharCode(64 + col);
    var _end = _zSubRow ? (_zSubRow - 1) : last;
    sh.getRange(r, col).setFormula('=SUM(' + L + first + ':' + L + _end + ')')
      .setFontSize(12).setFontWeight('bold');
  });
  if (_zSubRow) sh.getRange(_zSubRow, 1, 1, NC).setBackground(C_LBLUE).setFontWeight('bold');
  sh.getRange(r, 1, 1, NC).setBackground(C_GREEN);
  sh.getRange(first, 4, last - first + 2, 3).setNumberFormat(FMT_KM);
  sh.getRange(first, 7, last - first + 2, 1).setNumberFormat('0.00');
  sh.getRange(first, 8, last - first + 2, 5).setNumberFormat(FMT_MONEY);
  r += 2;

  var pend = Math.round(m.totals.pendKm), pendAmt = Math.round(m.totals.adhocPend);
  var notes = ['How this is calculated',
    '•  Fixed amount is the contracted monthly value for the vehicles on the contract.',
    '•  KM from all your regular trips is pooled across the whole contract and compared with the grouped KM slab. Extra KM is charged only if the CONTRACT total goes above its slab — never vehicle by vehicle. See the Local tab.',
    '•  Adhoc trips are paid at a fixed amount per trip and sit outside the KM slab. See the Adhoc tab.',
    '•  Zonal trips have no contract ID — the RFQ ID is the contract reference. Each zonal trip is paid a fixed amount from its RFQ and its KM is not added to any slab. Each RFQ is its own line above; see the Zonal tab for the trips.',
    '•  RTO trips are listed at 0 KM and are not added to the slab.',
    '•  Where a replacement vehicle ran in place of a contracted vehicle, its KM is shown against the contracted vehicle it stood in for.'];
  if (pend || pendAmt) {
    notes.push('');
    notes.push('Awaiting your confirmation on the panel: '
      + (pend ? pend.toLocaleString('en-IN') + ' KM' : '')
      + (pend && pendAmt ? '  and  ' : '')
      + (pendAmt ? '₹' + pendAmt.toLocaleString('en-IN') + ' of adhoc trips' : '')
      + '. These are included in the total above.');
  }
  notes.push('');
  notes.push('Every trip is listed with its Trip id on the Local, Adhoc and Zonal tabs. '
    + 'Any query on a trip should be raised as a dispute on the transporter panel.');
  notes.forEach(function (t, i) {
    sh.getRange(r + i, 1, 1, NC).merge().setValue(t).setWrap(true)
      .setFontFamily('Arial').setFontSize(i === 0 ? 11 : 10)
      .setFontWeight(i === 0 ? 'bold' : 'normal')
      .setFontColor(i === 0 ? C_NAVY : '#404040').setVerticalAlignment('top');
    if (t.length > 110) sh.setRowHeight(r + i, 30);
  });
  sh.setFrozenRows(MIS_VENDOR_NOTICE ? 5 : 4);
}

/* ================================== SOURCE READ (once) ================================== */

/**
 * Read every source tab EXACTLY ONCE and index it. Everything downstream works off this object,
 * so a full MIS run costs 3 tab reads regardless of how many vendors or contracts there are.
 */
function _misReadSource() {
  var ci = _readTab(TABS.contractInfo,     'contract_id');
  var cv = _readTab(TABS.contractVehicles, 'contract_id');
  var tl = _readTab(TABS.tripLevel,        'trip_id');

  var excl = {};
  MIS_EXCLUDE_ORACLES.forEach(function (o) { excl[_low(o)] = true; });

  var info = {}, byOracle = {}, orcKey = {};
  ci.forEach(function (c) {
    var cid = _s(c.contract_id); if (!cid) return;
    var orc = _s(c.vendor_oracle_id);
    if (excl[_low(orc)]) return;                       // dummy vendor never enters the MIS
    info[cid] = c;
    (byOracle[orc] = byOracle[orc] || []).push(c);
    orcKey[_misOrcKey(orc)] = orc;                     // join-normalised -> as-written
  });

  var vehs = {}, defSet = {}, plateHome = {};          // plate -> [contract_id...] it is a default of
  cv.forEach(function (v) {
    var cid = _s(v.contract_id); if (!info[cid]) return;
    (vehs[cid] = vehs[cid] || []).push(v);
    var no = _s(v.vehicle_number); if (!no) return;
    (defSet[cid] = defSet[cid] || {})[no] = true;
    (plateHome[no] = plateHome[no] || []).push(cid);
  });
  Object.keys(vehs).forEach(function (cid) {
    vehs[cid].sort(function (a, b) { return _num(a.day1_order) - _num(b.day1_order); });
  });

  var trips = {}, orphans = {};
  tl.forEach(function (t) {
    var cid = _s(t.contract_id);
    if (info[cid]) { (trips[cid] = trips[cid] || []).push(t); return; }
    var orc = _s(t.transporter_oracle_id);
    if (excl[_low(orc)] || !byOracle[orc]) return;      // unknown or excluded vendor -> ignore
    (orphans[orc] = orphans[orc] || []).push(t);
  });

  // Zonal is read ONCE here, keyed by oracle, so every consumer gets it automatically.
  // It lives in _misReadSource on purpose: Cost_View_All previously omitted zonal entirely because
  // populating model.zonal was left to the caller and only two of four callers did it.
  /* Zonal now lives in Trip_Level (route_scope = Zonal), so it is derived from the same rows every
     other number comes from — one source, one classifier. The manual paste tab is kept ONLY as a
     fallback for the transition: if Trip_Level carries no zonal rows yet, we still read the paste.
     Once the engine writes route_scope this branch stops being used and the tab becomes an output. */
  var zAll = {}, zFromTrips = 0;
  tl.forEach(function (t) {
    if (_low(_s(t.route_scope) || 'Local') !== 'zonal') return;
    var orc = _s(t.transporter_oracle_id);
    if (excl[_low(orc)] || !byOracle[orc]) return;
    var x = _classifyTrip(t, {}, 'Regular');
    if (!zAll[orc]) zAll[orc] = _misZonalEmpty();
    var z = zAll[orc];
    z.rows.push({ tripId: _s(t.trip_id), rfqId: _s(t.rfq_id), no: x.no,
      size: _s(t.vehicle_size), haul: '', date: _misDate(t.trip_date),
      planned: '', actual: _buildRoute(t).join(' \u2192 '),
      billing: x.isAdhoc ? 'Adhoc' : 'Regular', rto: x.rto,
      contractId: _s(t.contract_id), status: _s(t.vendor_status),
      amt: x.payable });                       // payable is RTO-aware: an RTO zonal trip is worth 0
    if (x.isAdhoc) { z.adhocN++; z.adhocAmt += x.payable; }
    else           { z.regN++;   z.regAmt   += x.payable; }
    zFromTrips++;
  });
  if (!zFromTrips) zAll = _misReadZonalAll();      // nothing in Trip_Level yet -> legacy paste tab
  // Re-key zonal onto the oracle strings Contract_Info actually uses, and park anything that matches
  // no vendor so it is visible instead of silently worth zero.
  var zonal = {}, zonalOrphans = [];
  Object.keys(zAll).forEach(function (k) {
    var real = orcKey[_misOrcKey(k)];
    if (real) {
      if (!zonal[real]) zonal[real] = _misZonalEmpty();
      var t = zonal[real], z = zAll[k];
      t.regN += z.regN; t.regAmt += z.regAmt; t.adhocN += z.adhocN; t.adhocAmt += z.adhocAmt;
      t.rows = t.rows.concat(z.rows);
    } else {
      zonalOrphans.push({ oracle: k, trips: zAll[k].rows.length,
                          amt: zAll[k].regAmt + zAll[k].adhocAmt });
    }
  });

  // rfq grouping is computed once, here, for the same reason zonal itself is: so no caller can forget
  Object.keys(zonal).forEach(function (k) { zonal[k].rfqGroups = _misZonalRfq(zonal[k]); });

  return { info: info, byOracle: byOracle, orcKey: orcKey, vehs: vehs, defSet: defSet,
           plateHome: plateHome, trips: trips, orphans: orphans,
           zonal: zonal, zonalOrphans: zonalOrphans };
}

function _misZonalEmpty() { return { regN: 0, regAmt: 0, adhocN: 0, adhocAmt: 0, rows: [], rfqGroups: [] }; }
/* Group a vendor's zonal rows by rfq_id. The rfq_id IS the contract reference for a zonal trip
   (decision 2026-08-07), so this is the zonal equivalent of "per contract" and it drives both the
   Summary lines and the Zonal tab bands. */
function _misZonalRfq(z) {
  /* A zonal REGULAR trip bills at its RFQ rate, so rfq_id is its billing reference and it gets a line.
     A zonal ADHOC trip bills on its amount and has NO rfq_id by design — it is not an RFQ line, it is not
     a missing value, and it must not be gated as one. Adhoc is collected into a single trailing group
     flagged isAdhoc, so the Summary can label it "billed on amount" instead of inventing an RFQ. */
  var g = {}, order = [], ad = { rfq: 'Zonal adhoc trips', trips: 0, amt: 0, regN: 0, regAmt: 0,
                                 adhocN: 0, adhocAmt: 0, isAdhoc: true, rfqsSeen: {} };
  (z.rows || []).forEach(function (row) {
    var isAd = _low(row.billing) === 'adhoc';
    var amt  = row.amt || 0;
    if (isAd) {
      ad.trips++; ad.amt += amt; ad.adhocN++; ad.adhocAmt += amt;
      if (_s(row.rfqId)) ad.rfqsSeen[_s(row.rfqId)] = 1;   // kept if the engine happens to stamp one
      return;
    }
    var k = _s(row.rfqId) || '(no RFQ id)';
    if (!g[k]) { g[k] = { rfq: k, trips: 0, amt: 0, regN: 0, regAmt: 0, adhocN: 0, adhocAmt: 0, isAdhoc: false }; order.push(k); }
    var e = g[k];
    e.trips++; e.amt += amt; e.regN++; e.regAmt += amt;
  });
  order.sort();
  var out = order.map(function (k) { return g[k]; });
  if (ad.trips) { ad.rfqs = Object.keys(ad.rfqsSeen); delete ad.rfqsSeen; out.push(ad); }
  return out;
}

/**
 * Normalise a transporter_oracle_id for JOINING ONLY (never for display).
 * The workbook mixes types: Contract_Info holds 18838 as a NUMBER while a pasted zonal extract or a
 * CSV round-trip can produce "18838" or even "18838.0", and any of them can carry stray whitespace.
 * An unnormalised join silently drops the zonal amount to zero, which is the worst possible failure
 * mode for a billing number — so every oracle comparison in this file goes through here.
 */
function _misOrcKey(v) {
  var k = _s(v).replace(/\s+/g, '').toUpperCase();
  if (/^\d+\.0+$/.test(k)) k = k.split('.')[0];      // 18838.0 -> 18838
  return k;
}

/** Vendors that have at least one contract, in descending contract count. */
function _misVendors() {
  var d = _misReadSource();
  return Object.keys(d.byOracle).map(function (o) {
    return { oracle: o, name: _s(d.byOracle[o][0].vendor_name), contracts: d.byOracle[o].length };
  }).sort(function (a, b) { return b.contracts - a.contracts; });
}

/* ================================== THE MODEL ================================== */

/**
 * Build the complete billing model for one vendor. Pure computation — writes nothing.
 * A trip belongs to the period by trip_date (a trip that ENDS next month still bills to this one).
 */
function buildBillingModel(oracle, d) {
  d = d || _misReadSource();
  oracle = _s(oracle);
  var myContracts = d.byOracle[oracle] || [];
  if (!myContracts.length) throw new Error('No contracts for oracle "' + oracle + '" (or it is excluded).');

  var vendorName = _s(myContracts[0].vendor_name);
  var pStart = null, pEnd = null;
  myContracts.forEach(function (c) {
    var a = _toDate(c.contract_start_date), b = _toDate(c.contract_end_date);
    if (a && (!pStart || a < pStart)) pStart = a;
    if (b && (!pEnd   || b > pEnd))   pEnd   = b;
  });

  var out = [];
  myContracts.forEach(function (c) {
    var cid  = _s(c.contract_id);
    var defs = d.vehs[cid] || [];
    var dset = d.defSet[cid] || {};
    /* contract_id scopes the period — never date-filter here, or the MIS would silently disagree
       with the panel. Zonal is excluded outright: it has no contract_id, its rfq_id is its contract
       reference, and it is built at vendor level in _misReadSource. This filter is the belt-and-braces
       case where the engine DID stamp a contract_id on a zonal row — it must still never reach a slab,
       a vehicle row or a utilisation %. */
    var cTrips = (d.trips[cid] || []).filter(function (t) {
      return _low(_s(t.route_scope) || 'Local') !== 'zonal';
    });

    var slabCV = 0, fixedCV = 0;
    var vehSlab = {}, vehDates = {};
    defs.forEach(function (v) {
      var no = _s(v.vehicle_number);
      slabCV  += _num(v.pegged_km_slab);
      fixedCV += _num(v.monthly_rate);
      vehSlab[no] = _num(v.pegged_km_slab);
      vehDates[no] = { start: _s(v.start_date), end: _s(v.end_date), days: _num(v.active_days) };
    });

    var ownKm = {}, tripsN = {}, foldKm = {}, foldN = {};
    var regKm = 0, pendKm = 0, adhocAmt = 0, adhocPend = 0;
    var adhocTrips = [], rtoTrips = [], unattr = [], replOrder = [], nearMiss = {}, outOfPeriod = [];
    var allTrips = [];                               // every trip, for the vendor-facing pack

    cTrips.forEach(function (t) {
      var x = _classifyTrip(t, dset, 'Regular');       // <-- SHARED with the panel
      var no = x.no;
      if (!_misInPeriod(t, c)) {                       // flagged, never dropped
        outOfPeriod.push({ id: _s(t.trip_id), date: _misDate(t.trip_date), no: no, km: x.km });
      }
      if (no && !x.isDefault && replOrder.indexOf(no) === -1) replOrder.push(no);
      if (!ownKm[no])  { ownKm[no] = 0; tripsN[no] = 0; }
      tripsN[no]++;

      allTrips.push({
        id:        _s(t.trip_id),
        rowId:     _s(t.row_id),
        date:      _misDate(t.trip_date),
        sortKey:   (function () { var dd = _toDate(t.trip_date); return dd ? dd.getTime() : 0; })(),
        no:        no,
        size:      _s(t.vehicle_size) || _s(c.vehicle_size),
        source:    _s(t.source_node),
        dest:      _s(t.dest_fmh_nodes),
        route:     _buildRoute(t).join(' \u2192 '),
        challan:   _s(t.challan_type_final) || _s(t.challan_type),
        type:      x.isAdhoc ? 'Adhoc' : (x.rto ? 'RTO' : 'Regular'),
        km:        x.isAdhoc ? null : (x.rto ? 0 : x.km),
        amt:       x.isAdhoc ? x.amt : null,
        countedTo: (!x.isAdhoc && !x.rto && !x.isDefault) ? (x.foldValid ? x.foldTo : 'not mapped') : '',
        started:   _fmtShort(t.trip_start_time),
        completed: _fmtShort(t.trip_end_time),
        status:    _s(t.vendor_status)
      });

      if (x.isAdhoc) {
        adhocAmt += x.amt;
        if (!x.settled) adhocPend += x.amt;
        adhocTrips.push({ id: _s(t.trip_id), date: _misDate(t.trip_date), no: no,
          size: _s(t.vehicle_size) || _s(c.vehicle_size), route: _buildRoute(t).join(' → '),
          amt: x.amt, status: _s(t.vendor_status), rto: x.rto, reason: _s(t.adhoc_reason_system) });
        return;
      }
      if (x.rto) {
        rtoTrips.push({ id: _s(t.trip_id), date: _misDate(t.trip_date), no: no,
          challan: _s(t.challan_type_final) || _s(t.challan_type), status: _s(t.vendor_status),
          realKm: x.km });
        return;                                        // RTO: shown, KM never accumulated
      }

      regKm += x.km;                                   // contract KM counts every Regular non-RTO trip
      ownKm[no] += x.km;
      if (!x.settled) pendKm += x.km;

      if (!x.isDefault) {
        if (x.foldValid) {
          foldKm[x.foldTo] = (foldKm[x.foldTo] || 0) + x.km;
          foldN[x.foldTo]  = (foldN[x.foldTo]  || 0) + 1;
        } else {
          unattr.push({ id: _s(t.trip_id), date: _misDate(t.trip_date), no: no,
                        km: x.km, foldTo: x.foldTo, status: _s(t.vendor_status) });
        }
        var nm = _misNearMiss(no, dset, d.plateHome, cid);
        if (nm) {
          var k = no;
          if (!nearMiss[k]) nearMiss[k] = { no: no, nearest: nm.nearest, ed: nm.ed,
                                           homeOf: nm.homeOf, trips: 0, km: 0, folds: {} };
          nearMiss[k].trips++; nearMiss[k].km += x.km;
          if (x.foldTo) nearMiss[k].folds[x.foldTo] = true;
        }
      }
    });

    var vehicles = defs.map(function (v, i) {
      var no = _s(v.vehicle_number);
      var eff = (ownKm[no] || 0) + (foldKm[no] || 0);
      var vd  = vehDates[no] || {};
      var pf  = (vehSlab[no] > 0)
        ? _projFields(eff, vehSlab[no], vd.start || c.contract_start_date, vd.end || c.contract_end_date)
        : null;
      return { label: 'V' + (i + 1), no: no, order: _num(v.day1_order),
               start: _s(v.start_date), end: _s(v.end_date), days: _num(v.active_days),
               period: _fmtVehPeriod(vd.start || c.contract_start_date, vd.end || c.contract_end_date),
               slab: vehSlab[no], rate: _num(v.monthly_rate),
               ownKm: ownKm[no] || 0, foldKm: foldKm[no] || 0, foldN: foldN[no] || 0,
               effKm: eff, trips: tripsN[no] || 0,
               projKm: pf ? pf.projected : 0, projPct: pf ? pf.projPct : 0, sizing: pf ? pf.sizing : '' };
    });

    var repls = replOrder.map(function (no) {
      return { no: no, ownKm: ownKm[no] || 0, trips: tripsN[no] || 0 };
    });

    var slabCI  = _num(c.total_km_slab);
    var fixedCI = _num(c.fixed_monthly_value);
    var exRate  = _num(c.ex_km_rate);
    var excessKm = Math.max(0, regKm - slabCV);
    var cpf = _projFields(regKm, slabCV, c.contract_start_date, c.contract_end_date);

    out.push({
      cid: cid, size: _s(c.vehicle_size), hours: _s(c.hours_slab), cluster: _s(c.cluster),
      status: _s(c.contract_status),
      start: _s(c.contract_start_date), end: _s(c.contract_end_date),
      duration: _fmtRange(c.contract_start_date, c.contract_end_date),
      nvehCV: defs.length, nvehCI: _num(c.no_of_vehicles),
      slabCV: slabCV, slabCI: slabCI, fixedCV: fixedCV, fixedCI: fixedCI, exRate: exRate,
      regKm: regKm, pendKm: pendKm, excessKm: excessKm, excessAmt: excessKm * exRate,
      adhocAmt: adhocAmt, adhocPend: adhocPend,
      localPayable: fixedCV + excessKm * exRate,
      projKm: cpf.projected, projPct: cpf.projPct, sizing: cpf.sizing,
      vehicles: vehicles, repls: repls, unattr: unattr, allTrips: allTrips,
      adhocTrips: adhocTrips, rtoTrips: rtoTrips,
      nearMiss: Object.keys(nearMiss).map(function (k) { return nearMiss[k]; }),
      outOfPeriod: outOfPeriod,
      unattrKm: unattr.reduce(function (s, u) { return s + u.km; }, 0),
      isBucket: false
    });
  });

  /* Other-Adhoc bucket — trips whose contract_id is not one of this vendor's contracts.
     Its own line in the MIS, per the agreed treatment. */
  var bucket = null;
  var orph = d.orphans[oracle] || [];
  if (orph.length) {
    var bAmt = 0, bTrips = [];
    orph.forEach(function (t) {
      var x = _classifyTrip(t, {}, 'Adhoc');
      if (x.isAdhoc) bAmt += x.amt;
      bTrips.push({ id: _s(t.trip_id), date: _misDate(t.trip_date), no: x.no, size: _s(t.vehicle_size),
        route: _buildRoute(t).join(' → '), amt: x.isAdhoc ? x.amt : 0,
        status: _s(t.vendor_status), rto: x.rto, cid: _s(t.contract_id) });
    });
    bucket = { cid: 'ADHOC-' + oracle, adhocAmt: bAmt, trips: bTrips, isBucket: true };
  }

  var model = {
    oracle: oracle, vendorName: vendorName,
    periodStart: pStart, periodEnd: pEnd,
    periodLabel: _fmtRange(pStart, pEnd),
    generatedAt: Utilities.formatDate(new Date(), _tz(), MIS_TZ_FMT),
    generatedBy: (function () { try { return Session.getActiveUser().getEmail(); } catch (e) { return ''; } })(),
    contracts: out, bucket: bucket,
    zonal: (d.zonal && d.zonal[oracle]) || _misZonalEmpty()   // attached in _misReadSource — never per-caller
  };
  model.totals = _misTotals(model);
  return model;
}

function _misTotals(m) {
  var t = { slab: 0, regKm: 0, pendKm: 0, excessKm: 0, excessAmt: 0, fixed: 0,
            adhoc: 0, adhocPend: 0, zonal: 0, zonalTrips: 0, unattrKm: 0, payable: 0 };
  m.contracts.forEach(function (c) {
    t.slab += c.slabCV; t.regKm += c.regKm; t.pendKm += c.pendKm;
    t.excessKm += c.excessKm; t.excessAmt += c.excessAmt; t.fixed += c.fixedCV;
    t.adhoc += c.adhocAmt; t.adhocPend += c.adhocPend; t.unattrKm += c.unattrKm;
  });
  if (m.bucket) t.adhoc += m.bucket.adhocAmt;
  /* ONE source for zonal: the vendor-level read in _misReadSource, keyed on rfq_id. A zonal trip has
     no contract_id, so there is no per-contract figure to prefer and no double-count to guard. */
  t.zonal      = (m.zonal.regAmt || 0) + (m.zonal.adhocAmt || 0);
  t.zonalTrips = (m.zonal.rows || []).length;
  t.payable = t.fixed + t.excessAmt + t.adhoc + t.zonal;
  return t;
}

/**
 * Does this trip's trip_date sit inside its contract's window?
 * trip_date decides the period (a trip that ENDS next month still bills to this one); trip_end_time
 * is only a fallback when trip_date is blank. Used for FLAGGING only — a trip is never excluded on
 * this test, because contract_id is what actually scopes the bill and the panel applies no date filter.
 */
function _misInPeriod(t, c) {
  var d = _toDate(t.trip_date) || _toDate(t.trip_end_time);
  var a = _toDate(c.contract_start_date), b = _toDate(c.contract_end_date);
  if (!d || !a || !b) return true;                      // never silently drop a trip
  var day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var s   = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  var e   = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return day >= s && day <= e;
}

function _misDate(v) { var d = _toDate(v); return d ? Utilities.formatDate(d, _tz(), 'dd MMM') : _s(v); }

/* ================================== NEAR-MISS PLATES ================================== */

/**
 * Is this non-default plate a likely typo of a default of the same contract?
 * Returns null, or {nearest, ed, homeOf}. homeOf is set when the plate is a REAL default of
 * another contract — that is cross-contract leakage, a different (and worse) problem than a typo,
 * and it must never be auto-corrected to the look-alike.
 *
 * NOTE: this is reporting only. We deliberately do NOT auto-correct. Several contracts hold two
 * genuine defaults within edit distance 2 of each other (e.g. GJ03CU1556 / GJ03CU2156 on
 * RJK10-20077), so any fuzzy rule would move real KM onto the wrong real vehicle.
 */
function _misNearMiss(no, dset, plateHome, cid) {
  if (!no) return null;
  var homes = (plateHome[no] || []).filter(function (h) { return h !== cid; });
  var best = null, bestEd = 99;
  Object.keys(dset).forEach(function (dn) {
    var ed = _levenshtein(no, dn);
    if (ed < bestEd) { bestEd = ed; best = dn; }
  });
  if (bestEd > MIS_NEAR_MISS_ED && !homes.length) return null;
  return { nearest: best, ed: bestEd, homeOf: homes.length ? homes.join(', ') : '' };
}

function _levenshtein(a, b) {
  a = String(a); b = String(b);
  var m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  var prev = [], cur = [], i, j;
  for (j = 0; j <= n; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur[0] = i;
    for (j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    }
    for (j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

/* ================================== GATES ================================== */

/**
 * Nothing goes to a vendor until every BLOCK gate is clear.
 * Gates 2 and 3 exist because a contract is a culmination of Contract_Vehicles AND Contract_Info
 * (ex_km_rate lives only in Contract_Info), so the two must agree before anyone bills.
 */
function runGates(model, d) {
  d = d || _misReadSource();
  var g = [];
  function add(name, ok, detail, level) {
    g.push({ name: name, verdict: ok ? 'clear' : (level || 'BLOCK'), detail: detail || '' });
  }

  var bad = [];
  model.contracts.forEach(function (c) { if (c.nvehCV !== c.nvehCI) bad.push(c.cid + ' (' + c.nvehCV + ' vs ' + c.nvehCI + ')'); });
  add('Contract_Vehicles row count = Contract_Info.no_of_vehicles', !bad.length, bad.join('; '));

  bad = [];
  model.contracts.forEach(function (c) {
    if (Math.abs(c.slabCV - c.slabCI) > 0.5) bad.push(c.cid + ' (Σ ' + c.slabCV + ' vs CI ' + c.slabCI + ')');
  });
  add('Σ pegged_km_slab = Contract_Info.total_km_slab', !bad.length, bad.join('; '));

  bad = [];
  model.contracts.forEach(function (c) {
    if (Math.abs(c.fixedCV - c.fixedCI) > 0.5) bad.push(c.cid + ' (Σ ' + c.fixedCV + ' vs CI ' + c.fixedCI + ')');
  });
  add('Σ monthly_rate = Contract_Info.fixed_monthly_value', !bad.length, bad.join('; '));

  var un = 0, unKm = 0;
  model.contracts.forEach(function (c) { un += c.unattr.length; unKm += c.unattrKm; });
  add('Every Regular non-default trip folds to a valid default', un === 0,
      un ? (un + ' trip(s), ' + Math.round(unKm) + ' km counted in the slab but on no vehicle') : '', 'WARN');

  bad = [];
  model.contracts.forEach(function (c) {
    var seen = {};
    (d.vehs[c.cid] || []).forEach(function (v) {
      var no = _s(v.vehicle_number);
      if (!no) { bad.push(c.cid + ' (blank vehicle_number)'); return; }
      if (seen[no]) bad.push(c.cid + ' / ' + no); else seen[no] = true;
    });
  });
  add('No duplicate or blank (contract_id, vehicle_number)', !bad.length, bad.join('; '));

  var active = model.contracts.filter(function (c) { return _low(c.status) === 'active'; }).length;
  add('Vendor has at least one Active contract in the period', active > 0,
      active ? '' : 'no contract with contract_status = Active');

  var nm = 0, nmKm = 0, lk = 0, lkKm = 0;
  model.contracts.forEach(function (c) {
    c.nearMiss.forEach(function (x) {
      if (x.homeOf) { lk++; lkKm += x.km; } else { nm++; nmKm += x.km; }
    });
  });
  add('No look-alike plates needing review', nm === 0,
      nm ? (nm + ' plate(s), ' + Math.round(nmKm) + ' km within edit distance ' + MIS_NEAR_MISS_ED) : '', 'WARN');
  add('No plate running against another contract', lk === 0,
      lk ? (lk + ' plate(s), ' + Math.round(lkKm) + ' km — vehicle is a default of a DIFFERENT contract') : '', 'WARN');

  var zo = d.zonalOrphans || [];
  add('Every zonal row matches a known vendor', zo.length === 0,
      zo.length ? (zo.length + ' oracle(s) on the Zonal tab match no contract — ₹'
        + Math.round(zo.reduce(function (t, x) { return t + x.amt; }, 0))
        + ' would not be billed: ' + zo.map(function (x) { return x.oracle; }).join(', ')) : '');

  /* rfq_id is the contract reference for a zonal trip, so a blank one cannot be reconciled against a
     vendor invoice. The amount still bills (the engine set it) — this is a reconciliation gate, so WARN. */
  /* only a zonal REGULAR trip can be "missing" an rfq_id — adhoc bills on its amount and never has one,
     so it is excluded here or this gate would WARN forever on perfectly correct data */
  var _zNo = ((model.zonal && model.zonal.rfqGroups) || []).filter(function (x) {
    return !x.isAdhoc && x.rfq === '(no RFQ id)';
  })[0];
  add('Every zonal REGULAR trip carries an RFQ ID', !_zNo,
      _zNo ? (_zNo.trips + ' zonal Regular trip(s) have a blank rfq_id \u2014 \u20b9' + Math.round(_zNo.amt)
        + ' still bills but cannot be tied to an RFQ line on the invoice. Fix in the data engine.') : '', 'WARN');

  var oop = 0;
  model.contracts.forEach(function (c) { oop += (c.outOfPeriod || []).length; });
  add('Every trip_date sits inside its contract window', oop === 0,
      oop ? (oop + ' trip(s) dated outside the contract period — still billed, see Exceptions') : '', 'WARN');

  return g;
}

/* ================================== ZONAL (read-only) ================================== */

function _misEnsureZonal(mis) {
  var sh = mis.getSheetByName(MIS.zonal);
  if (sh) return sh;
  sh = mis.insertSheet(MIS.zonal);
  sh.getRange(1, 1, 1, 1).setValue('ZONAL — paste the zonal trip extract below. Rows are read BY HEADER NAME. '
    + 'Never cleared by Generate. Keep one row per zonal trip, all vendors together; the MIS filters by transporter_oracle_id.')
    .setFontFamily('Arial').setFontSize(9).setFontColor(C_MUTED).setWrap(true);
  sh.getRange(3, 1, 1, MIS_ZONAL_HEADERS.length).setValues([MIS_ZONAL_HEADERS])
    .setFontFamily('Arial').setFontWeight('bold').setFontColor('#FFFFFF').setBackground(C_NAVY);
  sh.getRange(4, 1, 1, MIS_ZONAL_HEADERS.length).setValues([[
    'EXAMPLE-DO-NOT-USE', 'TRP-13551', 'Regular', 'ZN-TR-000001', 'RFQ-EGZ-RKS-014', '10FT', 'GJ03BY2547',
    'Shiv Roadlines', 'Ramesh P.', 'zonal', '2026-07-22', '06:10', '2026-07-22 14:35:00',
    'RKS', 'EGZ → RKS', 'RKS → RTS → EGZ', 8450, 'EXAMPLE — not counted']])
    .setFontFamily('Arial').setFontSize(9).setFontStyle('italic').setBackground(C_AMBER).setFontColor(C_MUTED);
  sh.getRange(5, 1).setValue('↑ row 4 is an EXAMPLE. Its transporter_oracle_id can never match a real vendor, so it is '
    + 'excluded everywhere and can be left in place as a format reference. Paste real rows from row 5 down.')
    .setFontFamily('Arial').setFontSize(9).setFontColor(C_MUTED);
  sh.setFrozenRows(3);
  sh.getRange(1, 17, sh.getMaxRows(), 1).setNumberFormat('#,##0.00');
  return sh;
}

/**
 * Read the whole zonal paste area once and index it by transporter_oracle_id.
 * rfq_rate IS the payable amount for the trip (confirmed). Rows whose transporter_oracle_id or
 * `source` starts with EXAMPLE are ignored. Returns {} if the MIS sheet or tab does not exist yet.
 */
function _misReadZonalAll() {
  var out = {};
  if (!MIS_SHEET_ID) return out;
  var sh;
  try { sh = SpreadsheetApp.openById(MIS_SHEET_ID).getSheetByName(MIS.zonal); } catch (e) { return out; }
  if (!sh) return out;

  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return out;

  var hdr = -1, cols = {};
  for (var r = 0; r < Math.min(8, vals.length); r++) {
    var row = vals[r].map(function (v) { return _low(v); });
    if (row.indexOf('transporter_oracle_id') !== -1 && row.indexOf('rfq_rate') !== -1) {
      hdr = r; row.forEach(function (h, i) { if (h) cols[h] = i; }); break;
    }
  }
  if (hdr < 0) return out;

  for (var i = hdr + 1; i < vals.length; i++) {
    var v = vals[i];
    var orc = _s(v[cols['transporter_oracle_id']]);
    if (!orc || _low(orc).indexOf('example') === 0) continue;
    if (cols['source'] !== undefined && _low(v[cols['source']]).indexOf('example') === 0) continue;

    var bt  = _low(v[cols['billing_type']]);
    var amt = _num(v[cols['rfq_rate']]);
    if (!out[orc]) out[orc] = _misZonalEmpty();
    out[orc].rows.push({ tripId: _s(v[cols['trip_id']]), rfqId: _s(v[cols['rfq_id']]),
      no: _s(v[cols['vehicle_number']]), size: _s(v[cols['vehicle_size']]),
      haul: _s(v[cols['haul_type']]), date: _s(v[cols['placement_date']]),
      planned: _s(v[cols['planned_route']]), actual: _s(v[cols['actual_route']]),
      billing: bt === 'adhoc' ? 'Adhoc' : 'Regular', amt: amt });
    if (bt === 'adhoc') { out[orc].adhocN++; out[orc].adhocAmt += amt; }
    else                { out[orc].regN++;   out[orc].regAmt   += amt; }
  }
  return out;
}

/* ================================== WRITERS ================================== */

function _misTab(mis, name) {
  var sh = mis.getSheetByName(name);
  if (!sh) { sh = mis.insertSheet(name); }
  else {
    // clear() leaves merged ranges behind, and re-merging a merged range throws.
    try { sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart(); } catch (e) {}
    sh.clear();
    try { sh.clearConditionalFormatRules(); } catch (e) {}
  }
  sh.setHiddenGridlines(true);
  return sh;
}

function _misBand(sh, row, cols, text, bg, size) {
  sh.getRange(row, 1, 1, cols).merge().setValue('  ' + text)
    .setBackground(bg).setFontColor('#FFFFFF').setFontFamily('Arial')
    .setFontSize(size || 11).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(row, size && size > 11 ? 26 : 20);
}

function _misHdr(sh, row, labels) {
  sh.getRange(row, 1, 1, labels.length).setValues([labels])
    .setBackground(C_NAVY).setFontColor('#FFFFFF').setFontFamily('Arial')
    .setFontWeight('bold').setFontSize(9).setWrap(true)
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setRowHeight(row, 30);
}

function _misNote(sh, row, col, text) {
  sh.getRange(row, col).setValue(text).setFontFamily('Arial').setFontSize(9)
    .setFontStyle('italic').setFontColor(C_MUTED);
}

/* ---------- Control ---------- */
function _misWriteCostViewAll(mis, d) {
  var sh = _misTab(mis, MIS.costAll);
  var W = [26, 232, 160, 52, 44, 78, 78, 76, 54, 84, 96, 92, 92, 104, 78, 88, 68, 62];
  W.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  _misBand(sh, 1, 18, 'CURRENT COST VIEW — all vendors, all contracts  ·  '
    + MIS_EXCLUDE_ORACLES.join('/') + ' excluded  ·  incl. zonal  ·  as at '
    + Utilities.formatDate(new Date(), _tz(), MIS_TZ_FMT), C_NAVY, 14);
  _misHdr(sh, 3, ['', 'Contract', 'Vendor', 'Size', 'Veh', 'Slab KM', 'Reg KM', 'Excess KM', 'Rate',
                  'Excess ₹', 'Fixed ₹', 'Adhoc ₹', 'Zonal ₹', 'TOTAL ₹', 'Pending KM',
                  'Projected KM', 'Proj %', 'Gate']);

  var oracles = Object.keys(d.byOracle).sort();
  var rowsOut = [], meta = [];
  oracles.forEach(function (o) {
    var m = buildBillingModel(o, d);
    m.contracts.forEach(function (c) {
      var gateOk = (c.nvehCV === c.nvehCI) && Math.abs(c.slabCV - c.slabCI) < 0.5
                   && Math.abs(c.fixedCV - c.fixedCI) < 0.5;
      rowsOut.push(['', c.cid, m.vendorName, c.size, c.nvehCV, c.slabCV, c.regKm, null, c.exRate,
                    null, c.fixedCV, c.adhocAmt, 0, null, c.pendKm, Math.round(c.projKm),
                    c.projPct / 100, gateOk ? 'CLEAR' : 'BLOCK']);
      meta.push(gateOk);
    });
    /* Zonal is priced per trip and belongs to the VENDOR, not to any one contract, so it gets its own
       row. Live SUMIFS/COUNTIFS against the Zonal paste tab, so a later paste updates this page and its
       grand total without re-running Generate. */
    if (m.bucket && m.bucket.adhocAmt) {
      rowsOut.push(['', 'Other adhoc (no contract)', m.vendorName, '—', '', 0, 0, null, 0,
                    null, 0, m.bucket.adhocAmt, 0, null, 0, 0, 0, 'n/a']);
      meta.push(true);
    }
    /* Zonal comes from Trip_Level now, so this is a computed value rather than a SUMIFS against the
       paste tab. One row per vendor: zonal is priced per trip and belongs to the vendor, not to any
       single contract's slab. */
    if (m.totals.zonal) {
      rowsOut.push(['', 'Zonal trips — fixed per trip (RFQ)', m.vendorName, '—', m.totals.zonalTrips,
                    0, 0, null, 0, null, 0, 0, m.totals.zonal, null, 0, 0, 0, 'n/a']);
      meta.push(true);
    }
  });
  rowsOut.sort(function (a, b) { return String(a[1]) < String(b[1]) ? -1 : 1; });

  var r = 4, first = r;
  if (!rowsOut.length) { _misNote(sh, r, 2, 'no contracts found'); return; }
  sh.getRange(r, 1, rowsOut.length, 18).setValues(rowsOut).setFontFamily('Arial').setFontSize(10);
  for (var i = 0; i < rowsOut.length; i++) {
    var rr = r + i;
    sh.getRange(rr, 8).setFormula('=MAX(0,G' + rr + '-F' + rr + ')');
    sh.getRange(rr, 10).setFormula('=H' + rr + '*I' + rr);
    sh.getRange(rr, 14).setFormula('=J' + rr + '+K' + rr + '+L' + rr + '+M' + rr).setFontWeight('bold');
    var g = sh.getRange(rr, 18).setHorizontalAlignment('center').setFontWeight('bold').setFontSize(9);
    if (rowsOut[i][17] === 'CLEAR')     g.setBackground(C_GREEN).setFontColor('#006100');
    else if (rowsOut[i][17] === 'n/a')  g.setBackground(C_GREY).setFontColor(C_MUTED);
    else                                g.setBackground(C_RED).setFontColor('#9C0006');
  }
  r += rowsOut.length;
  var last = r - 1;
  sh.getRange(r, 2).setValue('GRAND TOTAL').setFontSize(12).setFontWeight('bold');
  [6, 7, 8, 10, 11, 12, 13, 14, 15, 16].forEach(function (col) {
    var L = String.fromCharCode(64 + col);
    sh.getRange(r, col).setFormula('=SUM(' + L + first + ':' + L + last + ')')
      .setFontSize(12).setFontWeight('bold')
      .setNumberFormat((col === 6 || col === 7 || col === 8 || col === 15 || col === 16) ? FMT_KM : FMT_MONEY);
  });
  sh.getRange(r, 2, 1, 17).setBackground(C_GREEN);
  r += 2;
  sh.getRange(r, 2, 1, 16).merge().setValue('Contracts marked BLOCK must be reconciled before billing — '
    + 'Contract_Info disagrees with Contract_Vehicles. Their TOTAL above uses the Contract_Vehicles figures, '
    + 'which is what the Vercel panel shows today.')
    .setWrap(true).setFontSize(9).setFontStyle('italic').setFontColor(C_MUTED);
  sh.setRowHeight(r, 28);

  sh.getRange(first, 6, last - first + 1, 3).setNumberFormat(FMT_KM);
  sh.getRange(first, 9, last - first + 1, 1).setNumberFormat('0.00');
  sh.getRange(first, 10, last - first + 1, 5).setNumberFormat(FMT_MONEY);
  sh.getRange(first, 15, last - first + 1, 2).setNumberFormat(FMT_KM);
  sh.getRange(first, 17, last - first + 1, 1).setNumberFormat(FMT_PCT);
  sh.setFrozenRows(3);
}

/* ---------- Validation_Gates (all vendors) ---------- */
function _misWriteGates(mis, d) {
  var sh = _misTab(mis, MIS.gates);
  var W = [26, 220, 66, 110, 56, 116, 116, 56, 112, 130, 56, 88];
  W.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  _misBand(sh, 1, 12, 'VALIDATION GATES — Contract_Vehicles vs Contract_Info  ·  '
    + 'a contract is a culmination of both, so they must agree before anyone bills', C_NAVY, 14);
  _misHdr(sh, 3, ['', 'Contract', 'CV rows', 'CI no_of_vehicles', 'match?', 'Σ pegged_km_slab',
                  'CI total_km_slab', 'match?', 'Σ monthly_rate', 'CI fixed_monthly_value',
                  'match?', 'Verdict']);

  var cids = Object.keys(d.info).sort();
  var r = 4, first = r;
  cids.forEach(function (cid) {
    var c = d.info[cid], defs = d.vehs[cid] || [];
    var slab = 0, fixed = 0;
    defs.forEach(function (v) { slab += _num(v.pegged_km_slab); fixed += _num(v.monthly_rate); });
    sh.getRange(r, 2, 1, 3).setValues([[cid, defs.length, _num(c.no_of_vehicles)]]);
    sh.getRange(r, 6, 1, 2).setValues([[slab, _num(c.total_km_slab)]]);
    sh.getRange(r, 9, 1, 2).setValues([[fixed, _num(c.fixed_monthly_value)]]);
    sh.getRange(r, 5).setFormula('=IF(C' + r + '=D' + r + ',"ok","XX")').setHorizontalAlignment('center');
    sh.getRange(r, 8).setFormula('=IF(ROUND(F' + r + ',2)=ROUND(G' + r + ',2),"ok","XX")').setHorizontalAlignment('center');
    sh.getRange(r, 11).setFormula('=IF(ROUND(I' + r + ',2)=ROUND(J' + r + ',2),"ok","XX")').setHorizontalAlignment('center');
    sh.getRange(r, 12).setFormula('=IF(COUNTIF(E' + r + ':K' + r + ',"XX")>0,"BLOCK","clear")')
      .setHorizontalAlignment('center').setFontWeight('bold');
    var ok = defs.length === _num(c.no_of_vehicles)
             && Math.abs(slab - _num(c.total_km_slab)) < 0.5
             && Math.abs(fixed - _num(c.fixed_monthly_value)) < 0.5;
    sh.getRange(r, 12).setBackground(ok ? C_GREEN : C_RED).setFontColor(ok ? '#006100' : '#9C0006');
    r++;
  });
  var last = r - 1;
  sh.getRange(first, 6, last - first + 1, 2).setNumberFormat(FMT_KM);
  sh.getRange(first, 9, last - first + 1, 2).setNumberFormat(FMT_MONEY);
  sh.getRange(1, 1, r, 12).setFontFamily('Arial');
  r += 1;
  _misNote(sh, r, 2, 'A non-numeric value in pegged_km_slab or monthly_rate reads as 0 and will show here as a '
    + 'mismatch — check the cell contents, not just the total.');
  sh.setFrozenRows(3);
}

/* ---------- Exceptions (all vendors) ---------- */
function _misWriteExceptions(mis, d) {
  var sh = _misTab(mis, MIS.exceptions);
  var W = [26, 150, 220, 116, 130, 46, 66, 96, 300];
  W.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  _misBand(sh, 1, 9, 'EXCEPTIONS — review before issuing a vendor MIS. '
    + 'None of these lose KM from a contract slab; they put it on the wrong vehicle or the wrong contract.',
    C_NAVY, 14);

  var oracles = Object.keys(d.byOracle).sort();
  var unattr = [], nearMiss = [], leakage = [], idle = [], oop = [];
  oracles.forEach(function (o) {
    var m = buildBillingModel(o, d);
    m.contracts.forEach(function (c) {
      c.unattr.forEach(function (u) {
        unattr.push(['', u.id, c.cid, u.no, u.foldTo || '— blank —', u.km, u.status, '',
                     'KM counted in the slab but on no vehicle row']);
      });
      c.nearMiss.forEach(function (x) {
        var folds = Object.keys(x.folds).join(', ');
        var row = ['', '', c.cid, x.no, x.nearest, x.km, x.ed, x.trips, ''];
        if (x.homeOf) {
          row[8] = 'CROSS-CONTRACT: this plate is a real default of ' + x.homeOf
                 + ' — engine attribution, not a typo. Do NOT map it to the look-alike.';
          leakage.push(row);
        } else {
          row[8] = 'Look-alike plate. Folds to: ' + (folds || '— none —')
                 + (folds === x.nearest ? '  (matches the look-alike, so KM lands right)'
                                        : '  (differs from the look-alike — KM is on another vehicle)');
          nearMiss.push(row);
        }
      });
      (c.outOfPeriod || []).forEach(function (u) {
        oop.push(['', u.id, c.cid, u.no, u.date, u.km, '', '',
                  'trip_date is outside the contract window ' + c.duration
                  + ' — still billed to this contract, because contract_id scopes the bill']);
      });
      c.vehicles.forEach(function (v) {
        if (v.trips === 0) idle.push(['', '', c.cid, v.no, '', 0, '', 0,
          'Contracted and billed (' + v.slab + ' pegged km, ₹' + v.rate
          + ') but ran no trip under its own plate']);
      });
    });
  });

  var r = 3;
  r = _misExcBlock(sh, r, 'A · Regular trip on a non-default vehicle with no valid fold target — '
    + 'KM is in the slab, absent from the vehicle breakdown',
    ['', 'trip_id', 'Contract', 'Vehicle', 'foldTo', 'KM', 'Status', '', 'Impact'], unattr, C_RED);
  r = _misExcBlock(sh, r, 'B · Cross-contract plates — the vehicle is a real default of ANOTHER contract. '
    + 'This is an engine-attribution problem: the KM is on the wrong contract, so the wrong slab.',
    ['', '', 'Contract it ran on', 'Vehicle', 'Look-alike here', 'KM', 'Edit dist', 'Trips', 'Detail'],
    leakage, C_RED);
  r = _misExcBlock(sh, r, 'C · Look-alike plates within edit distance ' + MIS_NEAR_MISS_ED
    + ' of a default — report only, NEVER auto-corrected (several contracts hold two genuine '
    + 'defaults this close, so a fuzzy rule would move real KM onto the wrong real vehicle)',
    ['', '', 'Contract', 'Vehicle', 'Nearest default', 'KM', 'Edit dist', 'Trips', 'Detail'],
    nearMiss, C_AMBER);
  r = _misExcBlock(sh, r, 'D · Contracted vehicles that ran zero trips under their own plate',
    ['', '', 'Contract', 'Vehicle', '', '', '', 'Trips', 'Detail'], idle, C_AMBER);
  r = _misExcBlock(sh, r, 'E · Trips dated outside their own contract window — billed anyway, '
    + 'because contract_id is what scopes the bill. Flagged so a mis-tagged trip cannot hide.',
    ['', 'trip_id', 'Contract', 'Vehicle', 'trip_date', 'KM', '', '', 'Detail'], oop, C_AMBER);

  sh.getRange(1, 1, Math.max(r, 2), 9).setFontFamily('Arial');
}

function _misExcBlock(sh, r, title, hdrs, rows, tint) {
  _misBand(sh, r, 9, title, C_PURPLE); sh.setRowHeight(r, 32);
  sh.getRange(r, 1, 1, 9).setWrap(true); r++;
  _misHdr(sh, r, hdrs); r++;
  if (!rows.length) {
    sh.getRange(r, 2).setValue('none — clear').setFontSize(10)
      .setFontWeight('bold').setFontColor('#006100').setBackground(C_GREEN);
    return r + 3;
  }
  sh.getRange(r, 1, rows.length, 9).setValues(rows).setFontSize(10).setWrap(true);
  sh.getRange(r, 6, rows.length, 1).setNumberFormat(FMT_KM);
  sh.getRange(r, 2, rows.length, 8).setBackground(tint);
  r += rows.length;
  sh.getRange(r, 5).setValue('TOTAL').setFontWeight('bold');
  sh.getRange(r, 6).setFormula('=SUM(F' + (r - rows.length) + ':F' + (r - 1) + ')')
    .setFontWeight('bold').setNumberFormat(FMT_KM);
  return r + 3;
}
