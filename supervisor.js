// Attendance Supervisor page (2026-11-12): corrections queue, shift schedule, history.
// Credential = the supervisor's personal access link (?adminToken=...) read once by access.js; an Analytics Admin gets read-only access.
// All data is inserted with textContent (never innerHTML). Every write is confirmed first and sent once per attempt (requestId).
(function () {
  'use strict';
  var A = window.HMGAccess;
  var $ = function (id) { return document.getElementById(id); };
  var TIMEOUT_MS = 120000;
  var who = null; // svWhoAmI answer
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function canWrite() { return !!(who && who.canWrite && who.role === 'SUPERVISOR'); }
  function shiftDays(k, n) { var d = new Date(k + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function newId() {
    var a = '';
    try { var u = new Uint8Array(16); window.crypto.getRandomValues(u); for (var i = 0; i < u.length; i++) a += ('0' + u[i].toString(16)).slice(-2); } catch (e) { a = ''; }
    if (!a) for (var j = 0; j < 32; j++) a += Math.floor(Math.random() * 16).toString(16);
    return 'sv' + a;
  }
  function setMsg(id, text, isError) { var m = $(id); m.textContent = text || ''; m.className = isError ? 'meta report-error' : 'meta'; }
  /** One backend call: body shape required by the Worker (fromDate always present). */
  function op(name, args, from, to) {
    var f = from || A.todayRiyadh(), t = to || f;
    return A.call({ action: 'periodAnalytics', op: name, date: f, fromDate: f, toDate: t, opArgs: JSON.stringify(args || {}) }, TIMEOUT_MS);
  }
  function setOptions(sel, values) {
    var keep = sel.value; clear(sel);
    var o = el('option', null, 'All'); o.value = ''; sel.appendChild(o);
    (values || []).forEach(function (v) { var x = el('option', null, v); x.value = v; sel.appendChild(x); });
    sel.value = keep;
    if (sel.value !== keep) sel.value = '';
  }
  function validTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v || ''); }
  function toMin(v) { var p = String(v).split(':'); return (+p[0]) * 60 + (+p[1]); }
  function fmtMin(m) { return Math.floor(m / 60) + 'h ' + ('0' + (m % 60)).slice(-2) + 'm'; }
  function table(headers, rows, cls) {
    var t = el('table', 'data-table' + (cls ? ' ' + cls : '')), hr = el('tr');
    headers.forEach(function (h) { hr.appendChild(el('th', null, h)); });
    var th = el('thead'); th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody'); rows.forEach(function (r) { tb.appendChild(r); }); t.appendChild(tb);
    var w = el('div', 'table-scroll'); w.appendChild(t); return w;
  }
  function tr(values) { var r = el('tr'); values.forEach(function (v) { var td = el('td', null, v === undefined || v === null || v === '' ? '—' : v); td.setAttribute('dir', 'auto'); r.appendChild(td); }); return r; }

  // ---------------- access + tabs ----------------
  function paintAccess(st) {
    var s = $('svAccessState'); s.textContent = st.code; s.className = 'access-state access-' + st.code;
    $('svAccessWho').textContent = st.signedInAs ? 'Signed in as ' + st.signedInAs : '';
    $('svAccessDetail').textContent = st.detail || '';
  }
  function showTab(name) {
    ['queue', 'schedule', 'history'].forEach(function (t) {
      var pane = $('svPane' + t.charAt(0).toUpperCase() + t.slice(1)), tab = $('svTab' + t.charAt(0).toUpperCase() + t.slice(1));
      pane.hidden = t !== name; tab.className = t === name ? 'btn-primary' : 'btn-secondary'; tab.setAttribute('aria-selected', t === name ? 'true' : 'false');
    });
  }
  function applyRole() {
    var b = $('svRoleBanner');
    if (who.role === 'ADMIN_READONLY') { b.hidden = false; b.textContent = 'Read-only (administrator) / للقراءة فقط (مدير النظام)'; } else b.hidden = true;
    $('sAssign').hidden = !canWrite();
    $('aTol').value = who.toleranceDefaultMin || 5;
    var today = A.todayRiyadh(), y = shiftDays(today, -1);
    $('qFrom').value = y; $('qTo').value = today;
    $('sFrom').value = today; $('sTo').value = shiftDays(today, 6);
    $('hFrom').value = shiftDays(today, -30); $('hTo').value = today;
    $('aFrom').value = today;
    $('svMain').hidden = false;
    assignPreview();
  }
  function start() {
    // access.js has already read ?adminToken= into memory: take the personal credential out of the address bar / history right away
    try { if (/[?&]adminToken=/.test(location.search)) history.replaceState(null, '', location.pathname); } catch (e) { /* best effort */ }
    A.onChange(paintAccess);
    paintAccess(A.state());
    A.check().then(function (st) {
      if (st.code !== 'AUTHORIZED') {
        $('svMain').hidden = true;
        $('svAccessDetail').textContent = (st.detail || '') + ' Open your personal supervisor link (supervisor.html?adminToken=...). / افتح رابطك الشخصي.';
        return;
      }
      op('svWhoAmI', {}).then(function (r) {
        if (!r.ok) { $('svAccessDetail').textContent = 'You are not an attendance supervisor: ' + (r.error || r.code || ''); $('svMain').hidden = true; return; }
        who = r; applyRole();
        if (canWrite()) loadQueue();
        else { showTab('history'); setMsg('qStatus', 'The corrections queue is available to the designated attendance supervisor only. / قائمة التصحيح متاحة لمشرف الحضور فقط.'); }
      });
    });
  }

  // ---------------- corrections queue ----------------
  var cases = [];
  function qArgs() {
    var a = { from: $('qFrom').value, to: $('qTo').value };
    if ($('qZone').value) a.zone = $('qZone').value;
    if ($('qEvent').value) a.event = $('qEvent').value;
    if ($('qCode').value.trim()) a.code = $('qCode').value.trim();
    return a;
  }
  function loadQueue(note) {
    var a = qArgs();
    if (!a.from || !a.to || a.from > a.to) { setMsg('qStatus', 'Choose a valid date range.', true); return; }
    $('qLoad').disabled = true; setMsg('qStatus', 'Loading…');
    op('svQueue', a, a.from, a.to).then(function (r) {
      $('qLoad').disabled = false;
      if (!r.ok) { setMsg('qStatus', 'Could not load: ' + r.error, true); return; }
      cases = r.cases || [];
      setOptions($('qZone'), r.zones); setOptions($('qEvent'), r.events);
      var b = r.blocked || {}, bx = $('qBlocked');
      bx.hidden = false;
      bx.textContent = 'Not listed (not yet approved by Zone Managers or already closed): awaiting Zone Manager ' + (b.AWAITING_ZONE_MANAGER || 0) + ' · rejected by Zone Manager ' + (b.ZM_REJECTED || 0) + ' · FINAL ' + (b.FINAL || 0) + '. / الحالات غير المعتمدة من مدير المنطقة لا تظهر هنا.';
      setMsg('qStatus', (note ? note + ' ' : '') + cases.length + ' case(s).');
      renderQueue();
    });
  }
  function renderQueue() {
    var host = $('qList'); clear(host);
    if (!cases.length) { host.appendChild(el('div', 'empty-note', 'No cases in this range.')); return; }
    var sorted = cases.slice().sort(function (x, y) { return (x.workDate + '|' + x.zone + '|' + x.event + '|' + x.employeeCode).localeCompare(y.workDate + '|' + y.zone + '|' + y.event + '|' + y.employeeCode); });
    var lastDay = '', lastZE = '';
    sorted.forEach(function (c) {
      if (c.workDate !== lastDay) { host.appendChild(el('div', 'day-header', c.workDate)); lastDay = c.workDate; lastZE = ''; }
      var ze = c.zone + '|' + c.event;
      if (ze !== lastZE) { host.appendChild(el('div', 'group-title', (c.zone || '—') + ' · ' + (c.event || '—'))); lastZE = ze; }
      var holder = el('div', 'sv-case'); holder.setAttribute('data-case', c.caseKey); host.appendChild(holder);
      renderCase(holder, c);
    });
  }
  function line(label, value) { var d = el('div', 'meta'); d.appendChild(el('b', null, label + ': ')); var s = el('span', null, value === undefined || value === null || value === '' ? '—' : value); s.setAttribute('dir', 'auto'); d.appendChild(s); return d; }
  function hhmm(s) { return s ? String(s).slice(-5) : ''; }
  function renderCase(holder, c) {
    clear(holder);
    var top = el('div', 'emp-top'); top.appendChild(el('span', 'emp-name', c.employeeName)); top.lastChild.setAttribute('dir', 'auto');
    top.appendChild(el('span', 'emp-code', '#' + c.employeeCode + ' · ' + (c.designation || '')));
    top.appendChild(el('span', 'tag tag-' + (c.state === 'OPEN' ? 'PENDING' : c.state === 'CORRECTED' ? 'MODIFIED' : 'APPROVED'), c.state + ' v' + c.version));
    holder.appendChild(top);
    var s = c.scheduledShift;
    holder.appendChild(line('Scheduled shift / الوردية', s ? s.start + ' - ' + s.end + (s.endDate && s.endDate !== c.workDate ? ' (+1d ' + s.endDate + ')' : '') + ' · ' + fmtMin(s.durationMin) + ' · tolerance ' + s.toleranceMin + ' min' : 'No schedule'));
    holder.appendChild(line('Recorded / المسجل', 'In ' + (c.recorded.checkIn || 'MISSING') + ' · Out ' + (c.recorded.checkOut || 'MISSING')));
    holder.appendChild(line('Missing / الناقص', (c.missing || []).join(', ') || 'none'));
    holder.appendChild(line('Issues / الملاحظات', (c.issues || []).join(', ')));
    holder.appendChild(line('Status / الحالة', c.attendanceStatus));
    var ap = c.approval || {};
    holder.appendChild(line('Zone Manager approval / اعتماد مدير المنطقة', (ap.gate || '—') + ' · ' + (ap.decision || '') + ' · ' + (ap.reviewer || '') + ' · ' + (ap.reviewedAt || '')));
    if (c.correction) holder.appendChild(line('Current correction / التصحيح الحالي', c.correction.type + ' v' + c.correction.version + ' · In ' + (c.correction.approvedIn || '—') + ' · Out ' + (c.correction.approvedOut || '—') + ' · ' + (c.correction.supervisor || '') + ' · ' + (c.correction.appliedAt || '')));
    var res = el('div', 'meta'); res.setAttribute('role', 'status'); res.setAttribute('aria-live', 'polite');
    if (canWrite()) holder.appendChild(caseForm(holder, c, res)); else holder.appendChild(el('div', 'meta', 'Read-only.'));
    holder.appendChild(res);
  }
  function modeSelect(missing, hasShift) {
    var sel = el('select');
    [['KEEP', 'Keep recorded / إبقاء'], ['SCHEDULE', 'Use scheduled time / وقت الوردية'], ['SET', 'Set time / تحديد وقت']].forEach(function (m) {
      var o = el('option', null, m[1]); o.value = m[0];
      if (m[0] === 'KEEP' && missing) o.disabled = true;
      if (m[0] === 'SCHEDULE' && !hasShift) o.disabled = true;
      sel.appendChild(o);
    });
    return sel;
  }
  function caseForm(holder, c, res) {
    var form = el('div', 'filter-bar'), sg = c.suggested || {}, hasShift = !!c.scheduledShift;
    var missIn = (c.missing || []).indexOf('CHECK_IN') !== -1, missOut = (c.missing || []).indexOf('CHECK_OUT') !== -1;
    function field(label, node) { var f = el('div', 'filter-field'); f.appendChild(el('label', null, label)); f.appendChild(node); form.appendChild(f); return f; }
    var inMode = modeSelect(missIn, hasShift), inTime = el('input'), outMode = modeSelect(missOut, hasShift), outTime = el('input'), next = el('input');
    inTime.type = 'time'; outTime.type = 'time'; next.type = 'checkbox';
    inTime.value = sg.checkIn || hhmm(c.recorded.checkIn); outTime.value = sg.checkOut || hhmm(c.recorded.checkOut); next.checked = !!sg.checkOutNextDay;
    // default = the suggestion: a missing punch -> the shift boundary (or a time to set); a recorded punch outside the shift -> the boundary
    function dflt(missing, sugg, bound, recorded) { return missing ? (hasShift ? 'SCHEDULE' : 'SET') : (hasShift && sugg && sugg === bound && hhmm(recorded) !== bound ? 'SCHEDULE' : 'KEEP'); }
    inMode.value = dflt(missIn, sg.checkIn, hasShift ? c.scheduledShift.start : '', c.recorded.checkIn);
    outMode.value = dflt(missOut, sg.checkOut, hasShift ? c.scheduledShift.end : '', c.recorded.checkOut);
    var reason = el('input'), evidence = el('input');
    reason.type = 'text'; reason.maxLength = 500; reason.setAttribute('dir', 'auto'); reason.style.width = '18em';
    evidence.type = 'text'; evidence.maxLength = 500; evidence.setAttribute('dir', 'auto'); evidence.style.width = '18em';
    var lbIn = field('Check-in / الدخول', inMode), tIn = field('Time (in)', inTime);
    var lbOut = field('Check-out / الخروج', outMode), tOut = field('Time (out)', outTime), tNext = field('Next day / اليوم التالي', next);
    field('Reason (required) / السبب', reason); field('Evidence (required for SET) / الدليل', evidence);
    var apply = el('button', 'btn-primary', 'Apply correction / تطبيق التصحيح'), conf = el('button', 'btn-secondary', 'Confirm times as correct / تأكيد الأوقات');
    apply.type = 'button'; conf.type = 'button';
    var bf = el('div', 'filter-field'); bf.appendChild(apply); bf.appendChild(conf); form.appendChild(bf);
    if (sg.basis) res.textContent = 'Suggestion: ' + sg.basis;
    if ((c.missing || []).length) { conf.disabled = true; conf.title = 'Cannot confirm while a punch is missing.'; }
    if (c.state === 'CORRECTED') { conf.disabled = true; conf.title = 'This record already carries an approved correction - apply a new correction to change it.'; }
    function sync() { tIn.hidden = inMode.value !== 'SET'; tOut.hidden = outMode.value !== 'SET'; tNext.hidden = outMode.value !== 'SET'; }
    inMode.addEventListener('change', sync); outMode.addEventListener('change', sync); sync();
    var attempt = null; // { sig, id } - one requestId per attempt; reused only when the identical request is retried
    function payload(action) {
      var p = { caseKey: c.caseKey, expectedVersion: c.version, expectedStamp: c.rowStamp, action: action, reason: reason.value.trim(), confirm: true };
      if (action === 'CONFIRM') { p.checkIn = { mode: 'KEEP' }; p.checkOut = { mode: 'KEEP', nextDay: false }; return p; }
      p.checkIn = { mode: inMode.value }; if (inMode.value === 'SET') p.checkIn.time = inTime.value;
      p.checkOut = { mode: outMode.value }; if (outMode.value === 'SET') { p.checkOut.time = outTime.value; p.checkOut.nextDay = next.checked; }
      if (evidence.value.trim()) p.evidence = evidence.value.trim();
      return p;
    }
    function describe(mode, time, nextDay, recorded, sched, isOut) {
      if (mode === 'KEEP') return 'keep ' + (recorded || '—');
      if (mode === 'SCHEDULE') return 'scheduled ' + (sched ? (isOut ? sched.end : sched.start) : '?');
      return time + (isOut && nextDay ? ' (next day)' : '');
    }
    function submit(action) {
      var p = payload(action), err = '';
      if (!p.reason) err = 'A reason is required. / السبب مطلوب.';
      else if (action === 'CORRECT') {
        if (p.checkIn.mode === 'KEEP' && p.checkOut.mode === 'KEEP') err = 'Nothing to change: choose SCHEDULE or SET for a punch (or use Confirm).';
        else if ((p.checkIn.mode === 'SET' && !validTime(p.checkIn.time)) || (p.checkOut.mode === 'SET' && !validTime(p.checkOut.time))) err = 'Enter a valid HH:mm time.';
        else if ((p.checkIn.mode === 'SET' || p.checkOut.mode === 'SET') && !p.evidence) err = 'Evidence is required when a time is set manually. / الدليل مطلوب.';
      }
      if (err) { res.textContent = err; res.className = 'meta report-error'; return; }
      var sched = c.scheduledShift;
      var text = (action === 'CONFIRM' ? 'Confirm the recorded times as correct?\n' : 'Apply this correction?\n') + c.employeeCode + ' ' + c.employeeName + ' · ' + c.workDate + '\n' +
        'Original: In ' + (c.recorded.checkIn || 'MISSING') + ' / Out ' + (c.recorded.checkOut || 'MISSING') + '\n' +
        'Approved: In ' + describe(p.checkIn.mode, p.checkIn.time, false, c.recorded.checkIn, sched, false) + ' / Out ' + describe(p.checkOut.mode, p.checkOut.time, p.checkOut.nextDay, c.recorded.checkOut, sched, true) + '\n' +
        'Reason: ' + p.reason + (p.evidence ? '\nEvidence: ' + p.evidence : '');
      if (!window.confirm(text)) return;
      var sig = JSON.stringify(p);
      if (!attempt || attempt.sig !== sig) attempt = { sig: sig, id: newId() };
      p.requestId = attempt.id;
      apply.disabled = true; conf.disabled = true; res.textContent = 'Saving…'; res.className = 'meta';
      op('svCorrect', p, c.workDate, c.workDate).then(function (r) {
        if (r.ok) {
          attempt = null;
          c.version = r.version; c.state = r.state || c.state;
          if (r.row) c.correction = { correctionId: r.correctionId, version: r.version, type: r.type || (action === 'CONFIRM' ? 'CONFIRMED' : 'CORRECTED'), approvedIn: r.row.checkIn, approvedOut: r.row.checkOut, appliedAt: 'now', supervisor: who.signedInAs };
          if (r.row) c.attendanceStatus = r.row.attendanceStatus || c.attendanceStatus;
          renderCase(holder, c);
          var note = holder.lastChild;
          note.textContent = (r.unchanged ? 'No change (already in this state). ' : 'Saved. ') + (r.row ? 'In ' + (r.row.checkIn || '—') + ' · Out ' + (r.row.checkOut || '—') + ' · ' + (r.row.workedHours || '') + ' · ' + (r.row.attendanceStatus || '') : '');
          note.className = 'meta zo-saved';
          return;
        }
        apply.disabled = false; conf.disabled = (c.missing || []).length > 0 || c.state === 'CORRECTED';
        if (r.code === 'VERSION_CONFLICT') { attempt = null; loadQueue('This case was changed elsewhere - the queue was reloaded.'); return; }
        if (r.code === 'APPLY_FAILED') attempt = null; // a rolled-back attempt is retried as a NEW request
        res.textContent = 'NOT saved: ' + (r.error || r.code) + (r.code ? ' [' + r.code + ']' : ''); res.className = 'meta report-error';
      });
    }
    apply.addEventListener('click', function () { submit('CORRECT'); });
    conf.addEventListener('click', function () { submit('CONFIRM'); });
    return form;
  }

  // ---------------- shift schedule ----------------
  var entries = [], selected = {}; // selected: code -> employee
  function sArgs() {
    var a = { from: $('sFrom').value, to: $('sTo').value };
    if ($('sZone').value) a.zone = $('sZone').value;
    if ($('sEvent').value) a.event = $('sEvent').value;
    if ($('sLocation').value) a.location = $('sLocation').value;
    if ($('sCode').value.trim()) a.code = $('sCode').value.trim();
    return a;
  }
  function loadSchedule(note) {
    var a = sArgs();
    if (!a.from || !a.to || a.from > a.to) { setMsg('sStatus', 'Choose a valid date range.', true); return; }
    $('sLoad').disabled = true; setMsg('sStatus', 'Loading…');
    op('svScheduleGet', a, a.from, a.to).then(function (r) {
      $('sLoad').disabled = false;
      if (!r.ok) { setMsg('sStatus', 'Could not load: ' + r.error, true); return; }
      entries = r.entries || [];
      setOptions($('sZone'), r.zones); setOptions($('sEvent'), r.events); setOptions($('sLocation'), r.locations);
      setMsg('sStatus', (note ? note + ' ' : '') + entries.length + ' schedule entr' + (entries.length === 1 ? 'y' : 'ies') + '.');
      var host = $('sList'); clear(host);
      if (!entries.length) { host.appendChild(el('div', 'empty-note', 'No scheduled shifts in this range.')); return; }
      host.appendChild(table(['Code', 'Name', 'Zone', 'Event / Area', 'Location', 'Date', 'Start', 'End', 'Duration', 'Tolerance', 'Ver', 'Updated by', 'Updated at', 'Note'], entries.map(function (e) {
        return tr([e.employeeCode, e.employeeName, e.zone, e.event, e.location, e.workDate, e.start, e.end + (e.overnight ? ' (+1d)' : ''), fmtMin(e.durationMin), e.toleranceMin + ' min', e.version, e.updatedBy, e.updatedAt, e.note]);
      })));
    });
  }
  function exportExcel() {
    if (!entries.length) { setMsg('sStatus', 'Load the schedule first - there is nothing to export.', true); return; }
    try {
      var cols = [['Employee Code', 'string', 14], ['Employee Name', 'text', 26], ['Zone', 'text', 18], ['Event / Area', 'text', 22], ['Location', 'text', 22], ['Work Date', 'date', 13], ['Shift Start', 'string', 11], ['Shift End', 'string', 11], ['End Date', 'date', 13], ['Duration (h)', 'number', 12], ['Overnight', 'text', 11], ['Tolerance (min)', 'number', 14], ['Version', 'number', 9], ['Updated By', 'text', 22], ['Updated At', 'datetime', 19], ['Note', 'wrap', 34]];
      var rows = entries.map(function (e) {
        return [String(e.employeeCode), e.employeeName, e.zone, e.event, e.location, e.workDate, e.start, e.end, e.endDate, Math.round(e.durationMin / 6) / 10, e.overnight ? 'Yes' : 'No', e.toleranceMin, e.version, e.updatedBy, e.updatedAt, e.note || ''];
      });
      var bytes = window.HMGXlsx.build([{ name: 'Shift Schedule', columns: cols.map(function (c) { return { header: c[0], type: c[1], width: c[2] }; }), rows: rows }]);
      if (!(bytes && bytes.length > 100 && bytes[0] === 0x50 && bytes[1] === 0x4B)) { setMsg('sStatus', 'Excel not created: the workbook could not be built.', true); return; }
      var a = sArgs(), name = 'HMG_Shift_Schedule_' + a.from + '_' + a.to + '.xlsx';
      var url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      var box = $('sFiles'); clear(box);
      var link = el('a', 'btn-secondary', 'Save ' + name + ' (' + Math.max(1, Math.round(bytes.length / 1024)) + ' KB)'); link.href = url; link.download = name; box.appendChild(link);
      var auto = document.createElement('a'); auto.href = url; auto.download = name; auto.style.display = 'none'; document.body.appendChild(auto); auto.click(); auto.remove();
      setMsg('sStatus', 'Excel ready: ' + name + '. If no file appears, click the Save link.');
    } catch (err) { setMsg('sStatus', 'Could not build the Excel file: ' + (err && err.message ? err.message : err), true); }
  }
  function renderSelected() {
    var box = $('aSelected'); clear(box);
    var codes = Object.keys(selected);
    box.appendChild(el('b', null, 'Selected employees (' + codes.length + '): '));
    if (!codes.length) box.appendChild(document.createTextNode('none'));
    codes.forEach(function (k) {
      var e = selected[k], chip = el('span', 'tag tag-PREPARED', e.code + ' ' + (e.name || '') + ' · ' + (e.zone || '') + ' / ' + (e.event || '') + ' ');
      chip.setAttribute('dir', 'auto'); chip.style.marginRight = '6px';
      var x = el('button', 'btn-link', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Remove ' + e.code);
      x.addEventListener('click', function () { delete selected[k]; renderSelected(); assignPreview(); });
      chip.appendChild(x); box.appendChild(chip);
    });
  }
  function findEmployee() {
    var code = $('aCode').value.trim();
    if (!code) return;
    $('aFind').disabled = true; setMsg('aResult', 'Looking up ' + code + '…');
    op('svEmployeeLookup', { code: code }).then(function (r) {
      $('aFind').disabled = false;
      if (!r.ok) { setMsg('aResult', 'Lookup failed: ' + r.error, true); return; }
      if (!r.employee) { setMsg('aResult', 'No employee with code ' + code + ' was found in the attendance records.', true); return; }
      selected[r.employee.code] = r.employee; $('aCode').value = ''; setMsg('aResult', ''); renderSelected(); assignPreview();
    });
  }
  function assignDates() {
    var f = $('aFrom').value, t = $('aTo').value || f, out = [];
    if (!f || t < f) return [];
    var d = f; while (d <= t && out.length < 400) { out.push(d); d = shiftDays(d, 1); }
    return out;
  }
  function assignPreview() {
    var s = $('aStart').value, e = $('aEnd').value, p = $('aPreview'); clear(p);
    var dates = assignDates(), n = Object.keys(selected).length;
    if (validTime(s) && validTime(e)) {
      var d = toMin(e) - toMin(s), over = d <= 0; if (over) d += 1440;
      p.appendChild(document.createTextNode('Duration ' + fmtMin(d) + ' '));
      if (over) p.appendChild(el('span', 'tag tag-MODIFIED', 'overnight / عبر منتصف الليل'));
    } else p.appendChild(document.createTextNode('Enter start and end times.'));
    p.appendChild(document.createTextNode(' · ' + n + ' employee(s) × ' + dates.length + ' day(s)'));
  }
  function chunks(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
  function saveSchedule(action) {
    var codes = Object.keys(selected), dates = assignDates(), s = $('aStart').value, e = $('aEnd').value, tol = parseInt($('aTol').value, 10), note = $('aNote').value.trim();
    var err = '';
    if (!codes.length) err = 'Add at least one employee.'; else if (!dates.length) err = 'Choose a valid date (range).';
    else if (!validTime(s) || !validTime(e)) err = 'Enter valid start and end times.';
    else if (action === 'SET' && !(tol >= 1 && tol <= 10)) err = 'Tolerance must be 1-10 minutes.';
    if (err) { setMsg('aResult', err, true); return; }
    var calls = []; chunks(codes, 50).forEach(function (cc) { chunks(dates, 31).forEach(function (dd) { calls.push({ codes: cc, dates: dd }); }); });
    var over = toMin(e) <= toMin(s);
    var text = (action === 'SET' ? 'Assign' : 'WITHDRAW') + ' the shift ' + s + ' - ' + e + (over ? ' (overnight)' : '') + (action === 'SET' ? ', tolerance ' + tol + ' min' : '') + '\nfor ' + codes.length + ' employee(s) on ' + dates.length + ' day(s) (' + dates[0] + (dates.length > 1 ? ' to ' + dates[dates.length - 1] : '') + ')?' + (calls.length > 1 ? '\nSent in ' + calls.length + ' steps.' : '');
    if (!window.confirm(text)) return;
    var total = { saved: 0, superseded: 0, withdrawn: 0, unchanged: 0 }, i = 0;
    $('aAssign').disabled = true; $('aWithdraw').disabled = true;
    function done(msgText, isErr) { $('aAssign').disabled = false; $('aWithdraw').disabled = false; setMsg('aResult', msgText, isErr); loadSchedule(); }
    function next() {
      if (i >= calls.length) { done('Done: ' + total.saved + ' saved, ' + total.superseded + ' superseded, ' + total.withdrawn + ' withdrawn, ' + total.unchanged + ' unchanged.', false); return; }
      setMsg('aResult', 'Saving step ' + (i + 1) + ' of ' + calls.length + '…');
      var args = { action: action, codes: calls[i].codes, dates: calls[i].dates, start: s, end: e, requestId: newId(), confirm: true };
      if (action === 'SET') args.toleranceMin = tol;
      if (note) args.note = note;
      op('svScheduleSave', args, dates[0], dates[dates.length - 1]).then(function (r) {
        if (!r.ok) { done('Stopped at step ' + (i + 1) + ' of ' + calls.length + ' - NOT saved: ' + (r.error || r.code) + '. Already done: ' + total.saved + ' saved, ' + total.withdrawn + ' withdrawn.', true); return; }
        ['saved', 'superseded', 'withdrawn', 'unchanged'].forEach(function (k) { total[k] += r[k] || 0; });
        i++; next();
      });
    }
    next();
  }

  // ---------------- history ----------------
  function loadHistory() {
    var a = { from: $('hFrom').value, to: $('hTo').value };
    if ($('hCode').value.trim()) a.code = $('hCode').value.trim();
    if (!a.from || !a.to || a.from > a.to) { setMsg('hStatus', 'Choose a valid date range.', true); return; }
    $('hLoad').disabled = true; setMsg('hStatus', 'Loading…');
    op('svHistory', a, a.from, a.to).then(function (r) {
      $('hLoad').disabled = false;
      var host = $('hList'); clear(host);
      if (!r.ok) { setMsg('hStatus', 'Could not load: ' + r.error, true); return; }
      var rows = r.rows || [];
      setMsg('hStatus', rows.length + ' record(s).');
      if (!rows.length) { host.appendChild(el('div', 'empty-note', 'No history in this range.')); return; }
      var keys = []; rows.forEach(function (x) { Object.keys(x).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); }); });
      host.appendChild(table(keys, rows.map(function (x) { return tr(keys.map(function (k) { return x[k]; })); })));
    });
  }

  // ---------------- integrity (check: supervisor + admin; re-apply: supervisor) ----------------
  function iArgs() { return { from: $('hFrom').value, to: $('hTo').value }; }
  function checkIntegrity(note) {
    var a = iArgs();
    if (!a.from || !a.to || a.from > a.to) { setMsg('iStatus', 'Choose a valid date range above.', true); return; }
    $('iCheck').disabled = true; setMsg('iStatus', 'Checking…');
    op('svIntegrity', a, a.from, a.to).then(function (r) {
      $('iCheck').disabled = false;
      var host = $('iList'); clear(host);
      if (!r.ok) { setMsg('iStatus', 'Could not check: ' + r.error, true); return; }
      var c = r.counts || {}, bad = (c.LOST || 0) + (c.MISSING_ROW || 0);
      setMsg('iStatus', (note ? note + ' ' : '') + 'OK ' + (c.OK || 0) + ' · lost ' + (c.LOST || 0) + ' · missing record ' + (c.MISSING_ROW || 0) + ' · orphaned ' + (c.ORPHANED || 0) + ' · duplicate ' + (c.DUPLICATE || 0) + ' · excluded ' + (c.EXCLUDED || 0), bad + (c.ORPHANED || 0) + (c.DUPLICATE || 0) > 0);
      $('iReapply').hidden = !(canWrite() && bad > 0);
      var items = (r.items || []).filter(function (x) { return x.state !== 'OK'; });
      if (!items.length) return;
      host.appendChild(table(['State', 'Date', 'Code', 'Name', 'Zone', 'Correction', 'Approved in', 'Approved out', 'Current in', 'Current out', 'Rows'], items.map(function (x) {
        return tr([x.state, x.workDate, x.employeeCode, x.employeeName, x.zone, x.correctionId + ' v' + x.version + ' (' + x.type + ')', x.approvedIn, x.approvedOut, x.currentIn, x.currentOut, x.rows]);
      })));
    });
  }
  function reapply() {
    var a = iArgs();
    if (!window.confirm('Re-apply the LOST corrections of ' + a.from + ' to ' + a.to + ' exactly as approved?\nDuplicates and missing records are not touched.')) return;
    $('iReapply').disabled = true; setMsg('iStatus', 'Re-applying…');
    op('svReapply', Object.assign({ confirm: true }, a), a.from, a.to).then(function (r) {
      $('iReapply').disabled = false;
      checkIntegrity((r.ok ? 'Re-applied ' : 'Partly re-applied ') + (r.reapplied || 0) + (r.failed ? ', FAILED ' + r.failed : '') + '.');
    });
  }

  // ---------------- wiring ----------------
  ['queue', 'schedule', 'history'].forEach(function (t) { $('svTab' + t.charAt(0).toUpperCase() + t.slice(1)).addEventListener('click', function () { showTab(t); }); });
  $('qLoad').addEventListener('click', function () { loadQueue(); });
  $('sLoad').addEventListener('click', function () { loadSchedule(); });
  $('sExport').addEventListener('click', exportExcel);
  $('hLoad').addEventListener('click', loadHistory);
  $('iCheck').addEventListener('click', function () { checkIntegrity(); });
  $('iReapply').addEventListener('click', reapply);
  $('aFind').addEventListener('click', findEmployee);
  $('aCode').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') findEmployee(); });
  ['aFrom', 'aTo', 'aStart', 'aEnd'].forEach(function (id) { $(id).addEventListener('input', assignPreview); $(id).addEventListener('change', assignPreview); });
  $('aAssign').addEventListener('click', function () { saveSchedule('SET'); });
  $('aWithdraw').addEventListener('click', function () { saveSchedule('WITHDRAW'); });
  renderSelected();
  showTab('queue');
  start();
})();
