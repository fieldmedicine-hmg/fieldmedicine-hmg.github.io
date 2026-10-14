// Zone Operations (Phase 6, 2026-10-14): daily staffing targets, staffing / working-hours compliance dashboard,
// every manager's individual opinion, supplementary attendance, and DRAFT / FINAL daily Zone reports (PDF + XLSX).
// Uses the SAME per-person Analytics credential as Period Analytics: the device enrolled there (localStorage, same
// site) or an admin access link. Every request goes through the Worker's allow-listed periodAnalytics action with
// op=...; the server re-checks the credential on every call. Loaded BEFORE control.js (which strips ?adminToken).
(function () {
  'use strict';
  var WRITE_BRIDGE = 'https://hmg-write-bridge-poc.fieldmedicine1.workers.dev/';
  var TIMEOUT_MS = 330000;
  var ADMIN_TOKEN = new URLSearchParams(location.search).get('adminToken') || '';
  function credential() {
    if (ADMIN_TOKEN) return { kind: 'admin', value: ADMIN_TOKEN };
    var dev = '';
    try { dev = localStorage.getItem('hmgAnalyticsDeviceToken') || ''; } catch (e) { dev = ''; }
    return dev ? { kind: 'device', value: dev } : null;
  }
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function msg(text, isError) { var m = $('zoStatus'); m.textContent = text || ''; m.className = isError ? 'meta report-error' : 'meta'; }
  function todayRiyadh() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()); }

  function call(op, extra) {
    var cred = credential();
    if (!cred) return Promise.resolve({ ok: false, error: 'Access required - enroll this device in Period Analytics first.' });
    var d = $('zoDate').value;
    // the Worker validates fromDate/toDate on this action (measured on production), so every operation carries them
    var body = Object.assign({ action: cred.kind === 'admin' ? 'periodAnalytics' : 'periodAnalyticsViaDevice', op: op, date: d, fromDate: d, toDate: d }, extra || {});
    if (cred.kind === 'admin') body.adminToken = cred.value; else body.deviceToken = cred.value;
    return window.HMGNet.postJson(WRITE_BRIDGE, body, { timeoutMs: TIMEOUT_MS }).then(function (r) { return r || { ok: false, error: 'Empty response.' }; },
      function (e) { return { ok: false, error: 'Network error: ' + (e && e.message ? e.message : 'request failed') + ' - nothing was changed; try again.' }; });
  }
  function download(bytes, name, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
  }
  function b64ToBytes(b64) { var bin = atob(b64), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function staffText(x) {
    if (!x) return '—';
    var d = x.diff === null || x.diff === undefined ? '' : (x.diff > 0 ? ' (+' + x.diff + ')' : (x.diff < 0 ? ' (' + x.diff + ')' : ''));
    return (x.required === null || x.required === undefined ? '—' : x.required) + ' / ' + x.approved + (x.unresolved ? ' +' + x.unresolved + '?' : '') + ' ' + x.status + d;
  }
  function staffCell(x) { var td = el('td'); td.appendChild(el('span', 'st-' + (x ? x.status : 'NO_TARGET'), staffText(x))); return td; }

  var last = null;
  function busy(on) { ['zoLoadBtn', 'zoSaveBtn', 'zoCopyPrevBtn', 'zoAllReportBtn', 'zoAllExcelBtn', 'zoSuppSubmitBtn'].forEach(function (id) { if ($(id)) $(id).disabled = !!on; }); }

  // ---------------- dashboard ----------------
  function load() {
    if (!$('zoDate').value) { msg('Choose the operational date.', true); return; }
    busy(true); msg('Loading zones, targets and compliance…');
    call('zoneOpsLoad').then(function (res) {
      busy(false);
      if (!res.ok) { msg('Error: ' + res.error, true); return; }
      last = res;
      render(res);
      msg('Loaded ' + res.zones.length + ' zone(s) for ' + res.date + ' (Asia/Riyadh, generated ' + res.generatedAt + ').' + (res.unmappedRecords ? ' ' + res.unmappedRecords + ' attendance record(s) are in Unmapped areas and belong to no zone.' : ''));
    });
  }
  function render(res) {
    var host = $('zoHost'); clear(host); clear($('zoDetail'));
    var wrap = el('div', 'table-scroll'), t = el('table', 'data-table zo-table');
    var hr = el('tr');
    ['Zone', 'Mode / Policy', 'Managers', 'Target: Morning', 'Night', 'Daily / Total', 'Previous day', 'Morning (req / appr)', 'Night (req / appr)', 'Daily total (req / appr)',
      'Unique HC', 'Hours unmatched', 'Pending / unresolved', 'Disagree', 'Report', 'Actions'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    var thead = el('thead'); thead.appendChild(hr); t.appendChild(thead);
    var tb = el('tbody');
    res.zones.forEach(function (z) {
      var c = z.content, tr = el('tr'), mode = c.config.mode;
      tr.appendChild(el('td', null, c.zone + (c.city ? ' · ' + c.city : '')));
      tr.appendChild(el('td', null, mode + ' / ' + c.config.policy + (c.config.errors.length ? ' ⚠' : '')));
      tr.appendChild(el('td', null, c.managers.length ? c.managers.map(function (m) { return m.name + ' (' + m.role + ')'; }).join(', ') : (c.managerError ? '⚠ ' + c.managerError : 'single reviewer')));
      var final = z.report.status === 'FINAL';
      function input(key, val, enabled) {
        var td = el('td'), i = el('input'); i.type = 'number'; i.min = '0'; i.max = '9999'; i.step = '1';
        i.value = val === null || val === undefined ? '' : val; i.disabled = !enabled || final; i.setAttribute('data-zone', c.zoneId); i.setAttribute('data-key', key);
        i.setAttribute('aria-label', c.zone + ' ' + key + ' target');
        i.addEventListener('input', function () { updateTotal(c.zoneId); });
        td.appendChild(i); return td;
      }
      var tg = c.target || {};
      tr.appendChild(input('morning', tg.morning, mode === 'MORNING_NIGHT'));
      tr.appendChild(input('night', tg.night, mode === 'MORNING_NIGHT'));
      if (mode === 'MORNING_NIGHT') { var tt = el('td', null, tg.total === null || tg.total === undefined ? '—' : tg.total); tt.setAttribute('data-total', c.zoneId); tr.appendChild(tt); }
      else tr.appendChild(input('daily', tg.daily, mode === 'SINGLE' || mode === 'FLEXIBLE'));
      var pt = z.previousTarget;
      tr.appendChild(el('td', 'meta', pt ? (pt.mode === 'MORNING_NIGHT' ? pt.morning + ' + ' + pt.night : pt.daily) : '—'));
      tr.appendChild(mode === 'MORNING_NIGHT' ? staffCell(c.staffing.morning) : el('td', null, '—'));
      tr.appendChild(mode === 'MORNING_NIGHT' ? staffCell(c.staffing.night) : el('td', null, '—'));
      tr.appendChild(staffCell(c.staffing.total));
      tr.appendChild(el('td', null, c.staffing.uniqueHeadcount));
      tr.appendChild(el('td', null, c.counts.hoursUnmatched));
      tr.appendChild(el('td', null, c.counts.pending + c.counts.notReviewed + c.counts.unresolved));
      tr.appendChild(el('td', null, c.counts.disagreements));
      tr.appendChild(el('td', null, final ? 'FINAL v' + z.report.version + (z.report.liveChanged ? ' (live data changed since)' : '') + (z.report.integrityOk === false ? ' ⚠ INTEGRITY' : '') : 'DRAFT'));
      var act = el('td', 'zo-actions');
      function btn(label, cls, fn) { var b = el('button', cls, label); b.addEventListener('click', function () { fn(b); }); act.appendChild(b); }
      btn('Details', 'btn-secondary', function () { showDetail(z); });
      btn('PDF + Excel', 'btn-secondary', function (b) { report(c.zone, true, b); });
      btn('Excel', 'btn-secondary', function (b) { report(c.zone, false, b); });
      if (!final) btn('Finalize', 'btn-primary', function () { askFinalize(z); });
      tr.appendChild(act);
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); host.appendChild(wrap);
    host.appendChild(el('div', 'meta', 'Required / approved per shift. "+n?" = records still pending or unresolved (never counted as absent). Unique HC = unique approved employees; see a zone\'s Details for how shift coverage is counted. Targets are editable until the zone report is FINAL. Zone modes, shift times, required hours, policy and managers are set in the Zone_Configuration and Zone_Manager_Assignments sheets.'));
    renderSupplements(res);
  }
  function updateTotal(zoneId) {
    var m = document.querySelector('input[data-zone="' + zoneId + '"][data-key="morning"]'), n = document.querySelector('input[data-zone="' + zoneId + '"][data-key="night"]');
    var cell = document.querySelector('[data-total="' + zoneId + '"]');
    if (!cell || !m || !n) return;
    cell.textContent = m.value !== '' && n.value !== '' ? String(Number(m.value) + Number(n.value)) : '—';
  }
  function saveTargets() {
    if (!last) return;
    var list = [];
    last.zones.forEach(function (z) {
      var get = function (k) { var i = document.querySelector('input[data-zone="' + z.zoneId + '"][data-key="' + k + '"]'); return i && !i.disabled ? i.value : null; };
      var mode = z.content.config.mode;
      if (mode === 'MORNING_NIGHT') { var m = get('morning'), n = get('night'); if (m !== null && n !== null && (m !== '' || n !== '')) list.push({ zoneId: z.zoneId, morning: m, night: n }); }
      else if (mode === 'SINGLE' || mode === 'FLEXIBLE') { var d = get('daily'); if (d !== null && d !== '') list.push({ zoneId: z.zoneId, daily: d }); }
    });
    if (!list.length) { msg('Enter at least one target first.', true); return; }
    busy(true); msg('Saving ' + list.length + ' zone target(s)…');
    call('zoneTargetsSave', { targets: JSON.stringify(list) }).then(function (res) {
      busy(false);
      var saved = (res.results || []).filter(function (r) { return r.ok && !r.unchanged; }).length, same = (res.results || []).filter(function (r) { return r.unchanged; }).length;
      if (!res.ok) { msg('Some targets were not saved: ' + res.error + (saved ? ' (' + saved + ' saved)' : ''), true); }
      else msg('Saved ' + saved + ' target(s)' + (same ? ', ' + same + ' unchanged' : '') + '. Reloading…');
      load();
    });
  }
  function copyPrevious() {
    busy(true); msg('Copying the previous day\'s targets…');
    call('zoneTargetsCopyPrevious', { overwrite: 'false' }).then(function (res) {
      busy(false);
      if (!res.ok) { msg('Error: ' + res.error, true); return; }
      msg((res.message || ('Copied ' + res.copied + ' zone target(s)' + (res.skipped ? ', ' + res.skipped + ' skipped (already set)' : ''))) + ' Reloading…');
      load();
    });
  }

  // ---------------- details: employees, hours, every manager's opinion, conflicts ----------------
  function showDetail(z) {
    var c = z.content, host = $('zoDetail'); clear(host);
    var box = el('div', 'control-card zo-detail');
    box.appendChild(el('div', 'group-title', c.zone + ' — ' + c.date + ' (' + (z.report.status === 'FINAL' ? 'FINAL v' + z.report.version : 'DRAFT') + ')'));
    box.appendChild(el('div', 'meta', 'Mode ' + c.config.mode + ' · policy ' + c.config.policy + ' · hours tolerance ±' + c.config.toleranceMin + ' min · ' + c.config.shifts.map(function (s) { return s.name + ' ' + (s.start || '') + (s.end ? '-' + s.end : '') + ' req ' + (s.requiredHours || '—'); }).join(' · ')));
    box.appendChild(el('div', 'meta', c.staffing.note));
    if (c.config.errors.length) box.appendChild(el('div', 'notice', 'Configuration: ' + c.config.errors.join('; ')));
    if (c.blockers.length && z.report.status !== 'FINAL') box.appendChild(el('div', 'notice', 'Not ready to finalize: ' + c.blockers.join(' · ')));
    var wrap = el('div', 'table-scroll'), t = el('table', 'data-table');
    var hr = el('tr');
    ['Employee', 'Code', 'Shift', 'Original in / out', 'Approved in / out', 'Actual', 'Required', 'Var.', 'Hours', 'Approval', 'Manager decisions (in order)', 'Agreement', 'Exceptions', ''].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    t.appendChild(hr);
    c.employees.forEach(function (e) {
      var tr = el('tr');
      [e.name + (e.source !== 'BIOMETRIC' ? ' [' + e.source + ']' : ''), e.code, e.shift, (e.originalIn || '—') + ' → ' + (e.originalOut || '—'), (e.approvedIn || '—') + ' → ' + (e.approvedOut || '—') + (e.timeSource !== 'ORIGINAL' ? ' (' + e.timeSource + ')' : ''),
        e.actualHours || '—', e.requiredHours || '—', e.varianceHours || '', e.hoursStatus, e.approvalState + (e.officialDecision ? ' / ' + e.officialDecision : '')].forEach(function (v, i) {
        var td = el('td', i === 8 ? 'st-' + e.hoursStatus : null, v); tr.appendChild(td);
      });
      var op = el('td');
      if (!e.opinions.length) op.textContent = '—';
      e.opinions.forEach(function (o, i) { op.appendChild(el('div', null, (i + 1) + '. ' + o.name + (o.managerId ? ' [' + o.managerId + ']' : '') + ' (' + o.role + '): ' + o.decision + (o.comment ? ' — ' + o.comment : '') + (o.decidedAt ? ' · ' + o.decidedAt : ''))); });
      tr.appendChild(op);
      tr.appendChild(el('td', e.agreement === 'DISAGREE' ? 'st-UNMATCHED' : null, e.agreement));
      tr.appendChild(el('td', 'meta', e.exceptions.join(' | ')));
      var act = el('td');
      var resolvable = z.report.status !== 'FINAL' && (e.approvalState === 'UNRESOLVED' || (e.source !== 'BIOMETRIC' && ['NONE', 'COMPLETED', 'EXPIRED', 'REVOKED'].indexOf(e.linkState) !== -1 && ['PENDING', 'NOT_SENT', 'NOT_REVIEWED'].indexOf(e.approvalState) !== -1));
      if (resolvable) { var rb = el('button', 'btn-secondary', 'Resolve…'); rb.addEventListener('click', function () { resolveForm(act, c, e); }); act.appendChild(rb); }
      tr.appendChild(act);
      t.appendChild(tr);
    });
    wrap.appendChild(t); box.appendChild(wrap);
    host.appendChild(box);
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function resolveForm(host, c, e) {
    clear(host);
    var panel = el('div', 'confirm-box');
    panel.appendChild(el('div', null, 'Authorized resolution for ' + e.name + ' (recorded with your name; every manager opinion is kept).'));
    var sel = el('select'); ['APPROVED', 'MODIFIED', 'REJECTED'].forEach(function (d) { var o = el('option', null, d); o.value = d; sel.appendChild(o); });
    var reason = el('input'); reason.type = 'text'; reason.placeholder = 'Reason (required)'; reason.maxLength = 400;
    var go = el('button', 'btn-primary', 'Record resolution');
    go.addEventListener('click', function () {
      if (reason.value.trim().length < 5) { reason.focus(); return; }
      go.disabled = true;
      call('conflictResolve', { zone: c.zone, employeeCode: e.code, decision: sel.value, reason: reason.value.trim() }).then(function (res) {
        if (!res.ok) { go.disabled = false; panel.appendChild(el('div', 'report-error', 'Error: ' + res.error)); return; }
        msg('Resolution recorded (official: ' + res.official + '). Reloading…'); load();
      });
    });
    [sel, reason, go].forEach(function (n) { panel.appendChild(n); });
    host.appendChild(panel);
  }

  // ---------------- reports ----------------
  function report(zone, withPdf, btn) {
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
    msg('Generating the ' + (zone ? zone : 'All-Zones') + ' report' + (withPdf ? ' (PDF + Excel from one snapshot)' : '') + '…');
    call('zoneReport', { zone: zone || '', pdf: withPdf ? 'true' : 'false' }).then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = label; }
      if (!res.ok) { msg('Error: ' + res.error, true); return; }
      try {
        download(window.HMGXlsx.build(window.HMGZoneOpsExport.workbookSheets(res)), window.HMGZoneOpsExport.fileName(res), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        if (withPdf && res.pdfBase64) download(b64ToBytes(res.pdfBase64), res.pdfFileName, 'application/pdf');
        msg('Report ' + (res.allFinal ? 'FINAL' : 'DRAFT') + ' downloaded (snapshot ' + String(res.bundleHash).slice(0, 12) + ', generated ' + res.generatedAt + ').');
      } catch (err) { msg('Could not build the file: ' + (err && err.message ? err.message : err), true); }
    });
  }
  function askFinalize(z) {
    var host = $('zoDetail'); clear(host);
    var panel = el('div', 'confirm-box');
    panel.appendChild(el('div', 'group-title', 'Finalize the ' + z.zone + ' report for ' + last.date + '?'));
    panel.appendChild(el('div', 'meta', 'A FINAL report is stored as an immutable snapshot and is never changed afterwards. The server refuses if approvals, targets or exceptions are still open.'));
    var cancel = el('button', 'btn-secondary', 'Cancel'); cancel.addEventListener('click', function () { clear(host); });
    var go = el('button', 'btn-primary', 'Finalize');
    go.addEventListener('click', function () {
      go.disabled = true; cancel.disabled = true;
      call('zoneReportFinalize', { zone: z.zone }).then(function (res) {
        clear(host);
        if (!res.ok) { var b = el('div', 'notice', 'Not finalized: ' + (res.blockers ? res.blockers.join(' · ') : res.error)); host.appendChild(b); msg('Finalize refused - see the reasons below.', true); return; }
        msg(res.alreadyFinal ? res.message : 'FINAL version ' + res.version + ' stored (snapshot ' + String(res.hash).slice(0, 12) + '). Reloading…');
        load();
      });
    });
    panel.appendChild(cancel); panel.appendChild(go);
    host.appendChild(panel);
  }

  // ---------------- supplementary attendance ----------------
  function renderSupplements(res) {
    var zsel = $('zoSuppZone'); var cur = zsel.value; clear(zsel);
    res.zones.forEach(function (z) { var o = el('option', null, z.zone); o.value = z.zone; zsel.appendChild(o); });
    if (cur) zsel.value = cur;
    var host = $('zoSuppList'); clear(host);
    if (!res.supplements.length) { host.appendChild(el('div', 'meta', 'No supplementary claims for this date.')); return; }
    var t = el('table', 'data-table'), hr = el('tr');
    ['Zone', 'Employee', 'Code', 'Claimed in', 'Claimed out', 'Reason', 'Status', 'Submitted by', 'Verified by', ''].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    t.appendChild(hr);
    res.supplements.forEach(function (s) {
      var tr = el('tr');
      [s.zone, s.name, s.code, s.claimedIn || '—', s.claimedOut || '—', s.reason, s.status, s.submittedBy + ' · ' + s.submittedAt, s.verifiedBy ? s.verifiedBy + ' · ' + s.verifiedAt : '—'].forEach(function (v) { tr.appendChild(el('td', null, v)); });
      var act = el('td');
      if (s.status === 'SUBMITTED') {
        var wb = el('button', 'btn-secondary', 'Withdraw');
        wb.addEventListener('click', function () { wb.disabled = true; call('supplementaryWithdraw', { supplementId: s.supplementId }).then(function (r) { if (!r.ok) { wb.disabled = false; msg('Error: ' + r.error, true); return; } load(); }); });
        act.appendChild(wb);
      }
      tr.appendChild(act);
      t.appendChild(tr);
    });
    var wrap = el('div', 'table-scroll'); wrap.appendChild(t); host.appendChild(wrap);
  }
  function submitSupplement() {
    var p = { zone: $('zoSuppZone').value, employeeCode: $('zoSuppCode').value.trim(), employeeName: $('zoSuppName').value.trim(), designation: $('zoSuppDesig').value,
      shift: $('zoSuppShift').value.trim(), checkin: $('zoSuppIn').value, checkout: $('zoSuppOut').value, checkoutNextDay: $('zoSuppNext').checked ? 'true' : 'false', reason: $('zoSuppReason').value.trim() };
    if (!p.zone || !p.employeeCode || !p.employeeName || !p.reason || (!p.checkin && !p.checkout)) { msg('Zone, employee code and name, at least one time and a reason are required.', true); return; }
    busy(true); msg('Submitting the supplementary claim…');
    call('supplementarySubmit', p).then(function (res) {
      busy(false);
      if (!res.ok) { msg('Error: ' + res.error, true); return; }
      ['zoSuppCode', 'zoSuppName', 'zoSuppShift', 'zoSuppIn', 'zoSuppOut', 'zoSuppReason'].forEach(function (id) { $(id).value = ''; }); $('zoSuppNext').checked = false;
      msg(res.message + ' Reloading…'); load();
    });
  }

  // ---------------- init ----------------
  if (!$('zoneOpsSection')) return;
  $('zoDate').value = todayRiyadh();
  var cred = credential();
  $('zoAccess').textContent = cred ? 'Signed in with your Period Analytics ' + (cred.kind === 'admin' ? 'access link' : 'enrolled device') + '.' : 'Access required: open Period Analytics with your access link and enroll this device once - then this section works here too.';
  ['zoLoadBtn', 'zoSaveBtn', 'zoCopyPrevBtn', 'zoAllReportBtn', 'zoAllExcelBtn', 'zoSuppSubmitBtn'].forEach(function (id) { $(id).disabled = !cred; });
  $('zoLoadBtn').addEventListener('click', load);
  $('zoSaveBtn').addEventListener('click', saveTargets);
  $('zoCopyPrevBtn').addEventListener('click', copyPrevious);
  $('zoAllReportBtn').addEventListener('click', function () { report('', true, $('zoAllReportBtn')); });
  $('zoAllExcelBtn').addEventListener('click', function () { report('', false, $('zoAllExcelBtn')); });
  $('zoSuppSubmitBtn').addEventListener('click', submitSupplement);
  $('zoDate').addEventListener('change', function () { last = null; clear($('zoHost')); clear($('zoDetail')); msg('Press Load for ' + $('zoDate').value + '.'); });
})();
