// Attendance Supervisor page V1.2 (2026-11-13): ALL attendance records (svList view ALL, paged by listId + completeness check), an Edit button on every row opening an inline editor
// with ONE "Save & Approve" action (direct supervisor approval when permitted), shift schedule, history.
// Credential = a supervisor's personal access link (?adminToken=...) read once by access.js (global or zone-limited), or an Analytics Admin (explicit intervention).
// Data reaches the DOM only through textContent or esc() (HTML-escaped); no inline scripts (CSP script-src 'self'). Every write is confirmed first and sent once per attempt (requestId).
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
  /** A write that the backend answers with retryable:true (script lock busy) is sent again, up to 3 more times (2 s, 4 s, 6 s), with the SAME body (same requestId: the backend is idempotent per actor). */
  var RETRY_BASE_MS = (function () { try { var m = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && /[?&]retryMs=(\d+)/.exec(location.search); if (m) return +m[1]; } catch (e) { /* default */ } return 2000; })();
  function opWrite(name, args, from, to, onBusy) {
    var n = 0;
    function go() {
      return op(name, args, from, to).then(function (r) {
        if (r && r.retryable === true && n < 3) { n++; if (onBusy) onBusy(n); return new Promise(function (res) { setTimeout(res, RETRY_BASE_MS * n); }).then(go); }
        return r;
      });
    }
    return go();
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
    if (isAdmin()) { b.hidden = false; b.textContent = 'Administrator intervention / تدخل المسؤول: you see the full list; a correction needs the explicit "I am intervening as administrator" tick-box and is recorded as ADMIN.'; } else b.hidden = true;
    var sc = who.scope || {};
    $('svScope').textContent = sc.zones ? 'Zones: ' + sc.zones.join(', ') : 'All zones';
    $('svDirectInfo').textContent = who.canDirectApprove ? (isAdmin() ? 'Direct approval: allowed with the administrator intervention tick-box. / اعتماد مباشر مسموح' : 'Direct approval: ALLOWED - you can correct and approve Pending / Rejected records without the Zone Manager. / اعتماد مباشر مسموح') : 'Direct approval: not allowed - Pending / Rejected records stay read-only until the Zone Manager decides. / الاعتماد المباشر غير مسموح';
    $('sAssign').hidden = !canWrite(); $('sReadonlyNote').hidden = canWrite();
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
        who = r; applyRole(); loadList();
      });
    });
  }

  // ---------------- attendance records (svList view ALL: every record in range, paged by listId + completeness check) ----------------
  var rows = [], counts = null, loaded = null /* {key, args} of the last COMPLETE load */, loadSeq = 0, openIdx = -1;
  var COLS = ['Employee Code / الرمز', 'Employee Name / الاسم', 'Date / التاريخ', 'Event / Area', 'Zone / المنطقة', 'Check-in / الدخول', 'Check-out / الخروج', 'Scheduled Shift / الوردية', 'Hours (actual / required) / الساعات', 'Match status / المطابقة', 'Missing Punch / الناقص', 'Zone Manager decision / قرار مدير المنطقة', 'Correction status / حالة التصحيح', 'Actions / إجراءات'];
  var RO_TEXT = { FINAL: 'FINAL - the zone day is closed. / اليوم نهائي', NO_DIRECT_PERMISSION: 'Needs Zone Manager approval - you have no direct-approval permission. / لا تملك صلاحية الاعتماد المباشر', NO_PUNCH: 'No real punch - cannot be edited. / لا توجد بصمة',
    AWAITING_ZONE_MANAGER: 'Waiting for the Zone Manager', ZM_REJECTED: 'Rejected by the Zone Manager' };
  var CODE_TEXT = {
    VERSION_CONFLICT: 'This record was changed by someone else. / تم تعديل السجل من شخص آخر.', ZONE_NOT_ALLOWED: 'This record belongs to a zone outside your access.',
    AWAITING_ZONE_MANAGER: 'The Zone Manager has not approved this record yet.', ZM_REJECTED: 'The Zone Manager rejected this record.', FINAL: 'The zone day is FINAL - it cannot be changed. / اليوم نهائي.',
    DIRECT_APPROVAL_NOT_ALLOWED: 'You do not have the direct-approval permission (ask the administrator). / لا تملك صلاحية الاعتماد المباشر.',
    REASON_REQUIRED: 'A reason is required (at least 5 characters for a direct approval). / السبب مطلوب.', EVIDENCE_REQUIRED: 'Evidence is required when a time is set manually.',
    NO_PUNCH_EVIDENCE: 'A record without any real punch cannot be corrected. / لا توجد بصمة فعلية.', NO_CHANGE: 'Nothing was changed. / لا يوجد تغيير.', NOT_ELIGIBLE: 'This record cannot be edited.',
    REQUEST_ID_CONFLICT: 'This request id was used by another user - try again (a new id is created).', NOT_AUTHORIZED: 'Your access is no longer valid.',
    ADMIN_OVERRIDE_REQUIRED: 'Tick "I am intervening as administrator" first.', APPLY_FAILED: 'The change could not be applied and was rolled back - try again.'
  };
  var RELOAD_CODES = ['VERSION_CONFLICT', 'AWAITING_ZONE_MANAGER', 'ZM_REJECTED', 'FINAL', 'ZONE_NOT_ALLOWED', 'NOT_ELIGIBLE', 'DIRECT_APPROVAL_NOT_ALLOWED'];
  var DIRECT_NOTICE = 'Direct supervisor approval — the Zone Manager decision (PENDING/REJECTED) stays recorded unchanged. / اعتماد مباشر من المشرف — يبقى قرار مدير المنطقة (قيد الانتظار/مرفوض) كما هو دون تغيير.';
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (ch) { return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'; }); }
  function isAdmin() { return !!(who && who.role === 'ADMIN'); }
  /** Rows per request: 1000 in production (the backend maximum is 2000); a test override (?pageSize=) is honoured on localhost only. */
  function pageSize() {
    var n = 1000;
    try {
      if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
        var m = /[?&]pageSize=(\d+)/.exec(location.search), v = m ? +m[1] : +window.HMG_SV_PAGE_SIZE;
        if (v >= 1 && v <= 1000) n = Math.floor(v);
      }
    } catch (e) { /* default */ }
    return n;
  }
  var PAGE_SZ = pageSize(); // read once at start (the address bar is rewritten when the token is stripped)
  function qArgs() {
    var a = { from: $('qFrom').value, to: $('qTo').value, view: 'ALL', status: $('qState').value || 'ALL' };
    if ($('qZone').value) a.zone = $('qZone').value;
    if ($('qEvent').value) a.event = $('qEvent').value;
    if ($('qCode').value.trim()) a.code = $('qCode').value.trim();
    return a;
  }
  function rangeError(a) {
    if (!a.from || !a.to || a.from > a.to) return 'Choose a valid date range.';
    if (Math.round((new Date(a.to + 'T12:00:00Z') - new Date(a.from + 'T12:00:00Z')) / 86400000) + 1 > 31) return 'At most 31 days per load. / الحد الأقصى 31 يومًا.';
    return '';
  }
  /** Pages through svList (the first page computes + caches the list, the next pages pass its listId) until offset + rows >= total.
   *  Every page must carry the same signature and total and must not be "recomputed", else the whole load restarts (max 3 attempts). */
  function fetchAll(a, progress) {
    var size = PAGE_SZ;
    function attempt(n) {
      var got = [], first = null, listId = '';
      function page(offset) {
        var args = Object.assign({}, a, { offset: offset, limit: size });
        if (listId && offset > 0) args.listId = listId;
        return op('svList', args, a.from, a.to).then(function (r) {
          if (!r || !r.ok) return { fail: (r && (r.error || r.code)) || 'no answer' };
          if (!first) { first = r; listId = r.listId || ''; } else if (r.recomputed === true || r.signature !== first.signature || r.total !== first.total) return { retry: true };
          var rs = r.rows || [];
          for (var i = 0; i < rs.length; i++) got.push(rs[i]);
          if (progress) progress(Math.min(offset + rs.length, r.total), r.total);
          if (offset + rs.length >= r.total) return {};
          if (!rs.length) return { retry: true };
          return page(offset + rs.length);
        });
      }
      return page(0).then(function (s) {
        if (s.fail) return { ok: false, error: s.fail };
        var seen = {}, dup = 0;
        if (!s.retry) got.forEach(function (c) { if (seen[c.caseKey]) dup++; seen[c.caseKey] = 1; });
        if (s.retry || got.length !== first.total || dup) {
          if (n < 3) { if (progress) progress(0, 0, n + 1); return attempt(n + 1); }
          return { ok: false, error: 'The list changed while it was loading (3 attempts) - it is NOT shown, to avoid an incomplete list. Press Load again. / تغيرت القائمة أثناء التحميل.' };
        }
        return { ok: true, rows: got, first: first };
      });
    }
    return attempt(1);
  }
  function setBusy(b) { $('qLoad').disabled = b; $('qExport').disabled = b; }
  function adopt(r, a) {
    rows = r.rows; counts = r.first.counts || {}; loaded = { key: JSON.stringify(a), args: a }; openIdx = -1;
    setOptions($('qZone'), r.first.zones); setOptions($('qEvent'), r.first.events);
    $('qZone').value = a.zone || ''; $('qEvent').value = a.event || '';
    renderCounts(); renderTable();
  }
  /** opts: args (filters to use), keepResult (keep the result line), focus (caseKey to scroll to + highlight after the load). */
  function loadList(note, opts) {
    opts = opts || {};
    var a = opts.args || qArgs(), err = rangeError(a);
    if (err) { setMsg('qStatus', err, true); return; }
    var seq = ++loadSeq;
    setBusy(true); setMsg('qStatus', 'Loading…');
    if (!opts.keepResult) setMsg('qResult', '');
    fetchAll(a, function (n, t, restart) {
      if (seq !== loadSeq) return;
      setMsg('qStatus', restart ? 'The list changed while loading - restarting (attempt ' + restart + ' of 3)…' : 'Loading ' + n + ' / ' + t + '…');
    }).then(function (r) {
      if (seq !== loadSeq) return;
      setBusy(false);
      if (!r.ok) { rows = []; counts = null; loaded = null; openIdx = -1; clear($('qList')); $('qCounts').hidden = true; setMsg('qStatus', 'Could not load: ' + r.error, true); return; }
      adopt(r, a);
      setMsg('qStatus', (note ? note + ' ' : '') + 'All ' + rows.length + ' of ' + r.first.total + ' records loaded.' + (a.status !== 'ALL' ? ' (status filter: ' + a.status + ')' : ''));
      if (opts.focus) focusRow(opts.focus);
    });
  }
  function focusRow(key) {
    var all = document.querySelectorAll('#svBody tr.sv-row'), hit = null;
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-case') === key) { hit = all[i]; break; }
    if (!hit) { var q = $('qResult'); q.textContent = q.textContent + ' The record no longer matches the current status filter. / السجل لم يعد ضمن الفلتر الحالي.'; return; }
    hit.classList.add('sv-highlight');
    try { hit.scrollIntoView({ block: 'center' }); } catch (e) { hit.scrollIntoView(); }
  }
  var COUNT_ITEMS = [['total', 'Total / الإجمالي'], ['matched', 'Matched / مطابق'], ['unmatched', 'Unmatched / غير مطابق'], ['missingIn', 'Missing check-in / ناقص الدخول'], ['missingOut', 'Missing check-out / ناقص الخروج'], ['notComputable', 'No hours rule / بلا قاعدة ساعات'],
    ['pending', 'Pending ZM / بانتظار مدير المنطقة'], ['approved', 'Approved / معتمد'], ['rejected', 'Rejected / مرفوض'], ['corrected', 'Corrected / مصحح'], ['final', 'FINAL / نهائي']];
  function renderCounts() {
    var box = $('qCounts'), c = counts || {};
    box.innerHTML = COUNT_ITEMS.map(function (it) { return '<span class="sv-count" data-k="' + it[0] + '"><b>' + esc(c[it[0]] || 0) + '</b> ' + esc(it[1]) + '</span>'; }).join('');
    box.hidden = false;
  }
  function hhmm(s) { return s ? String(s).slice(-5) : ''; }
  function dateOf(s) { return s ? String(s).slice(0, 10) : ''; }
  function tm(s, wd) { if (!s) return ''; var d = String(s).slice(0, 10), t = String(s).slice(-5); return d === wd ? t : String(s).slice(5); }
  function shiftText(c) { var s = c.scheduledShift; return s ? s.start + ' - ' + s.end + (s.endDate && s.endDate !== c.workDate ? ' (+1d)' : '') : ''; }
  function missText(c) { return (c.missing || []).map(function (m) { return m === 'CHECK_IN' ? 'Check-in' : 'Check-out'; }).join(', '); }
  function has(v) { return v !== null && v !== undefined; }
  function hoursText(c) {
    var h = c.hours; if (!h || (!has(h.actualMin) && !has(h.requiredMin))) return '';
    return (has(h.actualMin) ? fmtMin(h.actualMin) : '—') + ' / ' + (has(h.requiredMin) ? fmtMin(h.requiredMin) : '—') + (has(h.varianceMin) && has(h.actualMin) && h.varianceMin !== 0 ? ' (' + (h.varianceMin > 0 ? '+' : '') + h.varianceMin + 'm)' : '');
  }
  function canEditRow(c) { return c.canEdit !== undefined ? !!c.canEdit : !!c.canCorrect; }
  function pathText(p) { return p === 'SUPERVISOR_DIRECT' ? 'direct supervisor approval' : (p === 'ZM_GATE' ? 'via Zone Manager gate' : ''); }
  function rowHtml(c, i) {
    var cor = c.correction, can = canEditRow(c), match = c.matchStatus || '';
    var corTxt = '<span class="tag tag-' + esc(c.listState) + '" data-state="' + esc(c.listState) + '">' + esc(c.listState) + '</span> ' + esc(c.correctionStatus === 'NONE' ? 'No correction' : c.correctionStatus + (cor ? ' v' + cor.version : ''));
    if (cor && cor.approvalPath) corTxt += ' <span class="sv-appr-path" data-path="' + esc(cor.approvalPath) + '">· ' + esc(pathText(cor.approvalPath) || cor.approvalPath) + '</span>';
    var act = '<button type="button" class="btn-primary sv-open sv-edit" data-i="' + i + '"' + (can ? '' : ' disabled title="' + esc(RO_TEXT[c.readOnlyReason] || c.readOnlyReason || 'not editable') + '"') + '>Edit / تعديل</button>';
    if (!can) act += '<div class="sv-ro-reason" data-reason="' + esc(c.readOnlyReason) + '">' + esc(RO_TEXT[c.readOnlyReason] || c.readOnlyReason || 'not editable') + '</div>';
    else if (c.editPath === 'DIRECT_APPROVAL') act += '<div class="sv-path-note" data-path="DIRECT_APPROVAL">Direct approval / اعتماد مباشر</div>';
    var cells = [esc(c.employeeCode), '<span dir="auto">' + esc(c.employeeName) + '</span>', esc(c.workDate), '<span dir="auto">' + esc(c.event) + '</span>', '<span dir="auto">' + esc(c.zone) + '</span>',
      esc(tm(c.checkIn, c.workDate) || 'MISSING'), esc(tm(c.checkOut, c.workDate) || 'MISSING'), esc(shiftText(c) || 'No schedule'), esc(hoursText(c) || '—'),
      match ? '<span class="tag tag-' + esc(match) + '">' + esc(match) + '</span>' : '—', esc(missText(c) || '—'),
      '<span class="tag tag-' + esc(c.zmStatus) + '">' + esc(c.zmStatus) + '</span>' + (c.zmBy ? ' <span dir="auto">' + esc(c.zmBy) + '</span>' : ''), corTxt, act];
    return '<tr class="sv-row' + (can ? '' : ' sv-ro') + '" data-i="' + i + '" data-case="' + esc(c.caseKey) + '" data-state="' + esc(c.listState) + '" data-match="' + esc(match) + '" data-path="' + esc(c.editPath || '') + '"><td>' + cells.join('</td><td>') + '</td></tr>';
  }
  function renderTable() {
    var host = $('qList');
    if (!rows.length) { host.innerHTML = '<div class="empty-note">No attendance records match these filters. / لا توجد سجلات.</div>'; return; }
    var html = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) html[i] = rowHtml(rows[i], i);
    host.innerHTML = '<div class="table-scroll sv-list-scroll"><table class="data-table sv-table" id="svTable"><thead><tr><th>' + COLS.map(esc).join('</th><th>') + '</th></tr></thead><tbody id="svBody">' + html.join('') + '</tbody></table></div>';
  }
  function line(label, value) { var d = el('div', 'meta'); d.appendChild(el('b', null, label + ': ')); var s = el('span', null, value === undefined || value === null || value === '' ? '—' : value); s.setAttribute('dir', 'auto'); d.appendChild(s); return d; }
  function closeForm() {
    var f = document.querySelector('#svBody tr.sv-form-row'); if (f) f.remove();
    openIdx = -1;
  }
  /** The inline editor opens right under the row (no navigation). A second click on Edit closes it. */
  function openCorrection(i) {
    var wasOpen = openIdx === i; closeForm();
    if (wasOpen) return;
    var c = rows[i], tr0 = document.querySelector('#svBody tr[data-i="' + i + '"]');
    if (!c || !tr0 || !canEditRow(c)) return;
    var fr = el('tr', 'sv-form-row'), td = el('td'); td.colSpan = COLS.length; fr.appendChild(td);
    tr0.insertAdjacentElement('afterend', fr); openIdx = i;
    var holder = el('div', 'sv-case'); holder.setAttribute('data-case', c.caseKey); holder.setAttribute('data-path', c.editPath || ''); td.appendChild(holder);
    renderCase(holder, c);
    var f0 = holder.querySelector('.sv-reason'); if (f0 && f0.focus) { try { f0.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  function requiredMin(c) {
    var h = c.hours; if (h && has(h.requiredMin)) return h.requiredMin;
    var s = c.scheduledShift; if (s && s.durationMin) return s.durationMin;
    if (s && validTime(s.start) && validTime(s.end)) { var d = toMin(s.end) - toMin(s.start); return d <= 0 ? d + 1440 : d; }
    return null;
  }
  function renderCase(holder, c) {
    clear(holder);
    var top = el('div', 'emp-top'); top.appendChild(el('span', 'emp-name', c.employeeName)); top.lastChild.setAttribute('dir', 'auto');
    top.appendChild(el('span', 'emp-code', '#' + c.employeeCode + ' · ' + (c.designation || '') + ' · ' + c.workDate + ' · ' + (c.zone || '')));
    holder.appendChild(top);
    var s = c.scheduledShift, rq = requiredMin(c);
    var l1 = line('Original recorded punches / البصمات الأصلية', 'In ' + ((c.recorded && c.recorded.checkIn) || 'MISSING') + ' · Out ' + ((c.recorded && c.recorded.checkOut) || 'MISSING')); l1.classList.add('sv-info-recorded'); holder.appendChild(l1);
    var l2 = line('Current approved times / الأوقات الحالية', 'In ' + (c.checkIn || 'MISSING') + ' · Out ' + (c.checkOut || 'MISSING')); l2.classList.add('sv-info-current'); holder.appendChild(l2);
    var l3 = line('Scheduled shift / الوردية', (s ? s.start + ' - ' + s.end + (s.endDate && s.endDate !== c.workDate ? ' (+1d ' + s.endDate + ')' : '') + ' · tolerance ' + s.toleranceMin + ' min' : 'No schedule') + ' · Required hours / الساعات المطلوبة: ' + (rq !== null ? fmtMin(rq) : '—') + (c.hours && has(c.hours.actualMin) ? ' · Actual now: ' + fmtMin(c.hours.actualMin) : ''));
    l3.classList.add('sv-info-shift'); holder.appendChild(l3);
    var l4 = line('Zone Manager decision / قرار مدير المنطقة', (c.zmStatus || '—') + (c.zmBy ? ' · ' + c.zmBy : '') + (c.zmAt ? ' · ' + c.zmAt : '')); l4.classList.add('sv-info-zm'); holder.appendChild(l4);
    holder.appendChild(line('Issues / الملاحظات', (c.issues || []).join(', ') || 'none'));
    if (c.correction) holder.appendChild(line('Current correction / التصحيح الحالي', c.correction.type + ' v' + c.correction.version + ' · In ' + (c.correction.approvedIn || '—') + ' · Out ' + (c.correction.approvedOut || '—') + ' · ' + (c.correction.by || '') + ' · ' + (c.correction.at || '') + (pathText(c.correction.approvalPath) ? ' · ' + pathText(c.correction.approvalPath) : '')));
    if (c.editPath === 'DIRECT_APPROVAL') { var nt = el('div', 'notice sv-direct-notice', DIRECT_NOTICE); nt.setAttribute('dir', 'auto'); holder.appendChild(nt); }
    var res = el('div', 'meta sv-res'); res.setAttribute('role', 'status'); res.setAttribute('aria-live', 'polite');
    holder.appendChild(caseForm(holder, c, res));
    holder.appendChild(res);
  }
  function caseForm(holder, c, res) {
    var form = el('div', 'filter-bar sv-editor'), sg = c.suggested || {}, sh = c.scheduledShift, direct = c.editPath === 'DIRECT_APPROVAL';
    var rec = c.recorded || {}, origIn = hhmm(c.checkIn), origOut = hhmm(c.checkOut), origNext = !!c.checkOut && dateOf(c.checkOut) > c.workDate;
    var missing = c.missing || [];
    function field(label, node) { var f = el('div', 'filter-field'); f.appendChild(el('label', null, label)); f.appendChild(node); form.appendChild(f); return f; }
    var inTime = el('input'), outTime = el('input'), next = el('input'), inSched = el('button', 'btn-secondary sv-use-in', 'Use scheduled time / وقت الوردية'), outSched = el('button', 'btn-secondary sv-use-out', 'Use scheduled time / وقت الوردية');
    inTime.type = 'time'; outTime.type = 'time'; next.type = 'checkbox'; inSched.type = 'button'; outSched.type = 'button';
    inTime.className = 'sv-in-time'; outTime.className = 'sv-out-time'; next.className = 'sv-next';
    inTime.value = origIn; outTime.value = origOut; next.checked = origNext;
    var fi = field('Check-in time / وقت الدخول', inTime); if (sh) fi.appendChild(inSched);
    var fo = field('Check-out time / وقت الخروج', outTime); if (sh) fo.appendChild(outSched);
    var nl = el('label', 'sv-next-label'); nl.appendChild(next); nl.appendChild(document.createTextNode(' Next day / اليوم التالي')); var fn = el('div', 'filter-field'); fn.appendChild(nl); form.appendChild(fn);
    var reason = el('input'), evidence = el('input');
    reason.type = 'text'; reason.maxLength = 500; reason.setAttribute('dir', 'auto'); reason.style.width = '18em'; reason.className = 'sv-reason';
    evidence.type = 'text'; evidence.maxLength = 500; evidence.setAttribute('dir', 'auto'); evidence.style.width = '18em'; evidence.className = 'sv-evidence';
    field('Reason (required) / السبب', reason); field('Evidence (optional, defaults to the reason) / الدليل', evidence);
    var override = null;
    if (isAdmin()) {
      override = el('input'); override.type = 'checkbox'; override.className = 'sv-override'; override.id = 'svOverride';
      var of = el('div', 'filter-field sv-admin-box'), lb = el('label', null, 'I am intervening as administrator / أتدخل بصفتي مسؤولًا (required)'); lb.setAttribute('for', 'svOverride');
      of.appendChild(override); of.appendChild(lb); form.appendChild(of);
    }
    var preview = el('div', 'sv-preview'); preview.setAttribute('role', 'status');
    var save = el('button', 'btn-primary sv-save', 'Save & Approve / حفظ واعتماد'), cancel = el('button', 'btn-secondary sv-cancel', 'Cancel / إلغاء');
    save.type = 'button'; cancel.type = 'button';
    var bf = el('div', 'filter-field sv-actions'); bf.appendChild(save); bf.appendChild(cancel);
    var foot = el('div', 'sv-editor-foot'); foot.appendChild(preview); foot.appendChild(bf);
    form.appendChild(foot);
    if (sg.basis) res.textContent = 'Suggestion: ' + sg.basis;
    var rq = requiredMin(c), working = false;
    function worked() { if (!validTime(inTime.value) || !validTime(outTime.value)) return null; return toMin(outTime.value) - toMin(inTime.value) + (next.checked ? 1440 : 0); }
    function sync() {
      var w = worked(), t;
      if (w === null) t = 'Worked hours: enter both times to see the result. / أدخل الوقتين لعرض الساعات.' + (rq !== null ? ' Required: ' + fmtMin(rq) + '.' : '');
      else if (w <= 0) t = 'Check-out is not after check-in - tick "Next day" for a shift that ends the next day. / الخروج قبل الدخول.';
      else t = 'Worked hours / الساعات: ' + fmtMin(w) + (rq !== null ? ' · Required: ' + fmtMin(rq) + ' · Variance: ' + (w - rq >= 0 ? '+' : '-') + fmtMin(Math.abs(w - rq)) : '');
      preview.textContent = t;
      var needTick = !!(override && !override.checked);
      save.disabled = working || needTick; save.title = needTick ? 'Tick "I am intervening as administrator" first.' : '';
    }
    ['input', 'change'].forEach(function (ev) { inTime.addEventListener(ev, sync); outTime.addEventListener(ev, sync); next.addEventListener(ev, sync); });
    if (override) override.addEventListener('change', sync);
    inSched.addEventListener('click', function () { if (sh) { inTime.value = sh.start; sync(); } });
    outSched.addEventListener('click', function () { if (sh) { outTime.value = sh.end; next.checked = !!(sh.endDate && sh.endDate !== c.workDate) || toMin(sh.end) <= toMin(sh.start); sync(); } });
    cancel.addEventListener('click', function () { closeForm(); });
    sync();
    var attempt = null; // { sig, id } - one requestId per attempt; reused only when the identical request is retried
    /** SET + time for each changed punch, KEEP for each unchanged one (an unchanged punch of an active correction that differs from the recorded punch is re-sent as SET so the correction keeps it), CONFIRM when nothing changed and no correction exists. */
    function build() {
      var rs = reason.value.trim(), changedIn = inTime.value !== origIn, changedOut = outTime.value !== origOut || (!!outTime.value && next.checked !== origNext), err = '';
      var p = { caseKey: c.caseKey, expectedVersion: c.version, expectedStamp: c.rowStamp, reason: rs, confirm: true };
      if (override && override.checked) p.adminOverride = true;
      if (direct) p.directApproval = true;
      if (override && !override.checked) err = 'Tick "I am intervening as administrator" first. / علّم خانة التدخل.';
      else if (!rs) err = 'A reason is required. / السبب مطلوب.';
      else if (direct && rs.length < 5) err = 'A direct approval needs a reason of at least 5 characters. / السبب 5 أحرف على الأقل.';
      else if ((changedIn && !validTime(inTime.value)) || (changedOut && !validTime(outTime.value))) err = 'Enter a valid HH:mm time (a recorded punch cannot be cleared). / أدخل وقتًا صحيحًا.';
      if (err) return { err: err };
      var keepOrSet = function (cur, rcd, orig, isOut) {
        if (!cur || !c.correction || cur === rcd) return { mode: 'KEEP' };
        var o = { mode: 'SET', time: orig }; if (isOut) o.nextDay = origNext; return o;
      };
      if (changedIn || changedOut) {
        p.action = 'CORRECT';
        p.checkIn = changedIn ? { mode: 'SET', time: inTime.value } : keepOrSet(c.checkIn, rec.checkIn, origIn, false);
        p.checkOut = changedOut ? { mode: 'SET', time: outTime.value, nextDay: next.checked } : keepOrSet(c.checkOut, rec.checkOut, origOut, true);
        if (p.checkIn.mode === 'KEEP' && !c.checkIn && p.checkOut.mode === 'KEEP') return { err: 'Enter the missing punch time. / أدخل وقت البصمة الناقصة.' };
        if (p.checkIn.mode === 'SET' || p.checkOut.mode === 'SET') p.evidence = evidence.value.trim() || rs;
        return { p: p };
      }
      if (missing.length) return { err: 'A punch is missing: enter its time. / أدخل وقت البصمة الناقصة.' };
      if (c.correction) return { err: 'Nothing changed - edit a time first. / لم يتغير شيء.' };
      p.action = 'CONFIRM'; p.checkIn = { mode: 'KEEP' }; p.checkOut = { mode: 'KEEP', nextDay: false };
      return { p: p };
    }
    function submit() {
      var b = build();
      if (b.err) { res.textContent = b.err; res.className = 'meta sv-res report-error'; return; }
      var p = b.p, sig = JSON.stringify(p);
      if (!attempt || attempt.sig !== sig) attempt = { sig: sig, id: newId() };
      p.requestId = attempt.id;
      working = true; sync(); res.textContent = 'Saving…'; res.className = 'meta sv-res';
      opWrite('svCorrect', p, c.workDate, c.workDate, function (n) { res.textContent = 'Busy - retrying… (' + n + ' of 3) / النظام مشغول - إعادة المحاولة…'; res.className = 'meta sv-res'; }).then(function (r) {
        working = false;
        if (r.ok) {
          attempt = null;
          var m = (r.unchanged ? 'No change (already in this state). ' : 'Saved & approved. ') + c.employeeCode + ' · ' + c.workDate + (r.row ? ' · In ' + (r.row.checkIn || '—') + ' · Out ' + (r.row.checkOut || '—') + ' · ' + (r.row.attendanceStatus || '') : '') + (r.approvalPath ? ' · ' + (pathText(r.approvalPath) || r.approvalPath) : '');
          closeForm();
          setMsg('qResult', m, false); $('qResult').className = 'meta zo-saved';
          loadList('', { args: loaded ? loaded.args : qArgs(), keepResult: true, focus: c.caseKey });
          return;
        }
        sync();
        if (r.code === 'VERSION_CONFLICT' || r.code === 'APPLY_FAILED' || r.code === 'REQUEST_ID_CONFLICT') attempt = null; // a rolled-back / refused attempt is retried as a NEW request
        var t = 'NOT saved: ' + (CODE_TEXT[r.code] ? CODE_TEXT[r.code] + ' ' : '') + (r.error || r.code || '') + (r.code ? ' [' + r.code + ']' : '');
        if (RELOAD_CODES.indexOf(r.code) !== -1) {
          closeForm(); setMsg('qResult', t + ' The list was reloaded.', true);
          loadList('', { args: loaded ? loaded.args : qArgs(), keepResult: true, focus: c.caseKey });
          return;
        }
        res.textContent = t; res.className = 'meta sv-res report-error';
      });
    }
    save.addEventListener('click', submit);
    return form;
  }
  /** Export Excel: ALL matching rows (every page, current filters) - reuses the last complete load when the filters are unchanged, else loads again. */
  function exportList() {
    var a = qArgs(), err = rangeError(a);
    if (err) { setMsg('qStatus', err, true); return; }
    if (loaded && loaded.key === JSON.stringify(a)) { buildExport(rows, a); return; }
    var seq = ++loadSeq; setBusy(true); setMsg('qStatus', 'Loading all records for the export…');
    fetchAll(a, function (n, t, restart) { if (seq === loadSeq) setMsg('qStatus', restart ? 'The list changed - restarting (attempt ' + restart + ' of 3)…' : 'Loading ' + n + ' / ' + t + ' for the export…'); }).then(function (r) {
      if (seq !== loadSeq) return;
      setBusy(false);
      if (!r.ok) { setMsg('qStatus', 'Excel not created: ' + r.error, true); return; }
      adopt(r, a);
      buildExport(rows, a);
    });
  }
  function buildExport(list, a) {
    if (!list.length) { setMsg('qStatus', 'Nothing to export: no records match these filters.', true); return; }
    try {
      var cols = [['Employee Code', 'string', 14], ['Employee Name', 'text', 26], ['Date', 'date', 13], ['Event / Area', 'text', 22], ['Zone', 'text', 18], ['Check-in', 'text', 17], ['Check-out', 'text', 17], ['Scheduled Shift', 'text', 18], ['Hours (actual / required)', 'text', 22],
        ['Match Status', 'text', 16], ['Missing Punch', 'text', 16], ['Zone Manager Decision', 'text', 20], ['Correction Status', 'text', 20], ['Approval Path', 'text', 22], ['List State', 'text', 12], ['Issues', 'wrap', 34], ['Original Check-in', 'text', 17], ['Original Check-out', 'text', 17],
        ['Zone Manager By', 'text', 20], ['Zone Manager At', 'text', 17], ['Correction By', 'text', 24], ['Correction At', 'text', 17], ['Correction Version', 'number', 11], ['Edit Path', 'text', 18], ['Read-only Reason', 'text', 22], ['Designation', 'text', 16], ['Location', 'text', 16]];
      var out = list.map(function (c) {
        var cr = c.correction;
        return [String(c.employeeCode), c.employeeName, c.workDate, c.event, c.zone, c.checkIn || 'MISSING', c.checkOut || 'MISSING', shiftText(c) || 'No schedule', hoursText(c), c.matchStatus || '', missText(c),
          c.zmStatus, c.correctionStatus, cr ? cr.approvalPath || '' : '', c.listState, (c.issues || []).join(', '), (c.recorded && c.recorded.checkIn) || '', (c.recorded && c.recorded.checkOut) || '',
          c.zmBy || '', c.zmAt || '', cr ? cr.by || '' : '', cr ? cr.at || '' : '', cr ? cr.version : '', c.editPath || '', c.readOnlyReason || '', c.designation || '', c.location || ''];
      });
      var bytes = window.HMGXlsx.build([{ name: 'Attendance Records', columns: cols.map(function (c) { return { header: c[0], type: c[1], width: c[2] }; }), rows: out }]);
      if (!(bytes && bytes.length > 100 && bytes[0] === 0x50 && bytes[1] === 0x4B)) { setMsg('qStatus', 'Excel not created: the workbook could not be built.', true); return; }
      var name = 'HMG_Attendance_Records_' + a.from + '_' + a.to + (a.status && a.status !== 'ALL' ? '_' + a.status : '') + '.xlsx';
      var url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      var box = $('qFiles'); clear(box);
      var link = el('a', 'btn-secondary', 'Save ' + name + ' (' + Math.max(1, Math.round(bytes.length / 1024)) + ' KB)'); link.href = url; link.download = name; box.appendChild(link);
      var auto = document.createElement('a'); auto.href = url; auto.download = name; auto.style.display = 'none'; document.body.appendChild(auto); auto.click(); auto.remove();
      setMsg('qStatus', 'Excel ready: ' + name + ' (' + list.length + ' records). If no file appears, click the Save link.');
    } catch (err) { setMsg('qStatus', 'Could not build the Excel file: ' + (err && err.message ? err.message : err), true); }
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
      opWrite('svScheduleSave', args, dates[0], dates[dates.length - 1], function (n) { setMsg('aResult', 'Busy - retrying… (' + n + ' of 3)'); }).then(function (r) {
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
      var c = r.counts || {}, bad = c.LOST || 0;
      setMsg('iStatus', (note ? note + ' ' : '') + 'OK ' + (c.OK || 0) + ' · lost ' + (c.LOST || 0) + ' · orphaned ' + (c.ORPHANED || 0) + ' · duplicate ' + (c.DUPLICATE || 0) + ' · excluded ' + (c.EXCLUDED || 0), bad + (c.ORPHANED || 0) + (c.DUPLICATE || 0) > 0);
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
    if (!window.confirm('Re-apply the LOST corrections of ' + a.from + ' to ' + a.to + ' exactly as approved?\nDuplicates and orphaned corrections are not touched; a record is never created.')) return;
    $('iReapply').disabled = true; setMsg('iStatus', 'Re-applying…');
    opWrite('svReapply', Object.assign({ confirm: true }, a), a.from, a.to, function (n) { setMsg('iStatus', 'Busy - retrying… (' + n + ' of 3)'); }).then(function (r) {
      $('iReapply').disabled = false;
      checkIntegrity((r.ok ? 'Re-applied ' : 'Partly re-applied ') + (r.reapplied || 0) + (r.failed ? ', FAILED ' + r.failed : '') + '.');
    });
  }

  // ---------------- wiring ----------------
  ['queue', 'schedule', 'history'].forEach(function (t) { $('svTab' + t.charAt(0).toUpperCase() + t.slice(1)).addEventListener('click', function () { showTab(t); }); });
  $('qLoad').addEventListener('click', function () { loadList(); });
  $('qExport').addEventListener('click', exportList);
  $('qList').addEventListener('click', function (ev) { var t = ev.target; if (t && t.classList && t.classList.contains('sv-open') && !t.disabled) openCorrection(+t.getAttribute('data-i')); });
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
