// Zone Operations (Phase 6/7, 2026-10-14) - Control Center section.
// Workflow: 1 Access -> 2 Operational Date -> 3 Load zones -> 4 Configure zones & daily targets -> 5 Compliance -> 6 Reports -> 7 Finalize.
// Access uses access.js (the existing access link / enrolled device; validated by the server on every call).
// Every disabled control says WHY it is disabled. Loaded before control.js (which strips ?adminToken from the address bar).
(function () {
  'use strict';
  var A = window.HMGAccess;
  var $ = function (id) { return document.getElementById(id); };
  if (!$('zoneOpsSection') || !A) return;
  var TIMEOUT_MS = 330000;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function msg(text, isError) { var m = $('zoStatus'); m.textContent = text || ''; m.className = isError ? 'meta report-error' : 'meta'; }
  function fmtDay(k) { try { return new Date(k + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch (e) { return k; } }
  function shiftDays(k, n) { var d = new Date(k + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  /** Disables a control AND says why (title + a visible note right under it). */
  function gate(btn, reason) {
    if (!btn) return;
    btn.disabled = !!reason;
    btn.title = reason || '';
    var id = 'why-' + btn.id, note = document.getElementById(id);
    if (reason) {
      if (!note) { note = el('span', 'disabled-reason'); note.id = id; btn.insertAdjacentElement('afterend', note); }
      note.textContent = reason;
    } else if (note) note.remove();
  }
  function opCall(op, extra, timeoutMs) {
    var d = $('zoDate').value;
    var body = Object.assign({ action: 'periodAnalytics', op: op, date: d, fromDate: d, toDate: d }, extra || {});
    return A.call(body, timeoutMs || TIMEOUT_MS);
  }
  function download(bytes, name, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
  }
  function b64ToBytes(b64) { var bin = atob(b64), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  // Report files. A file generated seconds after the click is no longer "user initiated" for the browser, which may silently block
  // the automatic download (pop-up / multiple-download rules). So the file is checked (real PDF / XLSX bytes), an automatic save is
  // attempted, and a "Save ..." link stays under the buttons - clicking it is a user action and always saves the file.
  var reportFiles = {};
  function isPdfBytes(b) { return b && b.length > 1000 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2D; } // %PDF-
  function isXlsxBytes(b) { return b && b.length > 100 && b[0] === 0x50 && b[1] === 0x4B; } // PK (zip)
  function repResult(text, isError) { var m = $('zoRepResult'); if (m) { m.textContent = text || ''; m.className = isError ? 'meta report-error' : 'meta'; } msg(text, isError); }
  function offerFile(kind, bytes, name, type) {
    if (reportFiles[kind]) { URL.revokeObjectURL(reportFiles[kind].url); }
    var url = URL.createObjectURL(new Blob([bytes], { type: type }));
    reportFiles[kind] = { url: url, name: name, size: bytes.length };
    var auto = document.createElement('a');
    auto.href = url; auto.download = name; auto.style.display = 'none';
    document.body.appendChild(auto); auto.click(); auto.remove();
    var box = $('zoRepFiles');
    if (box) {
      clear(box);
      Object.keys(reportFiles).sort().forEach(function (k) {
        var f = reportFiles[k], link = el('a', 'btn-secondary zo-file-link', 'Save ' + f.name + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' KB)');
        link.href = f.url; link.download = f.name; link.setAttribute('data-kind', k);
        box.appendChild(link);
      });
    }
  }
  function staffText(x) {
    if (!x) return '—';
    var d = x.diff === null || x.diff === undefined ? '' : (x.diff < 0 ? ' SHORTAGE ' + (-x.diff) : (x.diff > 0 ? ' EXCESS ' + x.diff : ''));
    return 'Expected ' + (x.required === null || x.required === undefined ? '—' : x.required) + ' · approved ' + x.approved + (x.unresolved ? ' (+' + x.unresolved + ' open)' : '') + ' · ' +
      (x.status === 'PENDING' ? 'PRELIMINARY' : (x.status === 'NO_TARGET' ? 'NO PLAN / بدون خطة' : x.status)) + (x.status === 'UNMATCHED' ? ' —' + d : '');
  }
  function staffCell(x) { var td = el('td'); td.appendChild(el('span', 'st-' + (x ? x.status : 'NO_TARGET'), staffText(x))); return td; }
  /** employee working-hours compliance (separate from the headcount check) */
  function hoursText(emps) {
    if (!emps.length) return 'no records';
    var n = {}; emps.forEach(function (e) { n[e.hoursStatus] = (n[e.hoursStatus] || 0) + 1; });
    return [(n.MATCHED || 0) + ' MATCHED', (n.UNMATCHED || 0) + ' UNMATCHED'].concat(n.NOT_COMPUTABLE ? [n.NOT_COMPUTABLE + ' not computable'] : []).concat(n.NO_REQUIREMENT ? [n.NO_REQUIREMENT + ' pending'] : []).join(' · ');
  }
  /** the Zone Manager's review link, from the records' link states (Final Submit = COMPLETED) */
  function reviewText(c) {
    var n = c.employees.length, st = {};
    if (!n) return 'no records';
    c.employees.forEach(function (e) { var k = String(e.linkState || 'NONE').toUpperCase(); st[k] = (st[k] || 0) + 1; });
    if (st.COMPLETED === n) return 'manager Final Submit done';
    if (st.LIVE) return 'manager review open (not submitted)';
    if (st.NONE === n) return 'review link not sent';
    return Object.keys(st).map(function (k) { return st[k] + ' ' + k.toLowerCase(); }).join(', ');
  }

  var last = null;      // last successful zoneOpsLoad response
  var busy = false;
  var reportDatesLinked = true;

  // ---------------- 1. access ----------------
  function paintAccess(st) {
    var chip = $('zoAccessState');
    chip.className = 'access-state access-' + st.code;
    chip.textContent = { AUTHORIZED: 'AUTHORIZED', CHECKING: 'CHECKING…', AUTH_REQUIRED: 'AUTHENTICATION REQUIRED', DEVICE_NOT_REGISTERED: 'DEVICE NOT REGISTERED', SESSION_EXPIRED: 'SESSION EXPIRED',
      INSUFFICIENT_PERMISSION: 'INSUFFICIENT PERMISSION', SERVICE_UNAVAILABLE: 'SERVICE UNAVAILABLE' }[st.code] || st.code;
    $('zoAccessWho').textContent = st.code === 'AUTHORIZED' ? 'Signed in as ' + (st.signedInAs || '—') + ' (Analytics Admin) via ' + (st.via === 'admin' ? 'access link' : 'enrolled device') + ' · checked ' + st.checkedAt : '';
    $('zoAccessDetail').textContent = st.detail || '';
    var authorized = st.code === 'AUTHORIZED';
    gate($('zoEnrollBtn'), A.hasDevice() && !A.hasAccessLink() ? 'This browser is already enrolled.' : (!A.hasAccessLink() ? 'Sign in with your access link first - enrolling needs it once.' : (authorized ? '' : 'Your access link must be accepted first (Check access).')));
    gate($('zoForgetBtn'), A.hasDevice() ? '' : 'No enrollment is stored in this browser.');
    $('zoSignInBox').hidden = authorized && A.hasDevice();
    refreshGates();
  }
  function refreshGates() {
    var authorized = A.state().code === 'AUTHORIZED';
    var noAccess = authorized ? '' : 'Access required - see step 1 above.';
    var date = $('zoDate').value;
    gate($('zoLoadBtn'), noAccess || (busy ? 'Working…' : '') || (date ? '' : 'Choose the operational date first.'));
    var notLoaded = last && last.date === date ? '' : 'Press "Load zones" for ' + (date || 'the operational date') + ' first.';
    gate($('zoSaveBtn'), noAccess || (busy ? 'Working…' : '') || notLoaded);
    gate($('zoCopyPrevBtn'), noAccess || (busy ? 'Working…' : '') || notLoaded);
    var rf = $('zoRepFrom').value, rt = $('zoRepTo').value;
    var repReason = noAccess || (busy ? 'Working…' : '') || (!rf || !rt ? 'Choose From and To dates.' : (rf > rt ? 'From Date must be on or before To Date.' : (daysBetween(rf, rt) > 31 ? 'At most 31 days per report.' : '')));
    var picked = pickedZones(), realZones = picked.filter(function (z) { return z !== '__UNASSIGNED__'; });
    var pickReason = !picked.length ? (last ? 'Tick at least one zone below.' : 'Press "Load zones" (step 3), then tick the zones to export.') : '';
    gate($('zoRepPdfBtn'), repReason || pickReason);
    gate($('zoRepXlsxBtn'), repReason || pickReason);
    gate($('zoRepApproveBtn'), repReason || pickReason || (!realZones.length ? 'Unassigned attendance is for review, not for distribution - tick the zone(s) to approve.' : ''));
    gate($('zoSuppSubmitBtn'), noAccess || (busy ? 'Working…' : '') || (last && last.date === date ? '' : 'Load the zones of the operational date first (the claim is for that date).') || manualReason());
  }
  function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000) + 1; }

  // ---------------- 2. dates ----------------
  function setOpDate(k) { $('zoDate').value = k; onDateChange(); }
  function onDateChange() {
    var k = $('zoDate').value;
    $('zoDateLabel').textContent = k ? 'Operational day: ' + fmtDay(k) + ' (Asia/Riyadh). Daily targets, compliance, supplementary claims and Finalize use THIS one day.' : 'Choose the operational date.';
    if (reportDatesLinked) { $('zoRepFrom').value = k; $('zoRepTo').value = k; repLabel(); }
    if (last && last.date !== k) { clear($('zoHost')); clear($('zoDetail')); msg('The operational date changed - press "Load zones" for ' + k + '.'); }
    refreshGates();
  }
  /** the zones ticked for export ('__UNASSIGNED__' = the unassigned-attendance review file) */
  function pickedZones() { return Array.prototype.slice.call(document.querySelectorAll('#zoRepZones input[type=checkbox]:checked')).map(function (b) { return b.value; }); }
  function zoneLabel(z) { return z === '__UNASSIGNED__' ? 'UNASSIGNED / NEEDS CLASSIFICATION' : z; }
  function repScope() {
    var f = $('zoRepFrom').value, t = $('zoRepTo').value, layout = $('zoRepLayout') ? $('zoRepLayout').value : 'MANAGEMENT', picked = pickedZones();
    var period = !f || !t ? '(choose dates)' : (f === t ? fmtDay(f) : f + ' to ' + t), short = !f || !t ? '' : (f === t ? f : f + '…' + t);
    var nFiles = layout === 'EXECUTIVE' ? (picked.filter(function (z) { return z !== '__UNASSIGNED__'; }).length ? 1 : 0) + (picked.indexOf('__UNASSIGNED__') !== -1 ? 1 : 0) : picked.length;
    if ($('zoRepAllEmpBox')) $('zoRepAllEmpBox').hidden = layout !== 'EXECUTIVE';
    if ($('zoRepScope')) $('zoRepScope').textContent = !picked.length ? 'Export scope: no zone ticked yet.' : 'Export scope: ' + picked.map(zoneLabel).join(', ') + ' · ' + period + ' · ' +
      ({ MANAGEMENT: 'Management PDF', DETAILED: 'Detailed PDF', EXECUTIVE: 'Combined overview PDF' }[layout] || layout) + ' · ' + (nFiles > 1 ? nFiles + ' separate PDF files in one ZIP' : 'one PDF file');
    if (!busy) {
      var nz = picked.filter(function (z) { return z !== '__UNASSIGNED__'; }).length, un = picked.length - nz;
      var what = !picked.length ? '' : (picked.length === 1 ? zoneLabel(picked[0]) : (nz ? nz + ' zone' + (nz > 1 ? 's' : '') : '') + (un ? (nz ? ' + ' : '') + 'unassigned' : '')) + ' · ' + short;
      $('zoRepPdfBtn').textContent = 'Download PDF' + (nFiles > 1 ? 's (ZIP)' : '') + (what ? ' - ' + what : '');
      $('zoRepXlsxBtn').textContent = 'Download Excel' + (what ? ' - ' + what : '');
      $('zoRepApproveBtn').textContent = 'Approve Report & Export' + (what ? ' - ' + what : '');
    }
  }
  function repLabel() {
    repScope();
    var f = $('zoRepFrom').value, t = $('zoRepTo').value;
    $('zoRepNote').textContent = !f || !t ? '' : (f === t ? 'One-day report: ' + fmtDay(f) + '.' : 'Multi-day report: ' + f + ' to ' + t + ' (' + daysBetween(f, t) + ' days, inclusive). Every zone is calculated on every day against that day\'s own target, then summed as employee-days - a multi-day total is never compared with a single-day target.');
    refreshGates();
  }

  // ---------------- 3-5. load, targets, compliance ----------------
  function load() {
    var d = $('zoDate').value;
    if (!d) return;
    busy = true; refreshGates(); msg('Loading zones, configuration, targets and compliance for ' + d + '…');
    opCall('zoneOpsLoad').then(function (res) {
      busy = false;
      if (!res.ok) { msg('Error: ' + res.error, true); refreshGates(); return; }
      last = res;
      fillZoneSelects(res);
      render(res);
      msg('Loaded ' + res.zones.length + ' zone(s) for ' + fmtDay(res.date) + ' (generated ' + res.generatedAt + ', Asia/Riyadh).' + (res.unmappedRecords ? ' ' + res.unmappedRecords + ' attendance record(s) are in Unmapped areas (no zone).' : ''));
      refreshGates();
    });
  }
  function fillZonePicker(res) {
    var box = $('zoRepZones'), keep = {};
    pickedZones().forEach(function (z) { keep[z] = true; });
    clear(box);
    res.zones.forEach(function (z) {
      var c = z.content, lab = el('label', 'zo-check zo-zone'), cb = el('input');
      cb.type = 'checkbox'; cb.value = z.zone; cb.checked = !!keep[z.zone];
      cb.addEventListener('change', function () { repScope(); refreshGates(); });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + z.zone + ' '));
      lab.appendChild(el('span', 'meta', '(' + c.employees.length + ' employee' + (c.employees.length === 1 ? '' : 's') + (z.approval ? ' · APPROVED' + (z.approval.current ? '' : ', data changed since') : '') + ')'));
      box.appendChild(lab);
    });
    var ul = el('label', 'zo-check zo-zone zo-unassigned'), ucb = el('input');
    ucb.type = 'checkbox'; ucb.value = '__UNASSIGNED__'; ucb.checked = !!keep['__UNASSIGNED__'];
    ucb.addEventListener('change', function () { repScope(); refreshGates(); });
    ul.appendChild(ucb);
    ul.appendChild(document.createTextNode(' UNASSIGNED / NEEDS CLASSIFICATION '));
    ul.appendChild(el('span', 'meta', '(' + (res.unmappedRecords || 0) + ' record(s) on ' + res.date + ' whose Area has no zone - separate file, for review only)'));
    box.appendChild(ul);
  }
  // Manual Attendance / تحضير يدوي (admin only): the form switches between a supplementary claim and a manual entry
  function manualMode() { return $('zoSuppMode') && $('zoSuppMode').value === 'MANUAL'; }
  function manualReason() {
    if (!manualMode() || !last) return '';
    var z = last.zones.filter(function (x) { return x.zone === $('zoSuppZone').value; })[0];
    if (!z) return 'Choose the zone.';
    if (z.report.status === 'FINAL') return 'The report of ' + z.zone + ' for ' + last.date + ' is FINAL.';
    var ps = (z.content.plan && z.content.plan.status) || 'NONE';
    if (z.content.target || ps !== 'NONE') return z.zone + ' has a staffing plan for ' + last.date + (z.content.target ? '' : ' (' + ps.replace(/_/g, ' ') + ')') + ' - Manual Attendance is for zone-days without a plan (use a supplementary claim).';
    if (!$('zoSuppArea').value) return 'Choose the event / area (Settings has no event for this zone).';
    return '';
  }
  function fillSuppAreas() {
    var box = $('zoSuppAreaBox'), sel = $('zoSuppArea'), cur = sel.value;
    box.hidden = !manualMode(); clear(sel);
    ((last && last.areasByZone && last.areasByZone[$('zoSuppZone').value]) || []).forEach(function (a) { var o = el('option', null, a); o.value = a; sel.appendChild(o); });
    if (cur) sel.value = cur;
    $('zoSuppSubmitBtn').textContent = manualMode() ? 'Save Manual Attendance / حفظ التحضير اليدوي' : 'Submit Claim';
    refreshGates();
  }
  function fillZoneSelects(res) {
    fillZonePicker(res);
    ['zoZone', 'zoSuppZone'].forEach(function (id) {
      var sel = $(id), cur = sel.value; clear(sel);
      if (id !== 'zoSuppZone') { var all = el('option', null, 'All zones'); all.value = ''; sel.appendChild(all); }
      res.zones.forEach(function (z) { var o = el('option', null, z.zone + (z.content.config.mode === 'NOT_CONFIGURED' ? ' (not configured)' : '')); o.value = z.zone; sel.appendChild(o); });
      if (cur && res.zones.some(function (z) { return z.zone === cur; })) sel.value = cur;
    });
    repScope(); fillSuppAreas(); refreshGates();
  }
  function shown(res) { var f = $('zoZone').value; return res.zones.filter(function (z) { return !f || z.zone === f; }); }
  function render(res) {
    var host = $('zoHost'); clear(host); clear($('zoDetail'));
    host.appendChild(el('div', 'meta', 'Showing operational day ' + fmtDay(res.date) + (($('zoZone').value) ? ' · zone ' + $('zoZone').value : ' · all zones') + '. Required / approved per shift; "open" = pending or unresolved records, never counted as absence.'));
    renderManpower(res);
    renderMissing(res);
    var wrap = el('div', 'table-scroll'), t = el('table', 'data-table zo-table');
    var hr = el('tr');
    ['Zone', 'Configuration', 'Required hours', 'Target: Morning', 'Night', 'Daily total', 'Manpower plan / expected', 'Previous day', 'Headcount: Morning', 'Headcount: Night', 'Headcount status (daily total)', 'Unique / coverage', 'Hours status (employees)', 'Open records', 'Report / finalization', 'Actions'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    var thead = el('thead'); thead.appendChild(hr); t.appendChild(thead);
    var tb = el('tbody');
    shown(res).forEach(function (z) {
      var c = z.content, tr = el('tr'), mode = c.config.mode, final = z.report.status === 'FINAL';
      tr.appendChild(el('td', null, c.zone + (c.city ? ' · ' + c.city : '')));
      var cfgTd = el('td');
      cfgTd.appendChild(el('div', null, mode + ' · ' + c.config.policy.replace(/_/g, ' ')));
      if (c.config.errors.length) cfgTd.appendChild(el('div', 'disabled-reason', 'Missing: ' + c.config.errors.join('; ')));
      if (c.managers.length) cfgTd.appendChild(el('div', 'meta', c.managers.map(function (m) { return m.name + ' (' + m.role + ')'; }).join(', ')));
      else if (c.managerError) cfgTd.appendChild(el('div', 'disabled-reason', c.managerError));
      else if ((c.routingReviewers || []).length) cfgTd.appendChild(el('div', 'meta', 'Reviewer: ' + c.routingReviewers.join(', ') + ' (Review_Routing)'));
      tr.appendChild(cfgTd);
      tr.appendChild(el('td', null, c.config.shifts.length ? c.config.shifts.map(function (s) { return s.name + ' ' + (s.requiredHours || '—'); }).join(' · ') + ' (±' + c.config.toleranceMin + 'm)' : '—'));
      var tg = c.target || {};
      function input(key, val, enabledReason) {
        var td = el('td'), i = el('input'); i.type = 'number'; i.min = '0'; i.max = '9999'; i.step = '1'; i.inputMode = 'numeric';
        i.value = val === null || val === undefined ? '' : val; i.setAttribute('data-zone', c.zoneId); i.setAttribute('data-key', key);
        i.setAttribute('aria-label', c.zone + ' ' + key + ' required employees');
        var reason = final ? 'FINAL report - target locked' : enabledReason;
        i.disabled = !!reason; if (reason) i.title = reason;
        i.addEventListener('input', function () { updateTotal(c.zoneId); });
        td.appendChild(i); if (reason) td.appendChild(el('span', 'disabled-reason', reason));
        return td;
      }
      var notMN = mode === 'MORNING_NIGHT' ? '' : (mode === 'NOT_CONFIGURED' ? 'Configure the zone first' : 'Single daily target for this mode');
      tr.appendChild(input('morning', tg.morning, notMN));
      tr.appendChild(input('night', tg.night, notMN));
      if (mode === 'MORNING_NIGHT') { var tt = el('td', null, tg.total === null || tg.total === undefined ? '—' : tg.total); tt.setAttribute('data-total', c.zoneId); tr.appendChild(tt); }
      else tr.appendChild(input('daily', tg.daily, mode === 'NOT_CONFIGURED' ? 'Configure the zone first' : ''));
      var ptd = el('td', 'meta zo-plan', planText(c)); if (c.plan && c.plan.discrepancy) ptd.className += ' st-PENDING'; if (c.target && c.target.stale) ptd.className += ' st-UNMATCHED'; tr.appendChild(ptd);
      var pt = z.previousTarget;
      tr.appendChild(el('td', 'meta', pt ? (pt.mode === 'MORNING_NIGHT' ? pt.morning + ' + ' + pt.night : pt.daily) : '—'));
      tr.appendChild(mode === 'MORNING_NIGHT' ? staffCell(c.staffing.morning) : el('td', null, '—'));
      tr.appendChild(mode === 'MORNING_NIGHT' ? staffCell(c.staffing.night) : el('td', null, '—'));
      tr.appendChild(staffCell(c.staffing.total));
      tr.appendChild(el('td', null, c.staffing.uniqueHeadcount + ' / ' + c.staffing.shiftCoverage));
      tr.appendChild(el('td', c.counts.hoursUnmatched ? 'st-UNMATCHED' : (c.employees.length ? 'st-MATCHED' : null), hoursText(c.employees) + (c.counts.hoursExplanationMissing ? ' (' + c.counts.hoursExplanationMissing + ' need explanation)' : '')));
      tr.appendChild(el('td', null, c.counts.pending + c.counts.notReviewed + c.counts.unresolved));
      tr.appendChild(el('td', null, (final ? 'FINAL v' + z.report.version + (z.report.liveChanged ? ' (live data changed since)' : '') + (z.report.integrityOk === false ? ' ⚠ INTEGRITY' : '') :
        'DRAFT · ' + reviewText(c) + ' · ' + (c.blockers.length ? c.blockers.length + ' FINAL blocker(s) - see Details' : 'no blockers: ready to Finalize (not automatic)')) +
        (z.approval ? ' · APPROVED for distribution ' + z.approval.approvedAt + ' by ' + z.approval.approvedBy + (z.approval.current ? '' : ' (data changed since - approve again to distribute the current figures)') : '')));
      var act = el('td', 'zo-actions');
      function btn(label, cls, fn, reason) { var b = el('button', cls, label); b.id = 'zo-' + label.replace(/\W+/g, '') + '-' + c.zoneId; b.addEventListener('click', function () { fn(b); }); act.appendChild(b); if (reason !== undefined) gate(b, reason); }
      btn('Details', 'btn-secondary', function () { showDetail(z); });
      btn('Configure', 'btn-secondary', function () { showConfig(z); }, final ? '' : '');
      btn('Finalize', 'btn-primary', function () { askFinalize(z); }, final ? 'Already FINAL (version ' + z.report.version + ')' : (c.blockers.length ? 'Blocked by ' + c.blockers.length + ' issue(s) - open Details' : ''));
      tr.appendChild(act);
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); host.appendChild(wrap);
    host.appendChild(el('div', 'meta', 'A normal shift extended with overtime is ONE employee and ONE shift; the extra time is an hours exception that needs the Zone Manager\'s explanation. Unique = distinct approved employees; coverage = approved employee-shifts.'));
    renderSupplements(res);
  }
  // ---------------- Manpower plan (external Daily Log, read only) ----------------
  function planText(c) {
    var pl = c.plan || { status: 'NONE' }, t = c.target;
    var parts = [];
    if (pl.status === 'NONE') parts.push('No Daily Log row mapped');
    else if (pl.status === 'INCOMPLETE') parts.push('INCOMPLETE - known partial ' + pl.knownPartial + (pl.knownMorning !== null && pl.knownMorning !== undefined ? ' (morning ' + pl.knownMorning + ', night ' + pl.knownNight + (pl.unassigned ? ', shift not set ' + pl.unassigned : '') + ')' : '') +
      ((pl.blankRows || []).length ? ' · Scheduled blank: ' + pl.blankRows.join(', ') : '') + ' - not a complete target');
    else if (pl.status === 'NO_ACTIVE_EVENT') parts.push('NO ACTIVE EVENT (' + (pl.ended || []).join(', ') + ') - no shortage');
    else parts.push('Plan ' + pl.status + ': Scheduled (G) ' + pl.scheduled + ' · Approved (F) ' + (pl.approvedPlan === null ? '—' : pl.approvedPlan) + (pl.discrepancy ? ' · PLAN DISCREPANCY ' + (pl.planDiff === null ? '' : (pl.planDiff > 0 ? '+' : '') + pl.planDiff) : ''));
    parts.push('Expected: ' + (t ? (t.daily !== null && t.daily !== undefined ? t.daily : t.morning + ' + ' + t.night) + ' (' + (t.source || 'MANUAL') + (t.stale ? ', STALE' : '') + ')' : (pl.status === 'INCOMPLETE' ? 'INCOMPLETE' : (pl.status === 'NO_ACTIVE_EVENT' ? 'none (no active event)' : 'NO PLAN / بدون خطة'))));
    if (t && t.overrideStatus) parts.push(t.overrideStatus);
    return parts.join(' · ');
  }
  function renderManpower(res) {
    var mp = res.manpower, host = $('zoHost');
    if (!mp) return;
    var box = el('div', 'control-card zo-mp'); box.id = 'zoMpPanel';
    var f = mp.freshness || {};
    var head = el('div', 'zo-mp-head');
    head.appendChild(el('span', 'access-state mp-' + (f.state || 'NONE'), 'Manpower plan: ' + (f.state || 'UNAVAILABLE')));
    head.appendChild(el('span', f.state === 'OK' ? 'meta' : 'meta report-error', ' ' + (f.state === 'OK' ? 'sync OK' : (f.label || mp.error || '')) + ' · last successful sync ' + (f.lastSuccessAt || 'never') +
      ' · last check ' + (f.lastCheckAt || '—') + (f.sourceModified ? ' · source file modified ' + f.sourceModified : '')));
    box.appendChild(head);
    var m = mp.mapping || {};
    box.appendChild(el('div', 'meta', 'Mapping: ' + (m.mapped || 0) + ' mapped, ' + (m.unmapped || 0) + ' unmapped, ' + (m.excluded || 0) + ' excluded of ' + (m.sourceNames || 0) + ' Daily Log zone names' +
      ((m.unmappedNames || []).length ? ' · UNMAPPED (not counted): ' + m.unmappedNames.join(', ') : '') + '. Expected staff = Scheduled (G); actual = approved fingerprint attendance; the external Present column is never used.'));
    var bar = el('div', 'filter-bar');
    var rb = el('button', 'btn-secondary', 'Refresh Manpower Plan'); rb.id = 'zoMpRefreshBtn';
    rb.addEventListener('click', refreshManpower); bar.appendChild(rb);
    if (mp.mapUrl) { var a = el('a', 'zo-link', 'Edit my Manpower_Zone_Map (Google Sheet)'); a.href = mp.mapUrl; a.target = '_blank'; a.rel = 'noopener'; bar.appendChild(a); }
    box.appendChild(bar);
    box.appendChild(el('div', 'meta zo-flow', 'Daily use: 1 choose the date · 2 Load zones · 3 Refresh Manpower Plan · 4 check Expected · 5 managers review fingerprints and approve · 6 read the Difference · 7 export PDF / Excel.'));
    var et = el('table', 'data-table zo-exec'), eh = el('tr');
    ['Zone', 'Expected', 'Source Approved (F)', 'Fingerprints Received', 'Pending', 'Approved Actual', 'Difference', 'Status'].forEach(function (h) { eh.appendChild(el('th', null, h)); });
    var ethead = el('thead'); ethead.appendChild(eh); et.appendChild(ethead); var etb = el('tbody');
    res.zones.forEach(function (z) {
      var c = z.content, t = c.target, pl = c.plan || {}, tot = c.staffing.total || {}, open = c.counts.pending + c.counts.notReviewed + c.counts.unresolved;
      var exp = t ? (t.daily !== null && t.daily !== undefined ? String(t.daily) : (t.morning + t.night) + ' (M ' + t.morning + ' / N ' + t.night + ')') : (pl.status === 'INCOMPLETE' ? 'INCOMPLETE (known ' + pl.knownPartial + ')' : (pl.status === 'NO_ACTIVE_EVENT' ? 'no active event' : 'NO PLAN / بدون خطة'));
      var st = !t ? (pl.status === 'INCOMPLETE' ? 'INCOMPLETE' : (pl.status === 'NO_ACTIVE_EVENT' ? 'NO ACTIVE EVENT' : 'NO PLAN / بدون خطة')) : (tot.status === 'PENDING' ? 'PRELIMINARY - ' + (open ? open + ' pending' : (c.counts.records ? 'review not submitted' : 'no fingerprints yet')) : (tot.status === 'UNMATCHED' ? (tot.diff < 0 ? 'SHORTAGE ' + (-tot.diff) : 'EXCESS ' + tot.diff) : tot.status));
      var tr = el('tr');
      [c.zone, exp, pl.approvedPlan === null || pl.approvedPlan === undefined ? '—' : pl.approvedPlan, c.counts.records, open, tot.approved, t && tot.diff !== null && tot.diff !== undefined ? (tot.diff > 0 ? '+' : '') + tot.diff : '—', st].forEach(function (v, i) {
        var td = el('td', i === 7 ? 'st-' + (st === 'MATCHED' ? 'MATCHED' : (/^(SHORTAGE|EXCESS|INCOMPLETE|MISSING)/.test(st) ? 'UNMATCHED' : 'PENDING')) : null, v); tr.appendChild(td); });
      etb.appendChild(tr);
    });
    et.appendChild(etb); var ew = el('div', 'table-scroll'); ew.appendChild(et); box.appendChild(ew);
    var bad = (mp.rows || []).filter(function (r) { return r.status !== 'COUNTED'; });
    if (bad.length) {
      var det = el('details', 'zo-mp-rec'); det.appendChild(el('summary', null, bad.length + ' Daily Log row(s) for ' + res.date + ' are NOT counted (reconciliation)'));
      var ul = el('ul'); bad.forEach(function (r) { ul.appendChild(el('li', null, r.external + ' - F ' + (r.approved === null ? '—' : r.approved) + ' / G ' + (r.scheduled === null ? 'blank' : r.scheduled) + ' - ' + r.status + ': ' + r.reason)); });
      det.appendChild(ul); box.appendChild(det);
    }
    host.appendChild(box);
    gate(rb, A.state().code === 'AUTHORIZED' ? (busy ? 'Working…' : '') : 'Access required - see step 1 above.');
  }
  function refreshManpower() {
    var mp = last && last.manpower;
    busy = true; refreshGates(); msg('Asking the Manpower Sync to re-check the owner\'s Daily Log, then applying the plan…');
    var step1 = mp && mp.syncUrl && window.HMGNet ? window.HMGNet.jsonp(mp.syncUrl, { action: 'syncNow' }, { timeoutMs: 90000 }).catch(function (e) { return { ok: false, error: 'the Manpower Sync service did not answer (' + (e && e.message || e) + ') - is it authorized?' }; }) : Promise.resolve({ ok: false, error: 'the Manpower Sync service is not deployed / authorized yet' });
    step1.then(function (s1) {
      return opCall('manpowerRefresh').then(function (res) {
        busy = false;
        if (!res.ok) { msg('Refresh failed: ' + res.error, true); refreshGates(); return; }
        msg((s1 && s1.ok ? 'Source checked (' + (s1.changed ? 'CHANGED' : 'unchanged') + ', ' + s1.rows + ' rows). ' : 'Source NOT re-read: ' + (s1 && s1.error || '') + ' - the last cached plan was applied. ') +
          'Plan applied: ' + res.apply.created + ' new, ' + res.apply.updated + ' updated, ' + res.apply.manualKept + ' manual kept, ' + res.apply.finalKept + ' FINAL kept, ' + res.apply.staleMarked + ' stale. Reloading…');
        load();
      });
    });
  }
  /** One consolidated list of the inputs the owner still has to provide for this date (nothing is guessed). */
  function mode0(c) { return c.config.mode; }
  function renderMissing(res) {
    var host = $('zoHost'), items = [];
    shown(res).forEach(function (z) {
      var c = z.content, need = [];
      if (!c.config.configured) need.push('configuration: ' + c.config.errors.join('; '));
      if (!c.target && z.report.status !== 'FINAL') need.push('staffing target for ' + res.date + (mode0(c) === 'MORNING_NIGHT' ? ' (morning + night)' : ' (daily)'));
      if (c.managerError) need.push('manager assignment: ' + c.managerError);
      if ((c.config.warnings || []).length) need.push('Settings: ' + c.config.warnings.join('; '));
      if (need.length) items.push(c.zone + ' - ' + need.join(' · '));
    });
    if (!items.length) { host.appendChild(el('div', 'meta', 'All shown zones have a complete configuration and a target for ' + fmtDay(res.date) + '.')); return; }
    var box = el('div', 'notice'); box.id = 'zoMissing';
    box.appendChild(el('div', null, 'Inputs still required (' + items.length + ' zone(s)) - enter them in the Operational_Inputs Google Sheet (one row per missing value), or here: targets in the grid + Save targets:'));
    var ul = el('ul'); items.forEach(function (t) { ul.appendChild(el('li', null, t)); }); box.appendChild(ul);
    host.appendChild(box);
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
      var tg = z.content.target || {}, same = function (v, cur) { return String(v) === (cur === null || cur === undefined ? '' : String(cur)); };
      if (mode === 'MORNING_NIGHT') { var m = get('morning'), n = get('night'); if (m !== null && n !== null && (m !== '' || n !== '') && !(same(m, tg.morning) && same(n, tg.night))) list.push({ zoneId: z.zoneId, morning: m, night: n }); }
      else if (mode && mode !== 'NOT_CONFIGURED') { var d = get('daily'); if (d !== null && d !== '' && !same(d, tg.daily)) list.push({ zoneId: z.zoneId, daily: d }); }
    });
    if (!list.length) { msg('No target was changed (a changed value becomes an explicit MANUAL override of the Manpower plan).', true); return; }
    busy = true; refreshGates(); msg('Saving ' + list.length + ' zone target(s) for ' + last.date + '…');
    opCall('zoneTargetsSave', { targets: JSON.stringify(list) }).then(function (res) {
      busy = false;
      var saved = (res.results || []).filter(function (r) { return r.ok && !r.unchanged; }).length, same = (res.results || []).filter(function (r) { return r.unchanged; }).length;
      if (!res.ok) msg('Some targets were not saved: ' + res.error + (saved ? ' (' + saved + ' saved)' : ''), true);
      else msg('Saved ' + saved + ' target(s)' + (same ? ', ' + same + ' unchanged' : '') + ' for ' + last.date + '. Reloading to confirm…');
      load();
    });
  }
  function copyPrevious() {
    if (!last) return;
    busy = true; refreshGates(); msg('Copying the targets of ' + shiftDays(last.date, -1) + ' to ' + last.date + ' (zones that already have a target, or a FINAL report, are never overwritten)…');
    opCall('zoneTargetsCopyPrevious', { overwrite: 'false' }).then(function (res) {
      busy = false;
      if (!res.ok) { msg('Error: ' + res.error, true); refreshGates(); return; }
      msg((res.message || ('Copied ' + res.copied + ' zone target(s)' + (res.skipped ? ', ' + res.skipped + ' skipped (already set)' : ''))) + ' Reloading…');
      load();
    });
  }

  // ---------------- 4. zone configuration (Google Sheets stays the source; each save is a NEW effective-dated version) ----------------
  function showConfig(z) {
    var c = z.content, host = $('zoDetail'); clear(host);
    var box = el('div', 'control-card zo-detail zo-config-form');
    box.appendChild(el('div', 'group-title', 'Configure ' + c.zone));
    box.appendChild(el('div', 'meta', 'Current (effective ' + (c.config.effectiveFrom || 'always') + ', version ' + (c.config.version || '—') + '): ' + c.config.mode + (c.config.shifts.length ? ' · ' + c.config.shifts.map(function (s) { return s.name + ' ' + (s.start || '') + (s.end ? '-' + s.end : '') + ' req ' + (s.requiredHours || '—'); }).join(' · ') : '')));
    if (c.config.errors.length) box.appendChild(el('div', 'notice', 'Missing for ' + c.date + ': ' + c.config.errors.join('; ')));
    box.appendChild(el('div', 'meta', 'Saving writes a NEW row in Zone_Configuration (version +1) effective from the chosen date; older versions and FINAL reports are never changed. Enter only real values - nothing is filled in for you.'));
    var bar = el('div', 'filter-bar');
    function field(label, node) { var f = el('div', 'filter-field'); var l = el('label', null, label); f.appendChild(l); f.appendChild(node); bar.appendChild(f); return f; }
    function inp(type, val, ph) { var i = el('input'); i.type = type; if (val) i.value = val; if (ph) i.placeholder = ph; return i; }
    function sel(opts, val) { var s = el('select'); opts.forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; s.appendChild(op); }); if (val) s.value = val; return s; }
    var sh = {}; c.config.shifts.forEach(function (s) { sh[s.name] = s; });
    var mode = sel([['MORNING_NIGHT', 'Morning + Night'], ['SINGLE', 'Single shift'], ['FLEXIBLE', 'Flexible / no fixed shift'], ['AREA_SCHEDULE', 'Per Area + Shift (times from Settings)']], c.config.mode === 'NOT_CONFIGURED' ? 'MORNING_NIGHT' : c.config.mode);
    field('Operating mode', mode);
    var f = {
      morningStart: inp('time', sh.MORNING && sh.MORNING.start), morningEnd: inp('time', sh.MORNING && sh.MORNING.end), reqMorning: inp('text', sh.MORNING && sh.MORNING.requiredHours, 'H:MM'),
      nightStart: inp('time', sh.NIGHT && sh.NIGHT.start), nightEnd: inp('time', sh.NIGHT && sh.NIGHT.end), reqNight: inp('text', sh.NIGHT && sh.NIGHT.requiredHours, 'H:MM'),
      shiftStart: inp('time', sh.SINGLE && sh.SINGLE.start), shiftEnd: inp('time', sh.SINGLE && sh.SINGLE.end),
      reqHours: inp('text', (sh.SINGLE && sh.SINGLE.requiredHours) || (sh.FLEXIBLE && sh.FLEXIBLE.requiredHours), 'H:MM'),
      toleranceMin: inp('number', String(c.config.toleranceMin)), overtimeMin: inp('number', String(c.config.overtimeMin || 60)),
      policy: sel([['PRIMARY_REQUIRED', 'Primary manager required'], ['ANY_ONE', 'Any one authorized manager'], ['ALL_REQUIRED', 'All required managers'], ['PRIMARY_PLUS_TRAINING', 'Primary + non-binding training reviewer']], c.config.policy),
      totalBasis: sel([['SHIFT_COVERAGE', 'Daily total = shift coverage'], ['UNIQUE_HEADCOUNT', 'Daily total = unique employees']], c.config.totalBasis),
      doubleShiftCoverage: sel([['COUNT_ONE', 'Possible double shift counts once'], ['COUNT_BOTH', 'Possible double shift counts in both shifts']], c.config.doubleShiftCoverage || 'COUNT_ONE'),
      includeDoctors: sel([['FALSE', 'Doctors not in zone headcount'], ['TRUE', 'Include doctors in zone headcount']], c.config.includeDoctors ? 'TRUE' : 'FALSE'),
      effectiveFrom: inp('date', $('zoDate').value), effectiveTo: inp('date', ''),
    };
    var groups = {
      MORNING_NIGHT: [field('Morning start', f.morningStart), field('Morning end', f.morningEnd), field('Morning required hours', f.reqMorning), field('Night start', f.nightStart), field('Night end', f.nightEnd), field('Night required hours', f.reqNight)],
      SINGLE: [field('Shift start', f.shiftStart), field('Shift end', f.shiftEnd)],
      HOURS: [field('Required hours', f.reqHours)],
    };
    [['Hours tolerance ± (min)', f.toleranceMin], ['Overtime from + (min)', f.overtimeMin], ['Approval policy', f.policy], ['Daily total basis', f.totalBasis], ['Double shift coverage', f.doubleShiftCoverage],
      ['Doctors', f.includeDoctors], ['Effective from', f.effectiveFrom], ['Effective to (optional)', f.effectiveTo]].forEach(function (p) { field(p[0], p[1]); });
    function toggle() {
      var m = mode.value;
      groups.MORNING_NIGHT.forEach(function (n) { n.hidden = m !== 'MORNING_NIGHT'; });
      groups.SINGLE.forEach(function (n) { n.hidden = m !== 'SINGLE'; });
      groups.HOURS.forEach(function (n) { n.hidden = m === 'MORNING_NIGHT' || m === 'AREA_SCHEDULE'; });
    }
    mode.addEventListener('change', toggle); toggle();
    box.appendChild(bar);
    var save = el('button', 'btn-primary', 'Save configuration'); save.id = 'zoCfgSaveBtn';
    var cancel = el('button', 'btn-secondary', 'Close');
    var out = el('div', 'meta');
    cancel.addEventListener('click', function () { clear(host); });
    save.addEventListener('click', function () {
      var args = { zone: c.zone, mode: mode.value };
      Object.keys(f).forEach(function (k) { args[k] = f[k].value; });
      if (mode.value !== 'MORNING_NIGHT') ['morningStart', 'morningEnd', 'reqMorning', 'nightStart', 'nightEnd', 'reqNight'].forEach(function (k) { delete args[k]; });
      if (mode.value !== 'SINGLE') { delete args.shiftStart; delete args.shiftEnd; }
      if (mode.value === 'MORNING_NIGHT') delete args.reqHours;
      save.disabled = true; out.textContent = 'Saving…';
      opCall('zoneConfigSave', { opArgs: JSON.stringify(args) }).then(function (res) {
        save.disabled = false;
        if (!res.ok) { out.className = 'meta report-error'; out.textContent = res.error; return; }
        out.className = 'meta'; out.textContent = 'Saved version ' + res.version + ' effective ' + res.effectiveFrom + (res.effectiveTo ? ' to ' + res.effectiveTo : '') + '. ' + (res.note || '') + ' Reloading…';
        load();
      });
    });
    var bar2 = el('div', 'row-actions'); bar2.appendChild(save); bar2.appendChild(cancel);
    box.appendChild(bar2); box.appendChild(out);
    box.appendChild(el('div', 'meta', 'Zone managers (more than one per zone) are added in the Zone_Manager_Assignments sheet: Manager ID, name, WhatsApp, Role (PRIMARY / SECONDARY / TRAINING), Required, Effective From/To.'));
    host.appendChild(box);
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------- 5. details: employees, hours, explanations, every manager's opinion, acknowledgments ----------------
  function showDetail(z) {
    var c = z.content, host = $('zoDetail'); clear(host);
    var final = z.report.status === 'FINAL';
    var box = el('div', 'control-card zo-detail');
    box.appendChild(el('div', 'group-title', c.zone + ' — ' + fmtDay(c.date) + ' (' + (final ? 'FINAL v' + z.report.version : 'DRAFT') + ')'));
    box.appendChild(el('div', 'meta', 'Mode ' + c.config.mode + ' · policy ' + c.config.policy + ' · tolerance ±' + c.config.toleranceMin + ' min, overtime from +' + (c.config.overtimeMin || 60) + ' min · ' + c.config.shifts.map(function (s) { return s.name + ' ' + (s.start || '') + (s.end ? '-' + s.end : '') + ' req ' + (s.requiredHours || '—'); }).join(' · ')));
    box.appendChild(el('div', 'meta', c.staffing.note));
    box.appendChild(el('div', c.plan && (c.plan.discrepancy || c.plan.status === 'INCOMPLETE') ? 'notice' : 'meta', 'Manpower plan: ' + planText(c) + (c.plan && c.plan.freshnessLabel ? ' · ' + c.plan.freshnessLabel : '')));
    if (c.plan && c.plan.rows && c.plan.rows.length) { var pu = el('ul'); c.plan.rows.forEach(function (x) { pu.appendChild(el('li', null, x.external + ' → ' + (x.area || 'whole zone') + ' / ' + x.shift + ': F ' + (x.approved === null ? '—' : x.approved) + ', G ' + (x.scheduled === null ? 'blank' : x.scheduled) + ' - ' + x.status + (x.reason ? ' (' + x.reason + ')' : '') + (x.hoursNote ? ' · ' + x.hoursNote : ''))); }); box.appendChild(pu); }
    if (!final && c.target && c.target.source !== 'MANPOWER_SYNC' && c.plan && c.plan.status === 'VALID') {
      var rv = el('button', 'btn-secondary', 'Use the Manpower plan instead of the manual target'); rv.id = 'zoRevertPlanBtn';
      rv.addEventListener('click', function () {
        if (!window.confirm('Replace the manual target of ' + c.zone + ' on ' + c.date + ' with the Manpower plan? (audited)')) return;
        busy = true; refreshGates();
        opCall('zoneTargetRevertToPlan', { zone: c.zone }).then(function (r) { busy = false; msg(r.ok ? 'Target now follows the Manpower plan. Reloading…' : 'Not changed: ' + r.error, !r.ok); load(); });
      });
      box.appendChild(rv);
    }
    if (c.config.errors.length) box.appendChild(el('div', 'notice', 'Configuration missing: ' + c.config.errors.join('; ')));
    if (!final) box.appendChild(el('div', c.blockers.length ? 'notice' : 'meta', c.blockers.length ? 'Finalize is blocked by: ' + c.blockers.join(' · ') : 'Nothing blocks finalization.'));
    var wrap = el('div', 'table-scroll'), t = el('table', 'data-table');
    var hr = el('tr');
    ['Employee', 'Code', 'Shift', 'Original in → out', 'Approved in → out', 'Actual / required', 'Diff.', 'Hours', 'Manager explanation of hours', 'Approval', 'Manager decisions (in order)', 'Agreement', 'Exceptions', ''].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    t.appendChild(hr);
    c.employees.forEach(function (e) {
      var tr = el('tr');
      [e.name + (e.source === 'MANUAL' ? ' [MANUAL / يدوي]' : (e.source !== 'BIOMETRIC' ? ' [' + e.source + ']' : '')), e.code, e.shift, (e.originalIn || '—') + ' → ' + (e.originalOut || '—'), (e.approvedIn || '—') + ' → ' + (e.approvedOut || '—') + (e.timeSource !== 'ORIGINAL' ? ' (' + e.timeSource + ')' : ''),
        (e.actualHours || '—') + ' / ' + (e.requiredHours || '—'), e.varianceHours || ''].forEach(function (v) { tr.appendChild(el('td', null, v)); });
      tr.appendChild(el('td', 'st-' + e.hoursStatus, e.hoursStatus + (e.hoursCategory ? ' — ' + e.hoursCategory.replace('_', ' ') : '')));
      var ex = el('td');
      if (e.explanationStatus !== 'NOT_REQUIRED') ex.appendChild(el('div', e.explanationStatus === 'PROVIDED' ? 'hours-ok' : 'hours-bad', e.explanationStatus === 'MISSING' ? 'EXPLANATION MISSING' : (e.explanationStatus === 'STALE' ? 'RE-CONFIRM (hours changed)' : 'Explanation provided')));
      (e.explanations || []).forEach(function (x) { ex.appendChild(el('div', null, x.name + ' (' + x.role + '): ' + x.decision + ' — ' + x.explanation + (x.recordedBy && x.recordedBy !== x.name ? ' · recorded by ' + x.recordedBy : '') + ' · ' + x.recordedAt)); });
      if (e.missingPunch) ex.appendChild(el('div', e.missingPunchAck ? 'hours-ok' : 'hours-bad', e.missingPunchAck ? 'Missing punch acknowledged by ' + e.missingPunchAck.by + ': ' + e.missingPunchAck.note : 'Missing punch - acknowledgment needed'));
      tr.appendChild(ex);
      tr.appendChild(el('td', null, e.approvalState + (e.officialDecision ? ' / ' + e.officialDecision : '')));
      var op = el('td');
      if (!e.opinions.length) op.textContent = '—';
      e.opinions.forEach(function (o, i) { op.appendChild(el('div', null, (i + 1) + '. ' + o.name + (o.managerId ? ' [' + o.managerId + ']' : '') + ' (' + o.role + '): ' + o.decision + (o.comment ? ' — ' + o.comment : '') + (o.decidedAt ? ' · ' + o.decidedAt : ''))); });
      tr.appendChild(op);
      tr.appendChild(el('td', e.agreement === 'DISAGREE' ? 'st-UNMATCHED' : null, e.agreement));
      tr.appendChild(el('td', 'meta', e.exceptions.join(' | ')));
      var act = el('td');
      if (!final) {
        if (e.hoursStatus === 'UNMATCHED' && e.approvalState !== 'REJECTED') addFormBtn(act, 'Record explanation…', function (h) { explainForm(h, c, e); });
        if (e.missingPunch && !e.missingPunchAck) addFormBtn(act, 'Acknowledge…', function (h) { ackForm(h, c, e.code, 'MISSING_PUNCH', 'Acknowledge the missing punch of ' + e.name); });
        if (e.approvalState === 'UNRESOLVED' || (e.source !== 'BIOMETRIC' && ['NONE', 'COMPLETED', 'EXPIRED', 'REVOKED'].indexOf(e.linkState) !== -1 && ['PENDING', 'NOT_SENT', 'NOT_REVIEWED'].indexOf(e.approvalState) !== -1)) addFormBtn(act, 'Resolve…', function (h) { resolveForm(h, c, e); });
      }
      tr.appendChild(act);
      t.appendChild(tr);
    });
    wrap.appendChild(t); box.appendChild(wrap);
    if ((c.orphanDecisions || []).length) {
      box.appendChild(el('div', 'group-title', 'Orphan decisions (official decision without an attendance record - never counted)'));
      c.orphanDecisions.forEach(function (o) {
        var row = el('div', 'meta', o.code + ' ' + o.name + ': ' + o.decision + ' by ' + (o.reviewer || '—') + ' (' + o.decidedAt + ') ' + (o.acknowledged ? '· acknowledged by ' + o.acknowledged.by + ': ' + o.acknowledged.note : '· acknowledgment needed '));
        if (!o.acknowledged && !final) addFormBtn(row, 'Acknowledge…', function (h) { ackForm(h, c, o.code, 'ORPHAN_DECISION', 'Acknowledge the orphan decision of ' + o.name); });
        box.appendChild(row);
      });
    }
    host.appendChild(box);
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function addFormBtn(host, label, fn) { var b = el('button', 'btn-secondary', label); b.addEventListener('click', function () { fn(host); }); host.appendChild(b); }
  function formShell(host, title) { clear(host); var p = el('div', 'confirm-box'); p.appendChild(el('div', null, title)); host.appendChild(p); return p; }
  function submitOp(panel, op, args, okText) {
    var go = el('button', 'btn-primary', 'Save'); var note = el('div', 'meta');
    go.addEventListener('click', function () {
      var a = args(); if (!a) return;
      go.disabled = true; note.textContent = 'Saving…';
      opCall(op, { opArgs: JSON.stringify(a) }).then(function (res) {
        if (!res.ok) { go.disabled = false; note.className = 'meta report-error'; note.textContent = res.error; return; }
        msg(okText + ' Reloading…'); load();
      });
    });
    panel.appendChild(go); panel.appendChild(note);
  }
  function explainForm(host, c, e) {
    var p = formShell(host, 'Record the Zone Manager\'s explanation for ' + e.name + ' (' + e.hoursCategory.replace('_', ' ') + ' ' + e.varianceHours + '). Managers normally do this in their own review link; here it is recorded as "provided by" them and "recorded by" you. The hours stay UNMATCHED.');
    var dec = el('select'); [['APPROVED', 'Approved'], ['REJECTED', 'Rejected']].forEach(function (o) { var x = el('option', null, o[1]); x.value = o[0]; dec.appendChild(x); });
    var by = el('input'); by.type = 'text'; by.placeholder = 'Explanation provided by (manager name)'; by.maxLength = 80;
    var tx = el('input'); tx.type = 'text'; tx.placeholder = 'Explanation (required)'; tx.maxLength = 500;
    [dec, by, tx].forEach(function (n) { p.appendChild(n); });
    submitOp(p, 'exceptionRecord', function () {
      if (by.value.trim().length < 2 || tx.value.trim().length < 5) { tx.focus(); return null; }
      return { zone: c.zone, employeeCode: e.code, group: 'HOURS', decision: dec.value, providedBy: by.value.trim(), explanation: tx.value.trim() };
    }, 'Explanation recorded.');
  }
  function ackForm(host, c, code, group, title) {
    var p = formShell(host, title + ' (recorded with your name; nothing is changed in the attendance).');
    var tx = el('input'); tx.type = 'text'; tx.placeholder = 'Acknowledgment note (required)'; tx.maxLength = 500; p.appendChild(tx);
    submitOp(p, 'exceptionRecord', function () { if (tx.value.trim().length < 5) { tx.focus(); return null; } return { zone: c.zone, employeeCode: code, group: group, explanation: tx.value.trim() }; }, 'Acknowledgment recorded.');
  }
  function resolveForm(host, c, e) {
    var p = formShell(host, 'Authorized resolution for ' + e.name + ' (recorded with your name; every manager opinion is kept).');
    var sel = el('select'); ['APPROVED', 'MODIFIED', 'REJECTED'].forEach(function (d) { var o = el('option', null, d); o.value = d; sel.appendChild(o); });
    var reason = el('input'); reason.type = 'text'; reason.placeholder = 'Reason (required)'; reason.maxLength = 400;
    var go = el('button', 'btn-primary', 'Record resolution'); var note = el('div', 'meta');
    go.addEventListener('click', function () {
      if (reason.value.trim().length < 5) { reason.focus(); return; }
      go.disabled = true;
      opCall('conflictResolve', { zone: c.zone, employeeCode: e.code, decision: sel.value, reason: reason.value.trim() }).then(function (res) {
        if (!res.ok) { go.disabled = false; note.className = 'meta report-error'; note.textContent = res.error; return; }
        msg('Resolution recorded (official: ' + res.official + '). Reloading…'); load();
      });
    });
    [sel, reason, go, note].forEach(function (n) { p.appendChild(n); });
  }

  // ---------------- 6. reports ----------------
  // PDF and Excel are independent: each button sends its own single request and produces only its own file.
  function isZipBytes(b) { return b && b.length > 100 && b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04; } // PK\3\4 (zip)
  function reportPdf(btn, approve) {
    var f = $('zoRepFrom').value, t = $('zoRepTo').value, zones = pickedZones(), t0 = Date.now();
    var layout = $('zoRepLayout') ? $('zoRepLayout').value : 'MANAGEMENT';
    var allEmp = layout === 'EXECUTIVE' && $('zoRepAllEmp') && $('zoRepAllEmp').checked;
    if (!zones.length) { repResult('Tick at least one zone.', true); return; }
    var label = btn.textContent; btn.disabled = true; btn.textContent = approve ? 'Approving…' : 'Generating…'; busy = true; refreshGates();
    var what = zones.map(zoneLabel).join(', ') + ', ' + (f === t ? f : f + ' to ' + t);
    repResult((approve ? 'Recording your approval and exporting ' : 'Generating ') + what + '…');
    A.call({ action: 'periodAnalytics', op: approve ? 'zoneReportApprove' : 'zoneReport', date: f, fromDate: f, toDate: t, zones: JSON.stringify(zones), output: 'pdf', pdfLayout: layout, pdfEmployees: allEmp ? 'ALL' : '' }, TIMEOUT_MS).then(function (res) {
      busy = false; btn.textContent = label; refreshGates(); repScope();
      var noun = approve ? 'Approval' : 'PDF';
      if (!res.ok) { repResult(noun + ' not completed: ' + res.error + (approve ? ' Nothing was approved.' : ''), true); return; }
      if (!res.pdfBase64) { repResult(noun + ': the server answered without a file. Nothing was downloaded - please try again.', true); return; }
      var zip = res.pdfMime === 'application/zip', bytes;
      try { bytes = b64ToBytes(res.pdfBase64); } catch (err) { repResult('The file could not be decoded (' + (err && err.message ? err.message : err) + ').', true); return; }
      if (zip ? !isZipBytes(bytes) : !isPdfBytes(bytes)) { repResult('The server returned data that is not a ' + (zip ? 'ZIP' : 'PDF') + ' file. Nothing was downloaded.', true); return; }
      try {
        offerFile(approve ? 'approved' : 'pdf', bytes, res.pdfFileName, res.pdfMime || 'application/pdf');
        var files = (res.pdfFiles || []).map(function (x) { return zoneLabel(x.zone || 'combined') + ' (' + x.pages + ' p, ' + x.employees + ' employee' + (x.employees === 1 ? '' : 's') + ', ' + x.state + ')'; }).join('; ');
        var apText = '';
        if (approve && res.approvals && res.approvals.length) {
          var a0 = res.approvals[0];
          apText = ' APPROVED for distribution by ' + a0.approvedBy + ' at ' + a0.approvedAt + ' - ' + res.approvals.map(function (a) { return a.zone + ': ' + a.approvalId + (a.alreadyApproved ? ' (already approved, same figures)' : ''); }).join('; ') + '.';
          if (last && f === t && last.date === f) { // the zone table shows the approval at once (no reload)
            res.approvals.forEach(function (a) { last.zones.forEach(function (z) { if (z.zone === a.zone) z.approval = { id: a.approvalId, approvedAt: a.approvedAt, approvedBy: a.approvedBy, current: true }; }); });
            render(last); fillZonePicker(last); repScope(); refreshGates();
          }
        }
        repResult((zip ? 'ZIP ready' : 'PDF ready') + ' in ' + Math.round((Date.now() - t0) / 100) / 10 + ' s - ' + res.pdfFileName + (zip ? ' = ' + (res.pdfFiles || []).length + ' separate PDFs' : '') + ': ' + files + '.' + apText +
          ' Snapshot ' + String(res.bundleHash).slice(0, 12) + '. Your browser should save it now; if no file appears, click "Save ' + res.pdfFileName + '" below.');
      } catch (err) { repResult('Could not save the file: ' + (err && err.message ? err.message : err), true); }
    });
  }
  function reportExcel(btn) {
    var f = $('zoRepFrom').value, t = $('zoRepTo').value, zones = pickedZones(), t0 = Date.now();
    if (!zones.length) { repResult('Tick at least one zone.', true); return; }
    var label = btn.textContent; btn.disabled = true; btn.textContent = 'Generating Excel…'; busy = true; refreshGates();
    repResult('Generating the Excel file for ' + zones.map(zoneLabel).join(', ') + ', ' + (f === t ? f : f + ' to ' + t) + '…');
    A.call({ action: 'periodAnalytics', op: 'zoneReport', date: f, fromDate: f, toDate: t, zones: JSON.stringify(zones), pdf: 'false' }, TIMEOUT_MS).then(function (res) {
      busy = false; btn.textContent = label; refreshGates(); repScope();
      if (!res.ok) { repResult('Excel not created: ' + res.error, true); return; }
      if (!Array.isArray(res.reports)) { repResult('Excel not created: the server answered without report data.', true); return; }
      try {
        var bytes = window.HMGXlsx.build(window.HMGZoneOpsExport.workbookSheets(res)), name = window.HMGZoneOpsExport.fileName(res);
        if (!isXlsxBytes(bytes)) { repResult('Excel not created: the workbook could not be built.', true); return; }
        offerFile('xlsx', bytes, name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        var n = res.reports.reduce(function (a, r) { return a + r.content.employees.length; }, 0);
        repResult('Excel ready in ' + Math.round((Date.now() - t0) / 100) / 10 + ' s - ' + name + ' (' + (res.allFinal ? 'FINAL' : 'DRAFT') + ', ' + res.reports.length + ' zone-day(s), ' + n + ' employee record(s)' +
          (Array.isArray(res.unassigned) ? ', ' + res.unassigned.length + ' unassigned record(s) in their own sheet' : '') + ', snapshot ' +
          String(res.bundleHash).slice(0, 12) + '). Your browser should save it now; if no file appears, click "Save ' + name + '" below.');
      } catch (err) { repResult('Could not build the Excel file: ' + (err && err.message ? err.message : err), true); }
    });
  }

  // ---------------- 7. finalize ----------------
  function askFinalize(z) {
    var host = $('zoDetail'); clear(host);
    var c = z.content, panel = el('div', 'confirm-box');
    panel.appendChild(el('div', 'group-title', 'Finalize ' + z.zone + ' for ' + fmtDay(last.date) + '?'));
    if (c.blockers.length) {
      panel.appendChild(el('div', 'report-error', 'Cannot be finalized yet:'));
      var ul = el('ul'); c.blockers.forEach(function (b) { ul.appendChild(el('li', null, b)); }); panel.appendChild(ul);
      var cl = el('button', 'btn-secondary', 'Close'); cl.addEventListener('click', function () { clear(host); }); panel.appendChild(cl);
      host.appendChild(panel); return;
    }
    panel.appendChild(el('div', 'meta', 'A FINAL report is stored as an immutable snapshot (SHA-256) and never changed afterwards. The server re-checks everything before storing it.'));
    var cancel = el('button', 'btn-secondary', 'Cancel'); cancel.addEventListener('click', function () { clear(host); });
    var go = el('button', 'btn-primary', 'Finalize');
    go.addEventListener('click', function () {
      go.disabled = true; cancel.disabled = true;
      opCall('zoneReportFinalize', { zone: z.zone }).then(function (res) {
        clear(host);
        if (!res.ok) { host.appendChild(el('div', 'notice', 'Not finalized: ' + (res.blockers ? res.blockers.join(' · ') : res.error))); msg('Finalize refused - see the reasons below.', true); return; }
        msg(res.alreadyFinal ? res.message : 'FINAL version ' + res.version + ' stored (snapshot ' + String(res.hash).slice(0, 12) + '). Reloading…');
        load();
      });
    });
    panel.appendChild(cancel); panel.appendChild(go);
    host.appendChild(panel);
  }

  // ---------------- supplementary attendance ----------------
  function renderSupplements(res) {
    var host = $('zoSuppList'); clear(host);
    $('zoSuppDateLabel').textContent = 'Claims for operational day ' + fmtDay(res.date) + '.';
    if (!res.supplements.length) { host.appendChild(el('div', 'meta', 'No supplementary claims or manual attendance for this date.')); return; }
    var t = el('table', 'data-table'), hr = el('tr');
    ['Type', 'Zone', 'Employee', 'Code', 'In', 'Out', 'Reason', 'Status', 'Submitted by', 'Verified by', ''].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    t.appendChild(hr);
    res.supplements.forEach(function (s) {
      var tr = el('tr');
      [s.mode === 'MANUAL' ? 'MANUAL / يدوي' : 'Claim', s.zone + (s.area ? ' · ' + s.area : ''), s.name, s.code, s.claimedIn || '—', s.claimedOut || '—', s.reason, s.status, s.submittedBy + ' · ' + s.submittedAt, s.verifiedBy ? s.verifiedBy + ' · ' + s.verifiedAt : '—'].forEach(function (v) { tr.appendChild(el('td', null, v)); });
      var act = el('td');
      if (s.status === 'SUBMITTED' || s.status === 'MANUAL') {
        var wb = el('button', 'btn-secondary', 'Withdraw');
        wb.addEventListener('click', function () { wb.disabled = true; opCall('supplementaryWithdraw', { supplementId: s.supplementId }).then(function (r) { if (!r.ok) { wb.disabled = false; msg('Error: ' + r.error, true); return; } load(); }); });
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
    var manual = manualMode();
    if (manual) { p.area = $('zoSuppArea').value; if (!p.area) { msg('Choose the event / area.', true); return; } }
    busy = true; refreshGates(); msg((manual ? 'Saving the manual attendance / حفظ التحضير اليدوي for ' : 'Submitting the supplementary claim for ') + $('zoDate').value + '…');
    opCall(manual ? 'manualAttendanceSubmit' : 'supplementarySubmit', p).then(function (res) {
      busy = false; refreshGates();
      if (!res.ok) { msg('Error: ' + res.error, true); return; }
      ['zoSuppCode', 'zoSuppName', 'zoSuppShift', 'zoSuppIn', 'zoSuppOut', 'zoSuppReason'].forEach(function (id) { $(id).value = ''; }); $('zoSuppNext').checked = false;
      msg(res.message + ' Reloading…'); load();
    });
  }

  // ---------------- init ----------------
  ['zoDate', 'zoRepFrom', 'zoRepTo'].forEach(function (id) { $(id).setAttribute('autocomplete', 'off'); });
  $('zoDate').value = A.todayRiyadh();
  A.onChange(paintAccess);
  $('zoCheckAccessBtn').addEventListener('click', function () { A.check(); });
  $('zoSignInBtn').addEventListener('click', function () { $('zoSignInBox').hidden = false; $('zoAccessLink').focus(); });
  $('zoUseLinkBtn').addEventListener('click', function () {
    var ok = A.useAccessLink($('zoAccessLink').value);
    $('zoAccessLink').value = '';
    if (!ok) { $('zoAccessDetail').textContent = 'That does not look like an access link. Paste the full link you received (it contains "adminToken=").'; return; }
    A.check();
  });
  $('zoEnrollBtn').addEventListener('click', function () {
    var b = $('zoEnrollBtn'); b.disabled = true; b.textContent = 'Enrolling… (up to a minute)';
    A.enrollThisDevice().then(function (r) {
      b.textContent = 'Remember this device';
      if (!r.ok) { $('zoAccessDetail').textContent = 'Enrollment failed: ' + r.error; paintAccess(A.state()); return; }
      A.check().then(function () { $('zoAccessDetail').textContent = 'This browser is now enrolled: Zone Operations and Period Analytics work here without the link. (It can be revoked by the owner at any time.)'; });
    });
  });
  $('zoForgetBtn').addEventListener('click', function () { A.forgetThisDevice(); });
  $('zoTodayBtn').addEventListener('click', function () { setOpDate(A.todayRiyadh()); });
  $('zoYesterdayBtn').addEventListener('click', function () { setOpDate(shiftDays(A.todayRiyadh(), -1)); });
  $('zoDate').addEventListener('change', onDateChange);
  $('zoDate').addEventListener('input', onDateChange);
  ['zoRepFrom', 'zoRepTo'].forEach(function (id) { $(id).addEventListener('change', function () { reportDatesLinked = false; repLabel(); }); });
  $('zoRepSameBtn').addEventListener('click', function () { reportDatesLinked = true; $('zoRepFrom').value = $('zoDate').value; $('zoRepTo').value = $('zoDate').value; repLabel(); });
  $('zoZone').addEventListener('change', function () { if (last) render(last); });
  ['zoRepLayout', 'zoRepAllEmp'].forEach(function (id) { if ($(id)) $(id).addEventListener('change', repScope); });
  $('zoRepAllBtn').addEventListener('click', function () { document.querySelectorAll('#zoRepZones input[type=checkbox]').forEach(function (b) { if (b.value !== '__UNASSIGNED__') b.checked = true; }); repScope(); refreshGates(); });
  $('zoRepNoneBtn').addEventListener('click', function () { document.querySelectorAll('#zoRepZones input[type=checkbox]').forEach(function (b) { b.checked = false; }); repScope(); refreshGates(); });
  $('zoLoadBtn').addEventListener('click', load);
  $('zoSaveBtn').addEventListener('click', saveTargets);
  $('zoCopyPrevBtn').addEventListener('click', copyPrevious);
  $('zoRepPdfBtn').addEventListener('click', function () { reportPdf($('zoRepPdfBtn'), false); });
  $('zoRepApproveBtn').addEventListener('click', function () { reportPdf($('zoRepApproveBtn'), true); }); // the click IS the approval (one explicit action)
  $('zoRepXlsxBtn').addEventListener('click', function () { reportExcel($('zoRepXlsxBtn')); });
  $('zoSuppSubmitBtn').addEventListener('click', submitSupplement);
  ['zoSuppMode', 'zoSuppZone'].forEach(function (id) { $(id).addEventListener('change', fillSuppAreas); });
  $('zoSuppArea').addEventListener('change', refreshGates);
  if ($('periodTo')) $('periodTo').addEventListener('change', onDateChange);
  window.addEventListener('pageshow', function (ev) { if (ev.persisted) onDateChange(); }); // a back/forward restore must not show a stale date silently
  window.addEventListener('load', onDateChange); // control.js (loaded after this file) sets the review period - compare with it once it exists
  onDateChange();
  paintAccess(A.state());
  A.check();
})();
