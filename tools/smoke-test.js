#!/usr/bin/env node
/**
 * Lightweight contract smoke test for the HMG Attendance frontend's two
 * backends (the Cloudflare write-bridge Worker, and the isolated Apps
 * Script backend it partly proxies). Checks response SHAPE only - the
 * right keys, the right types - never business-logic correctness, so a
 * future contract drift (either side changing what it sends/expects)
 * is caught immediately as a named failure instead of surfacing to a
 * real user as an unexplained "Unexpected backend response".
 *
 * Safe by default: only calls READ-ONLY actions (getDataSyncStatus,
 * discoverGroups). Requires no token, touches no data, safe to run any
 * time, including against real production data.
 *
 * Usage:
 *   node tools/smoke-test.js
 *
 * Requires Node 18+ (built-in fetch). No dependencies, no package.json -
 * deliberately just one script, not a framework.
 */
'use strict';

var WORKER = 'https://hmg-write-bridge-poc.fieldmedicine1.workers.dev/';
var ISOLATED_BACKEND = 'https://script.google.com/macros/s/AKfycbxcVYWRoQRe429lHHZsReYvJ3qVmD-EAK2WdWtY51iXxX0YOuW1-FqlAfd-1-AjdSpD/exec';
var ORIGIN = 'https://fieldmedicine-hmg.github.io';

async function callWorker(action, extra) {
  var res = await fetch(WORKER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN },
    body: JSON.stringify(Object.assign({ action: action }, extra || {})),
  });
  return { httpStatus: res.status, data: await res.json() };
}

// discoverGroups (and getData) are GET/JSONP against the isolated
// backend directly - the same call the browser's own <script src>
// mechanism makes, just unwrapped here without a DOM.
async function callIsolatedBackendJsonp(action, params) {
  var qs = new URLSearchParams(Object.assign({ callback: 'cb', action: action }, params || {}));
  var res = await fetch(ISOLATED_BACKEND + '?' + qs.toString());
  var text = await res.text();
  var match = /^cb\((.*)\);?$/.exec(text.trim());
  if (!match) throw new Error('Response was not JSONP-wrapped (contract break or an HTML error page) - first 200 chars: ' + text.slice(0, 200));
  return { httpStatus: res.status, data: JSON.parse(match[1]) };
}

var failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('PASS  ' + name);
  } else {
    failures++;
    console.log('FAIL  ' + name + (detail ? ' - ' + detail : ''));
  }
}
function hasKeys(obj, keys) {
  var missing = keys.filter(function (k) { return !(k in obj); });
  return { ok: missing.length === 0, missing: missing };
}

async function main() {
  console.log('HMG Attendance - contract smoke test\n');

  // ---- getDataSyncStatus (Worker -> production Apps Script) ----
  try {
    var r1 = await callWorker('getDataSyncStatus', {});
    check('getDataSyncStatus: HTTP 200', r1.httpStatus === 200, 'got ' + r1.httpStatus);
    check('getDataSyncStatus: has "ok"', typeof r1.data.ok === 'boolean');
    if (r1.data.ok) {
      var shape1 = hasKeys(r1.data, ['rawRowCount', 'lastRefreshAt']);
      check('getDataSyncStatus: ok=true shape', shape1.ok, 'missing ' + shape1.missing.join(', '));
      check('getDataSyncStatus: rawRowCount is a number', typeof r1.data.rawRowCount === 'number');
    } else {
      console.log('  (getDataSyncStatus returned ok:false - error: ' + r1.data.error + ' - not a shape failure, just reported)');
    }
  } catch (e) {
    failures++;
    console.log('FAIL  getDataSyncStatus: threw - ' + e.message);
  }

  // ---- discoverGroups (isolated backend, direct JSONP GET) ----
  try {
    var today = new Date().toISOString().slice(0, 10);
    var r2 = await callIsolatedBackendJsonp('discoverGroups', { reviewDate: today });
    check('discoverGroups: HTTP 200', r2.httpStatus === 200, 'got ' + r2.httpStatus);
    check('discoverGroups: has "ok"', typeof r2.data.ok === 'boolean');
    if (r2.data.ok) {
      var shape2 = hasKeys(r2.data, ['reviewDate', 'cards']);
      check('discoverGroups: ok=true shape', shape2.ok, 'missing ' + shape2.missing.join(', '));
      check('discoverGroups: cards is an array', Array.isArray(r2.data.cards));
      if (Array.isArray(r2.data.cards) && r2.data.cards.length) {
        var cardShape = hasKeys(r2.data.cards[0], ['reviewType', 'zone', 'count', 'assignmentId', 'status', 'reviewer']);
        check('discoverGroups: card shape', cardShape.ok, 'missing ' + cardShape.missing.join(', '));
      }
    } else {
      console.log('  (discoverGroups returned ok:false - error: ' + r2.data.error + ' - not a shape failure, just reported)');
    }
  } catch (e) {
    failures++;
    console.log('FAIL  discoverGroups: threw - ' + e.message);
  }

  console.log('\n' + (failures === 0 ? 'ALL CONTRACT CHECKS PASSED' : failures + ' CONTRACT CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main();
