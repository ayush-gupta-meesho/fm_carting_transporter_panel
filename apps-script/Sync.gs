/**************************************************************************************************
 * VALMO Transporter Panel — Apps Script → Upstash SYNC job  (robust external-access path)
 * ------------------------------------------------------------------------------------------------
 * Add this file to the SAME Apps Script project as Code.gs. It reuses Code.gs's mapping
 * (_buildVendorPayload, _readTab, TABS, _low, _s, _yes) — so keep Code.gs in the project.
 *
 * Why this exists:
 *   Meesho Workspace may block public ("Anyone") web-app deployment, so external transporters
 *   can't reach an Apps Script web app. Instead, this job runs INTERNALLY as you (full Sheet access,
 *   NO service account, NO Sheet sharing) and pushes PRE-SCOPED data into Upstash Redis every ~10 min.
 *   The public Vercel app then reads from Upstash — external emails can log in, the Sheet stays private.
 *
 * What it writes to Upstash:
 *   access:<email>   -> {"oracle","name","role","active"}   (the login/scoping map)
 *   vendor:<oracle>  -> full pre-scoped panel payload (only that oracle's transferred trips)
 *
 * Scope safety: vendor:<oracle> already contains ONLY that oracle's sent_to_vendor rows (G6/G7),
 * and the Vercel /api/data endpoint only reads the oracle embedded in the caller's signed session.
 *
 * SETUP (one-time):
 *   1. Project Settings → Script properties, add:
 *        UPSTASH_URL   = https://<your-db>.upstash.io           (REST URL)
 *        UPSTASH_TOKEN = <your Upstash REST token>
 *   2. Run createSyncTrigger() once (authorize when prompted). Done.
 **************************************************************************************************/

function _upProps() {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('UPSTASH_URL'), tok = p.getProperty('UPSTASH_TOKEN');
  if (!url || !tok) throw new Error('Set UPSTASH_URL and UPSTASH_TOKEN in Script properties first.');
  return { url: url.replace(/\/+$/, ''), tok: tok };
}

/** Run a single Upstash command via the REST API. cmd = ["SET","key","value", ...] */
function _up(cmd) {
  var c = _upProps();
  var res = UrlFetchApp.fetch(c.url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + c.tok },
    payload: JSON.stringify(cmd),
    muteHttpExceptions: true
  });
  var body = res.getContentText();
  var j;
  try { j = JSON.parse(body); } catch (e) { throw new Error('Upstash non-JSON response: ' + body); }
  if (j && j.error) throw new Error('Upstash error: ' + j.error);
  return j ? j.result : null;
}

/** Main sync: writes access map + per-oracle payloads. Call from the trigger (or manually to test). */
function syncToUpstash() {
  var ac = _readTab(TABS.accessControl, 'email');
  var oracles = {};

  ac.forEach(function (r) {
    var email = _low(r.email);
    if (!email) return;
    var active = !(r.active !== undefined && r.active !== '' && !_yes(r.active));
    var rec = {
      oracle: _s(r.vendor_oracle_id),
      name:   _s(r.vendor_name),
      role:   _low(r.role) || 'vendor',
      active: active
    };
    _up(['SET', 'access:' + email, JSON.stringify(rec)]);
    if (rec.role === 'vendor' && rec.active && rec.oracle) oracles[rec.oracle] = true;
  });

  var count = 0;
  Object.keys(oracles).forEach(function (o) {
    var payload = _buildVendorPayload(o);           // reuses Code.gs — already scoped to this oracle
    _up(['SET', 'vendor:' + o, JSON.stringify(payload)]);
    count++;
  });

  // admin all-vendors utilization payload (only if an active admin user exists)
  var hasAdmin = ac.some(function (r) {
    return _low(r.role) === 'admin' && !(r.active !== undefined && r.active !== '' && !_yes(r.active));
  });
  var adminNote = '';
  if (hasAdmin) { _up(['SET', 'admin:all', JSON.stringify(_buildAdminPayload())]); adminNote = ' + admin:all'; }

  var msg = 'Synced ' + ac.length + ' access rows + ' + count + ' vendor payloads' + adminNote + ' at ' + new Date();
  Logger.log(msg);
  return msg;
}

/** Create (or reset) the 10-minute sync trigger, and run one sync immediately. */
function createSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncToUpstash') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncToUpstash').timeBased().everyMinutes(10).create();
  var r = syncToUpstash();
  return 'Trigger created (every 10 min). ' + r;
}

/** Optional: wipe the synced keys (e.g., before a clean re-seed). Uses SCAN-free known prefixes. */
function purgeUpstashVendors() {
  var ac = _readTab(TABS.accessControl, 'email');
  ac.forEach(function (r) {
    var email = _low(r.email); if (email) _up(['DEL', 'access:' + email]);
    var o = _s(r.vendor_oracle_id); if (o) _up(['DEL', 'vendor:' + o]);
  });
  return 'Purged synced keys for ' + ac.length + ' access rows.';
}

/** Stop the automatic 10-min sync (deletes the trigger). Manual "Sync to Upstash NOW" still works. */
function stopSyncTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncToUpstash') { ScriptApp.deleteTrigger(t); n++; }
  });
  return n > 0
    ? 'Auto-sync stopped (' + n + ' trigger removed). Use "Sync to Upstash NOW" for manual pushes.'
    : 'No auto-sync trigger was active.';
}
