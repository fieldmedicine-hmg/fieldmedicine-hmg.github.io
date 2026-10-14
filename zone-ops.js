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
  function staffText(x) {
    if (!x) return '—';
    var d = x.diff === null || x.diff === undefined ? '' : (x.diff < 0 ? ' SHORTAGE ' + (-x.diff) : (x.diff > 0 ? ' EXCESS ' + x.diff : ''));
    return (x.required === null || x.required === undefined ? '—' : x.required) + ' req / ' + x.approved + ' appr' + (x.unresolved ? ' (+' + x.unresolved + ' open)' : '') + ' · ' + x.status + (x.status === 'UNMATCHED' ? ' —' + d : '');
  }
  function staffCell(x) { var td = el('td'); td.appendChild(el('span', 'st-' + (x ? x.status : 'NO_TARGET'), staffText(x))); return td; }

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
    gate($('zoRepPdfBtn'), repReason);
    gate($('zoRepXlsxBtn'), repReason);
    gate($('zoSuppSubmitBtn'), noAccess || (busy ? 'Working…' : '') || (last && last.date === date ? '' : 'Load the zones of the operational date first (the claim is for that date).'));
  }
  function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000) + 1; }

  // ---------------- 2. dates ----------------
  function setOpDate(k) { $('zoDate').value = k; onDateChange(); }
  function onDateChange() {
    var k = $('zoDate').value;
    $('zoDateLabel').textContent = k ? 'Operational day: ' + fmtDay(k) + ' (Asia/Riyadh). Daily targets, compliance, supplementary claims and Finalize use THIS one day.' : 'Choose the operational date.';
    var pTo = $('periodTo') ? $('periodTo').value : '';
    var syncBtn = $('zoUsePeriodBtn');
    if (pTo && pTo !== k) { syncBtn.hidden = false; syncBtn.textContent = 'Use review period end (' + pTo + ')'; } else syncBtn.hidden = true;
    if (reportDatesLinked) { $('zoRepFrom').value = k; $('zoRepTo').value = k; repLabel(); }
    if (last && last.date !== k) { clear($('zoHost')); clear($('zoDetail')); msg('The operational date changed - press "Load zones" for ' + k + '.'); }
    refreshGates();
  }
  function repLabel() {
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
  function fillZoneSelects(res) {
    ['zoZone', 'zoRepZone', 'zoSuppZone'].forEach(function (id) {
      var sel = $(id), cur = sel.value; clear(sel);
      if (id !== 'zoSuppZone') { var all = el('option', null, 'All zones'); all.value = ''; sel.appendChild(all); }
      res.zones.forEach(function (z) { var o = el('option', null, z.zone + (z.content.config.mode === 'NOT_CONFIGURED' ? ' (not configured)' : '')); o.value = z.zone; sel.appendChild(o); });
      if (cur && res.zones.some(function (z) { return z.zone === cur; })) sel.value = cur;
    });
  }
  function shown(res) { var f = $('zoZone').value; return res.zones.filter(function (z) { return !f || z.zone === f; }); }
  function render(res) {
    var host = $('zoHost'); clear(host); clear($('zoDetail'));
    host.appendChild(el('div', 'meta', 'Showing operational day ' + fmtDay(res.date) + (($('zoZone').value) ? ' · zone ' + $('zoZone').value : ' · all zones') + '. Required / approved per shift; "open" = pending or unresolved records, never counted as absence.'));
    var wrap = el('div', 'table-scroll'), t = el('table', 'data-table zo-table');
    var hr = el('tr');
    ['Zone', 'Configuration', 'Required hours', 'Target: Morning', 'Night', 'Daily total', 'Previous day', 'Morning', 'Night', 'Daily total', 'Unique / coverage', 'Hours exceptions', 'Open records', 'Report', 'Actions'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
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
      var pt = z.previousTarget;
      tr.appendChild(el('td', 'meta', pt ? (pt.mode === 'MORNING_NIGHT' ? pt.morning + ' + ' + pt.night : pt.daily) : '—'));
      tr.appendChild(mode === 'MORNING_NIGHT' ? staffCell(c.staffing.morning) : el('td', null, '—'));
      tr.appendChild(mode === 'MORNING_NIGHT' ? staffCell(c.staffing.night) : el('td', null, '—'));
      tr.appendChild(staffCell(c.staffing.total));
      tr.appendChild(el('td', null, c.staffing.uniqueHeadcount + ' / ' + c.staffing.shiftCoverage));
      tr.appendChild(el('td', c.counts.hoursExplanationMissing ? 'st-UNMATCHED' : null, c.counts.hoursUnmatched + (c.counts.hoursExplanationMissing ? ' (' + c.counts.hoursExplanationMissing + ' need explanation)' : '')));
      tr.appendChild(el('td', null, c.counts.pending + c.counts.notReviewed + c.counts.unresolved));
      tr.appendChild(el('td', null, final ? 'FINAL v' + z.report.version + (z.report.liveChanged ? ' (live data changed since)' : '') + (z.report.integrityOk === false ? ' ⚠ INTEGRITY' : '') : 'DRAFT'));
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
    if (!list.length) { msg('Enter at least one target first (configured zones only).', true); return; }
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
    var mode = sel([['MORNING_NIGHT', 'Morning + Night'], ['SINGLE', 'Single shift'], ['FLEXIBLE', 'Flexible / no fixed shift']], c.config.mode === 'NOT_CONFIGURED' ? 'MORNING_NIGHT' : c.config.mode);
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
      groups.HOURS.forEach(function (n) { n.hidden = m === 'MORNING_NIGHT'; });
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
    if (c.config.errors.length) box.appendChild(el('div', 'notice', 'Configuration missing: ' + c.config.errors.join('; ')));
    if (!final) box.appendChild(el('div', c.blockers.length ? 'notice' : 'meta', c.blockers.length ? 'Finalize is blocked by: ' + c.blockers.join(' · ') : 'Nothing blocks finalization.'));
    var wrap = el('div', 'table-scroll'), t = el('table', 'data-table');
    var hr = el('tr');
    ['Employee', 'Code', 'Shift', 'Original in → out', 'Approved in → out', 'Actual / required', 'Diff.', 'Hours', 'Manager explanation of hours', 'Approval', 'Manager decisions (in order)', 'Agreement', 'Exceptions', ''].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    t.appendChild(hr);
    c.employees.forEach(function (e) {
      var tr = el('tr');
      [e.name + (e.source !== 'BIOMETRIC' ? ' [' + e.source + ']' : ''), e.code, e.shift, (e.originalIn || '—') + ' → ' + (e.originalOut || '—'), (e.approvedIn || '—') + ' → ' + (e.approvedOut || '—') + (e.timeSource !== 'ORIGINAL' ? ' (' + e.timeSource + ')' : ''),
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
  function report(withPdf, btn) {
    var f = $('zoRepFrom').value, t = $('zoRepTo').value, zone = $('zoRepZone').value;
    var label = btn.textContent; btn.disabled = true; btn.textContent = 'Generating…'; busy = true; refreshGates();
    msg('Generating the ' + (zone || 'All-Zones') + ' report for ' + (f === t ? f : f + ' to ' + t) + (withPdf ? ' (PDF + Excel from one snapshot)' : '') + '…');
    A.call({ action: 'periodAnalytics', op: 'zoneReport', date: f, fromDate: f, toDate: t, zone: zone, pdf: withPdf ? 'true' : 'false' }, TIMEOUT_MS).then(function (res) {
      busy = false; btn.textContent = label; refreshGates();
      if (!res.ok) { msg('Error: ' + res.error, true); return; }
      try {
        download(window.HMGXlsx.build(window.HMGZoneOpsExport.workbookSheets(res)), window.HMGZoneOpsExport.fileName(res), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        if (withPdf && res.pdfBase64) download(b64ToBytes(res.pdfBase64), res.pdfFileName, 'application/pdf');
        msg('Report ' + (res.allFinal ? 'FINAL' : 'DRAFT') + ' downloaded: ' + res.reports.length + ' zone-day(s), ' + (res.days ? res.days.length : 1) + ' day(s), snapshot ' + String(res.bundleHash).slice(0, 12) + '.' +
          (withPdf && res.pdfIncludesEmployees === false ? ' The PDF holds the summaries; employee detail for this long period is in the Excel file.' : ''));
      } catch (err) { msg('Could not build the file: ' + (err && err.message ? err.message : err), true); }
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
    if (!p.zone || !p.employeeCode || !p.employeeName || !p.reason || (!p.checkin && !p.checkout)) { msg('Zone, employee code and name, at least one claimed time and a reason are required.', true); return; }
    busy = true; refreshGates(); msg('Submitting the supplementary claim for ' + $('zoDate').value + '…');
    opCall('supplementarySubmit', p).then(function (res) {
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
  $('zoUsePeriodBtn').addEventListener('click', function () { if ($('periodTo') && $('periodTo').value) setOpDate($('periodTo').value); });
  $('zoDate').addEventListener('change', onDateChange);
  $('zoDate').addEventListener('input', onDateChange);
  ['zoRepFrom', 'zoRepTo'].forEach(function (id) { $(id).addEventListener('change', function () { reportDatesLinked = false; repLabel(); }); });
  $('zoRepSameBtn').addEventListener('click', function () { reportDatesLinked = true; $('zoRepFrom').value = $('zoDate').value; $('zoRepTo').value = $('zoDate').value; repLabel(); });
  $('zoZone').addEventListener('change', function () { if (last) render(last); var z = $('zoZone').value; if (z) $('zoRepZone').value = z; });
  $('zoLoadBtn').addEventListener('click', load);
  $('zoSaveBtn').addEventListener('click', saveTargets);
  $('zoCopyPrevBtn').addEventListener('click', copyPrevious);
  $('zoRepPdfBtn').addEventListener('click', function () { report(true, $('zoRepPdfBtn')); });
  $('zoRepXlsxBtn').addEventListener('click', function () { report(false, $('zoRepXlsxBtn')); });
  $('zoSuppSubmitBtn').addEventListener('click', submitSupplement);
  if ($('periodTo')) $('periodTo').addEventListener('change', onDateChange);
  window.addEventListener('pageshow', function (ev) { if (ev.persisted) onDateChange(); }); // a back/forward restore must not show a stale date silently
  window.addEventListener('load', onDateChange); // control.js (loaded after this file) sets the review period - compare with it once it exists
  onDateChange();
  paintAccess(A.state());
  A.check();
})();
