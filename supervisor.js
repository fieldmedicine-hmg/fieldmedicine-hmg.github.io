// Attendance Supervisor page V1.4 (2026-11-13, batch editing): ALL attendance records (svList view ALL, paged by listId + completeness check), an Edit button on every row (FIRST column) opening an inline editor.
// The editor NEVER sends anything: its primary action keeps a DRAFT and moves to the next record (auto-advance + keyboard). Drafts live in memory + localStorage (per signed-in identity), are shown on the rows and in a
// review panel, and are sent by ONE "Save & Approve All" (svCorrectBatch, compact encoding packed by encoded size <= 3,800 bytes and <= 25 per request, sequential, idempotent requestIds, per-draft results, in-place row patch). Direct supervisor approval when permitted. Shift schedule, history.
// Credential = a supervisor's personal access link (?adminToken=...) read once by access.js (global or zone-limited), or an Analytics Admin (explicit intervention).
// Data reaches the DOM only through textContent or esc() (HTML-escaped); no inline scripts (CSP script-src 'self'). Editing has no confirmation popups; every write is sent once per attempt (requestId).
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
    if (isAdmin()) { b.hidden = false; b.textContent = 'Administrator intervention / تدخل المسؤول: you see the full list; corrections are recorded as administrator ADMIN in the audit.'; } else b.hidden = true;
    var sc = who.scope || {};
    $('svScope').textContent = sc.zones ? 'Zones: ' + sc.zones.join(', ') : 'All zones';
    $('svDirectInfo').textContent = who.canDirectApprove ? (isAdmin() ? 'Direct approval: allowed (recorded as ADMIN). / اعتماد مباشر مسموح' : 'Direct approval: ALLOWED - you can correct and approve Pending / Rejected records without the Zone Manager. / اعتماد مباشر مسموح') : 'Direct approval: not allowed - Pending / Rejected records stay read-only until the Zone Manager decides. / الاعتماد المباشر غير مسموح';
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
        who = r; DKEY = 'hmgSvDrafts:' + identity(); loadDrafts(); applyRole(); updateToolbar(); loadList();
      });
    });
  }

  // ---------------- attendance records (svList view ALL: every record in range, paged by listId + completeness check) ----------------
  var rows = [], counts = null, loaded = null /* {key, args} of the last COMPLETE load */, loadSeq = 0, openIdx = -1, selIdx = -1, idxByKey = {}, activeEditor = null;
  function store(k, v) { try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable: session only */ } return null; }
  var autoAdv = store('hmgSvAutoAdvance') !== '0', lastReason = store('hmgSvLastReason') || '';
  function rememberReason(id) { lastReason = id || ''; store('hmgSvLastReason', lastReason); }
  // ---------------- V1.4 drafts (keyed by caseKey; memory + localStorage per signed-in identity) ----------------
  var drafts = {}, DKEY = '', submitting = false, reviewOpen = false;
  /** Drafts per svCorrectBatch request: 25 (the backend maximum); a smaller value is honoured on localhost only (tests). */
  var CHUNK = (function () { var n = 25; try { if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) { var m = /[?&]batchSize=(\d+)/.exec(location.search); if (m && +m[1] >= 1 && +m[1] <= 25) n = +m[1]; } } catch (e) { /* default */ } return n; })();
  var CONFLICT_MSG = 'Record changed - review. / تغير السجل - راجعه.', NOT_CONFIRMED_MSG = 'Not confirmed - submit again (safe: already-saved records are recognised). / لم يتم التأكد - أعد الإرسال (آمن).';
  function draftKeys() { return Object.keys(drafts); }
  function persist() { store(DKEY, JSON.stringify(drafts)); }
  function identity() { return (who.role || '') + '|' + (who.signedInAs || '') + '|' + JSON.stringify(who.scope || {}) + '|' + (who.canDirectApprove ? 1 : 0); }
  function loadDrafts() {
    drafts = {};
    var raw = store(DKEY);
    if (!raw) return;
    try { var o = JSON.parse(raw); Object.keys(o || {}).forEach(function (k) { var d = o[k]; if (d && d.caseKey === k && d.proposed && d.item) drafts[k] = d; }); } catch (e) { drafts = {}; }
  }
  function sortedDraftKeys() { return draftKeys().sort(function (a, b) { var x = drafts[a], y = drafts[b]; return x.workDate < y.workDate ? -1 : x.workDate > y.workDate ? 1 : (x.employeeCode < y.employeeCode ? -1 : x.employeeCode > y.employeeCode ? 1 : 0); }); }
  /** Quick-select reasons (the text sent as reason / evidence = the label + " - " + the note). "other" REQUIRES a note. */
  var REASONS = [{ id: 'noOut', label: 'Forgot to punch out / نسي تسجيل الخروج' }, { id: 'noIn', label: 'Forgot to punch in / نسي تسجيل الدخول' }, { id: 'device', label: 'Device or network failure / عطل الجهاز أو الشبكة' },
    { id: 'sheet', label: 'Shift sheet confirmed / تم التحقق من كشف الوردية' }, { id: 'gate', label: 'Gate / access log / سجل البوابة' }, { id: 'overtime', label: 'Approved overtime or extended event / عمل إضافي معتمد' },
    { id: 'early', label: 'Approved early leave / انصراف مبكر معتمد' }, { id: 'other', label: 'Other - write a note / أخرى - اكتب ملاحظة' }];
  var COLS = ['Actions / إجراءات', 'Employee Code / الرمز', 'Employee Name / الاسم', 'Date / التاريخ', 'Event / Area', 'Zone / المنطقة', 'Check-in / الدخول', 'Check-out / الخروج', 'Scheduled Shift / الوردية', 'Hours (actual / required) / الساعات', 'Match status / المطابقة', 'Missing Punch / الناقص', 'Zone Manager decision / قرار مدير المنطقة', 'Correction status / حالة التصحيح'];
  var RO_TEXT = { FINAL: 'FINAL - the zone day is closed. / اليوم نهائي', NO_DIRECT_PERMISSION: 'Needs Zone Manager approval - you have no direct-approval permission. / لا تملك صلاحية الاعتماد المباشر', NO_PUNCH: 'No real punch - cannot be edited. / لا توجد بصمة',
    AWAITING_ZONE_MANAGER: 'Waiting for the Zone Manager', ZM_REJECTED: 'Rejected by the Zone Manager', NOT_AVAILABLE: 'No longer available to you - press Load. / لم يعد متاحًا', REFRESH_FAILED: 'This record could not be refreshed - press Load. / تعذر تحديث السجل' };
  var CODE_TEXT = {
    VERSION_CONFLICT: 'This record was changed by someone else. / تم تعديل السجل من شخص آخر.', ZONE_NOT_ALLOWED: 'This record belongs to a zone outside your access.',
    AWAITING_ZONE_MANAGER: 'The Zone Manager has not approved this record yet.', ZM_REJECTED: 'The Zone Manager rejected this record.', FINAL: 'The zone day is FINAL - it cannot be changed. / اليوم نهائي.',
    DIRECT_APPROVAL_NOT_ALLOWED: 'You do not have the direct-approval permission (ask the administrator). / لا تملك صلاحية الاعتماد المباشر.',
    REASON_REQUIRED: 'A reason is required (at least 5 characters for a direct approval). / السبب مطلوب.', EVIDENCE_REQUIRED: 'Evidence is required when a time is set manually.',
    NO_PUNCH_EVIDENCE: 'A record without any real punch cannot be corrected. / لا توجد بصمة فعلية.', NO_CHANGE: 'Nothing was changed. / لا يوجد تغيير.', NOT_ELIGIBLE: 'This record cannot be edited.',
    REQUEST_ID_CONFLICT: 'This request id was used by another user - try again (a new id is created).', NOT_AUTHORIZED: 'Your access is no longer valid.',
    ADMIN_OVERRIDE_REQUIRED: 'The administrator intervention flag was not accepted - reload the page.', APPLY_FAILED: 'The change could not be applied and was rolled back - try again.'
  };
  var DIRECT_NOTICE = 'Direct supervisor approval - ZM decision kept / اعتماد مباشر - يبقى قرار مدير المنطقة';
  var ADMIN_NOTICE = 'Corrections are recorded as administrator ADMIN in the audit. / تُسجَّل التصحيحات باسم المسؤول ADMIN في السجل.';
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
    rows = r.rows; counts = r.first.counts || {}; loaded = { key: JSON.stringify(a), args: a }; openIdx = -1; selIdx = -1; activeEditor = null; idxByKey = {}; rows.forEach(function (c, i) { idxByKey[c.caseKey] = i; });
    setOptions($('qZone'), r.first.zones); setOptions($('qEvent'), r.first.events);
    $('qZone').value = a.zone || ''; $('qEvent').value = a.event || '';
    reconcileDrafts(); renderCounts(); renderTable(); updateToolbar();
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
      if (!r.ok) { rows = []; counts = null; loaded = null; openIdx = -1; selIdx = -1; idxByKey = {}; activeEditor = null; clear($('qList')); $('qCounts').hidden = true; setMsg('qStatus', 'Could not load: ' + r.error, true); return; }
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
  var DRAFT_LABEL = { DRAFT: 'Draft / مسودة', CONFLICT: 'Conflict / تعارض', FAILED: 'Failed / فشل', REQUIRES_REVIEW: 'Requires review / يتطلب مراجعة', NOT_CONFIRMED: 'Not confirmed / غير مؤكد' };
  function punchCell(orig, prop, kind) { return prop === null || prop === undefined ? esc(orig) : '<span class="sv-orig">' + esc(orig) + '</span> &rarr; <span class="sv-prop sv-prop-' + kind + '">' + esc(prop || 'MISSING') + '</span>'; }
  function draftOut(d) { return (d.proposed.checkOut || '') + (d.proposed.checkOut && d.proposed.nextDay ? ' (+1d)' : ''); }
  function draftHours(c, d) { var rq = requiredMin(c); return has(d.propMin) ? fmtMin(d.propMin) + ' / ' + (rq !== null ? fmtMin(rq) : '—') : '—'; }
  function rowHtml(c, i) {
    var cor = c.correction, can = canEditRow(c) && !c._pending, match = c.matchStatus || '', dr = drafts[c.caseKey];
    var corTxt = '<span class="tag tag-' + esc(c.listState) + '" data-state="' + esc(c.listState) + '">' + esc(c.listState) + '</span> ' + esc(c.correctionStatus === 'NONE' ? 'No correction' : c.correctionStatus + (cor ? ' v' + cor.version : ''));
    if (cor && cor.approvalPath) corTxt += ' <span class="sv-appr-path" data-path="' + esc(cor.approvalPath) + '">· ' + esc(pathText(cor.approvalPath) || cor.approvalPath) + '</span>';
    if (c._nomatch) corTxt += ' <span class="sv-nomatch-tag">updated - no longer matches the filter / لم يعد ضمن الفلتر</span>';
    if (dr) corTxt += ' <span class="sv-draft-tag" data-status="' + esc(dr.status) + '">' + esc(DRAFT_LABEL[dr.status] || dr.status) + '</span>' + (dr.message ? '<div class="sv-draft-msg" dir="auto">' + esc(dr.message) + '</div>' : '');
    var act = '<button type="button" class="btn-primary sv-open sv-edit" data-i="' + i + '"' + (can ? '' : ' disabled title="' + esc(c._pending ? 'Refreshing this record…' : (RO_TEXT[c.readOnlyReason] || c.readOnlyReason || 'not editable')) + '"') + '>Edit / تعديل</button>';
    if (c._pending) act += '<div class="sv-path-note">Refreshing… / جارٍ التحديث</div>';
    else if (!can) act += '<div class="sv-ro-reason" data-reason="' + esc(c.readOnlyReason) + '">' + esc(RO_TEXT[c.readOnlyReason] || c.readOnlyReason || 'not editable') + '</div>';
    else if (c.editPath === 'DIRECT_APPROVAL') act += '<div class="sv-path-note" data-path="DIRECT_APPROVAL">Direct approval / اعتماد مباشر</div>';
    var cells = [act, esc(c.employeeCode), '<span dir="auto">' + esc(c.employeeName) + '</span>', esc(c.workDate), '<span dir="auto">' + esc(c.event) + '</span>', '<span dir="auto">' + esc(c.zone) + '</span>',
      punchCell(tm(c.checkIn, c.workDate) || 'MISSING', dr && dr.changedIn ? dr.proposed.checkIn : null, 'in'), punchCell(tm(c.checkOut, c.workDate) || 'MISSING', dr && dr.changedOut ? draftOut(dr) : null, 'out'), esc(shiftText(c) || 'No schedule'),
      dr && (dr.changedIn || dr.changedOut) && has(dr.propMin) ? '<span class="sv-orig">' + esc(hoursText(c) || '—') + '</span> &rarr; <span class="sv-prop sv-prop-hours">' + esc(draftHours(c, dr)) + '</span>' : esc(hoursText(c) || '—'),
      match ? '<span class="tag tag-' + esc(match) + '">' + esc(match) + '</span>' : '—', esc(missText(c) || '—'),
      '<span class="tag tag-' + esc(c.zmStatus) + '">' + esc(c.zmStatus) + '</span>' + (c.zmBy ? ' <span dir="auto">' + esc(c.zmBy) + '</span>' : ''), corTxt];
    return '<tr tabindex="-1" class="sv-row' + (dr ? ' sv-drafted' : '') + (can ? '' : ' sv-ro') + (c._updated ? ' sv-highlight' : '') + (c._nomatch ? ' sv-nomatch' : '') + '" data-i="' + i + '" data-case="' + esc(c.caseKey) + '" data-state="' + esc(c.listState) + '" data-match="' + esc(match) + '" data-path="' + esc(c.editPath || '') + '"' + (dr ? ' data-draft="' + esc(dr.status) + '"' : '') + '><td>' + cells.join('</td><td>') + '</td></tr>';
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
    openIdx = -1; activeEditor = null;
  }
  // ---- selection (keyboard focus ring) ----
  function rowEl(i) { return document.querySelector('#svBody tr.sv-row[data-i="' + i + '"]'); }
  function selectRow(i, opts) {
    opts = opts || {};
    if (!rows.length) return;
    i = Math.max(0, Math.min(rows.length - 1, i));
    var old = document.querySelector('#svBody tr.sv-selected'); if (old) old.classList.remove('sv-selected');
    var tr0 = rowEl(i); selIdx = i; if (!tr0) return;
    tr0.classList.add('sv-selected');
    if (!opts.noFocus) { try { tr0.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    try { tr0.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
  }
  function nextEditable(i) { for (var j = i + 1; j < rows.length; j++) if (canEditRow(rows[j]) && !rows[j]._pending) return j; return -1; }
  /** The inline editor opens right under the row (no navigation) with the keyboard focus in the first useful field. A second click on Edit closes it (force = open anyway). */
  function openCorrection(i, force) {
    var wasOpen = openIdx === i; closeForm();
    if (wasOpen && !force) return;
    if (submitting) { setMsg('qResult', 'Saving is in progress - wait until it finishes. / جارٍ الحفظ.', false); return; }
    var c = rows[i], tr0 = rowEl(i);
    if (!c || !tr0 || !canEditRow(c) || c._pending) return;
    var fr = el('tr', 'sv-form-row'), td = el('td'); td.colSpan = COLS.length; fr.appendChild(td);
    tr0.insertAdjacentElement('afterend', fr); openIdx = i; selectRow(i, { noFocus: true });
    var holder = el('div', 'sv-case'); holder.setAttribute('data-case', c.caseKey); holder.setAttribute('data-path', c.editPath || ''); td.appendChild(holder);
    var dd = drafts[c.caseKey];
    renderCase(holder, c, dd ? { reason: dd.reasonId, note: dd.note, in: dd.proposed.checkIn, out: dd.proposed.checkOut, next: dd.proposed.nextDay } : undefined, dd && dd.message ? dd.message : '');
    try { fr.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
    if (activeEditor && activeEditor.focusFirst) activeEditor.focusFirst();
  }
  function requiredMin(c) {
    var h = c.hours; if (h && has(h.requiredMin)) return h.requiredMin;
    var s = c.scheduledShift; if (s && s.durationMin) return s.durationMin;
    if (s && validTime(s.start) && validTime(s.end)) { var d = toMin(s.end) - toMin(s.start); return d <= 0 ? d + 1440 : d; }
    return null;
  }
  function renderCase(holder, c, preset, initialMsg) {
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
    if (c.editPath === 'DIRECT_APPROVAL') { var nt = el('div', 'sv-direct-notice', DIRECT_NOTICE); nt.setAttribute('dir', 'auto'); holder.appendChild(nt); }
    if (isAdmin()) { var an = el('div', 'sv-admin-note', ADMIN_NOTICE); an.setAttribute('dir', 'auto'); holder.appendChild(an); }
    var res = el('div', 'meta sv-res'); res.setAttribute('role', 'status'); res.setAttribute('aria-live', 'polite');
    holder.appendChild(caseForm(holder, c, res, preset));
    holder.appendChild(res);
    if (initialMsg) { res.textContent = initialMsg; res.className = 'meta sv-res report-error'; }
  }
  /** "0815" -> "08:15" while typing; "815" / "8:15" are completed when the field is left. */
  function typedTime(v) { return /^\d{4}$/.test(v) ? v.slice(0, 2) + ':' + v.slice(2) : v; }
  function finishTime(v) { return /^\d{3}$/.test(v) ? '0' + v.charAt(0) + ':' + v.slice(1) : (/^\d:\d{2}$/.test(v) ? '0' + v : v); }
  function caseForm(holder, c, res, preset) {
    var form = el('div', 'filter-bar sv-editor'), sg = c.suggested || {}, sh = c.scheduledShift, direct = c.editPath === 'DIRECT_APPROVAL';
    var rec = c.recorded || {}, origIn = hhmm(c.checkIn), origOut = hhmm(c.checkOut), origNext = !!c.checkOut && dateOf(c.checkOut) > c.workDate;
    var missing = c.missing || [];
    function field(label, node) { var f = el('div', 'filter-field'); f.appendChild(el('label', null, label)); f.appendChild(node); form.appendChild(f); return f; }
    var inTime = el('input'), outTime = el('input'), next = el('input'), inSched = el('button', 'btn-secondary sv-use-in', 'Use scheduled time / وقت الوردية'), outSched = el('button', 'btn-secondary sv-use-out', 'Use scheduled time / وقت الوردية');
    [inTime, outTime].forEach(function (t) { t.type = 'text'; t.setAttribute('inputmode', 'numeric'); t.maxLength = 5; t.placeholder = 'HH:mm'; t.autocomplete = 'off'; t.setAttribute('dir', 'ltr'); });
    next.type = 'checkbox'; inSched.type = 'button'; outSched.type = 'button';
    inTime.className = 'sv-in-time sv-time'; outTime.className = 'sv-out-time sv-time'; next.className = 'sv-next';
    inTime.setAttribute('aria-label', 'Check-in time HH:mm'); outTime.setAttribute('aria-label', 'Check-out time HH:mm');
    // the helpers and the next-day tick-box stay out of the Tab order: Tab goes check-in -> check-out -> reason -> note -> Save
    next.tabIndex = -1; inSched.tabIndex = -1; outSched.tabIndex = -1;
    inTime.value = origIn; outTime.value = origOut; next.checked = origNext;
    if (preset && preset.in !== undefined) { inTime.value = preset.in; outTime.value = preset.out; next.checked = !!preset.next; }
    var fi = field('Check-in time / وقت الدخول', inTime); if (sh) fi.appendChild(inSched);
    var fo = field('Check-out time / وقت الخروج', outTime); if (sh) fo.appendChild(outSched);
    var nl = el('label', 'sv-next-label'); nl.appendChild(next); nl.appendChild(document.createTextNode(' Next day / اليوم التالي')); var fn = el('div', 'filter-field'); fn.appendChild(nl); form.appendChild(fn);
    var rsel = el('select', 'sv-reason'), note = el('input', 'sv-note');
    var ph = el('option', null, 'Choose a reason / اختر السبب'); ph.value = ''; rsel.appendChild(ph);
    REASONS.forEach(function (r) { var o = el('option', null, r.label); o.value = r.id; rsel.appendChild(o); });
    rsel.setAttribute('dir', 'auto'); rsel.setAttribute('aria-label', 'Reason');
    note.type = 'text'; note.maxLength = 300; note.setAttribute('dir', 'auto'); note.autocomplete = 'off'; note.setAttribute('aria-label', 'Note');
    var want = preset && preset.reason !== undefined ? preset.reason : lastReason;
    rsel.value = REASONS.some(function (r) { return r.id === want; }) ? want : '';
    note.value = preset && preset.note ? preset.note : '';
    var noteLabel = el('label', null, 'Note / ملاحظة');
    var nf = el('div', 'filter-field'); nf.appendChild(noteLabel); nf.appendChild(note);
    field('Reason (required) / السبب', rsel); form.appendChild(nf);
    var preview = el('div', 'sv-preview'); preview.setAttribute('role', 'status');
    var save = el('button', 'btn-primary sv-save', 'Keep as draft & Next / حفظ كمسودة والتالي'), cancel = el('button', 'btn-secondary sv-cancel', 'Cancel / إلغاء');
    save.type = 'button'; cancel.type = 'button';
    var bf = el('div', 'filter-field sv-actions'); bf.appendChild(save); bf.appendChild(cancel);
    if (drafts[c.caseKey]) {
      var rmv = el('button', 'btn-secondary sv-remove-draft', 'Remove draft / حذف المسودة'); rmv.type = 'button'; bf.appendChild(rmv);
      rmv.addEventListener('click', function () { var i = idxByKey[c.caseKey]; removeDraft(c.caseKey); closeForm(); selectRow(i === undefined ? selIdx : i); });
    }
    var foot = el('div', 'sv-editor-foot'); foot.appendChild(preview); foot.appendChild(bf);
    foot.appendChild(el('span', 'meta sv-editor-keys', 'Ctrl+Enter = Keep as draft & Next · Esc = Cancel · N = skip / تخطي'));
    form.appendChild(foot);
    if (sg.basis) res.textContent = 'Suggestion: ' + sg.basis;
    var rq = requiredMin(c), working = false;
    function worked() { if (!validTime(inTime.value) || !validTime(outTime.value)) return null; return toMin(outTime.value) - toMin(inTime.value) + (next.checked ? 1440 : 0); }
    function noteSync() { var other = rsel.value === 'other'; noteLabel.textContent = other ? 'Note (required, 5+ characters) / ملاحظة (مطلوبة)' : 'Note / ملاحظة'; note.classList.toggle('sv-note-required', other); }
    function sync() {
      var w = worked(), t;
      if (w === null) t = 'Worked hours: enter both times to see the result. / أدخل الوقتين لعرض الساعات.' + (rq !== null ? ' Required: ' + fmtMin(rq) + '.' : '');
      else if (w <= 0) t = 'Check-out is not after check-in - tick "Next day" for a shift that ends the next day. / الخروج قبل الدخول.';
      else t = 'Worked hours / الساعات: ' + fmtMin(w) + (rq !== null ? ' · Required: ' + fmtMin(rq) + ' · Variance: ' + (w - rq >= 0 ? '+' : '-') + fmtMin(Math.abs(w - rq)) : '');
      preview.textContent = t;
      save.disabled = working; noteSync();
    }
    function autoNext() { if (validTime(inTime.value) && validTime(outTime.value)) next.checked = toMin(outTime.value) < toMin(inTime.value); }
    [inTime, outTime].forEach(function (t) {
      t.addEventListener('input', function () { var v = typedTime(t.value); if (v !== t.value) t.value = v; autoNext(); sync(); });
      t.addEventListener('change', function () { autoNext(); sync(); });
      t.addEventListener('blur', function () { var v = finishTime(t.value); if (v !== t.value) { t.value = v; autoNext(); sync(); } });
      t.addEventListener('focus', function () { try { t.select(); } catch (e) { /* ignore */ } });
    });
    ['input', 'change'].forEach(function (ev) { next.addEventListener(ev, sync); rsel.addEventListener(ev, sync); });
    inSched.addEventListener('click', function () { if (sh) { inTime.value = sh.start; autoNext(); sync(); } });
    outSched.addEventListener('click', function () { if (sh) { outTime.value = sh.end; next.checked = !!(sh.endDate && sh.endDate !== c.workDate) || toMin(sh.end) <= toMin(sh.start); sync(); } });
    cancel.addEventListener('click', function () { var i = idxByKey[c.caseKey]; closeForm(); selectRow(i === undefined ? selIdx : i); });
    sync();
    /** SET + time for each changed punch, KEEP for each unchanged one (an unchanged punch of an active correction that differs from the recorded punch is re-sent as SET so the correction keeps it), CONFIRM when nothing changed and no correction exists. */
    function build() {
      var err = '', changedIn = inTime.value !== origIn, changedOut = outTime.value !== origOut || (!!outTime.value && next.checked !== origNext), rs = '';
      var rr = REASONS.filter(function (r) { return r.id === rsel.value; })[0], nt = note.value.trim();
      if (!rr) err = 'Choose a reason. / اختر السبب.';
      else if (rr.id === 'other' && nt.length < 5) err = 'Write a note of at least 5 characters for "Other". / اكتب ملاحظة (5 أحرف على الأقل).';
      else rs = rr.label + (nt ? ' - ' + nt : '');
      var p = { caseKey: c.caseKey, expectedVersion: c.version, expectedStamp: c.rowStamp, reason: rs }; // one svCorrectBatch item (requestId is added when it is sent; adminOverride travels on the batch request)
      if (direct) p.directApproval = true;
      if (!err && ((changedIn && !validTime(inTime.value)) || (changedOut && !validTime(outTime.value)))) err = 'Enter a valid HH:mm time (a recorded punch cannot be cleared). / أدخل وقتًا صحيحًا.';
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
        if (p.checkIn.mode === 'SET' || p.checkOut.mode === 'SET') p.evidence = rs; // evidence = the reason text (every predefined label is >= 5 characters)
        return { p: p, reasonId: rr.id, changedIn: changedIn, changedOut: changedOut };
      }
      if (missing.length) return { err: 'A punch is missing: enter its time. / أدخل وقت البصمة الناقصة.' };
      if (c.correction) return { err: 'Nothing changed - edit a time first. / لم يتغير شيء.' };
      p.action = 'CONFIRM'; p.checkIn = { mode: 'KEEP' }; p.checkOut = { mode: 'KEEP', nextDay: false };
      return { p: p, reasonId: rr.id, changedIn: false, changedOut: false };
    }
    /** Validates locally and keeps the draft; NOTHING is sent. Auto-advances like V1.3 (Edit -> Next -> Edit -> Next). */
    function submit() {
      var b = build();
      if (b.err) { res.textContent = b.err; res.className = 'meta sv-res report-error'; return; }
      var old = drafts[c.caseKey];
      drafts[c.caseKey] = { caseKey: c.caseKey, workDate: c.workDate, zone: c.zone || '', employeeCode: String(c.employeeCode), employeeName: c.employeeName || '', expectedVersion: c.version, expectedStamp: c.rowStamp, editPath: c.editPath || '',
        recorded: { checkIn: rec.checkIn || '', checkOut: rec.checkOut || '' }, current: { checkIn: c.checkIn || '', checkOut: c.checkOut || '' }, origMin: c.hours && has(c.hours.actualMin) ? c.hours.actualMin : null,
        proposed: { checkIn: inTime.value, checkOut: outTime.value, nextDay: next.checked }, changedIn: b.changedIn, changedOut: b.changedOut, propMin: worked(), reasonId: b.reasonId, note: note.value.trim(), reasonText: b.p.reason, action: b.p.action, item: b.p,
        status: 'DRAFT', message: '', requestId: old ? old.requestId : '', reqSig: old ? old.reqSig : '', newId: old ? !!old.newId : false, at: Date.now() };
      persist(); rememberReason(b.reasonId);
      var i = idxByKey[c.caseKey];
      closeForm();
      setMsg('qResult', 'Draft kept: ' + c.employeeCode + ' · ' + c.workDate + ' · In ' + (inTime.value || '—') + ' · Out ' + (outTime.value || '—') + ' (' + draftKeys().length + ' pending). Nothing is sent until "Save & Approve All". / حُفظت كمسودة.', false);
      $('qResult').className = 'meta zo-saved';
      if (i !== undefined) redrawRow(i);
      updateToolbar();
      if (i === undefined) return;
      if (autoAdv) {
        var j = nextEditable(i);
        if (j >= 0) { openCorrection(j, true); return; }
        $('qResult').textContent = $('qResult').textContent + ' No further editable record below.';
      }
      selectRow(i);
    }
    save.addEventListener('click', submit);
    activeEditor = { holder: holder, submit: submit, cancel: function () { cancel.click(); },
      focusFirst: function () { var f = !c.checkIn ? inTime : (!c.checkOut ? outTime : inTime); try { f.focus({ preventScroll: true }); f.select(); } catch (e) { /* ignore */ } } };
    return form;
  }
  // ---- in-place update after a save (no full list reload) ----
  var COUNT_OF_MATCH = { MATCHED: 'matched', UNMATCHED: 'unmatched', MISSING_CHECK_IN: 'missingIn', MISSING_CHECK_OUT: 'missingOut', NOT_COMPUTABLE: 'notComputable' };
  function bucketsOf(c) { var b = ['total']; if (COUNT_OF_MATCH[c.matchStatus]) b.push(COUNT_OF_MATCH[c.matchStatus]); if (c.listState) b.push(String(c.listState).toLowerCase()); return b; }
  function adjustCounts(oldRow, newRow) {
    if (!counts) return;
    bucketsOf(oldRow).forEach(function (k) { counts[k] = Math.max(0, (counts[k] || 0) - 1); });
    bucketsOf(newRow).forEach(function (k) { counts[k] = (counts[k] || 0) + 1; });
    renderCounts();
  }
  function matchesStatus(c, st) { return !st || st === 'ALL' || (COUNT_OF_MATCH[st] ? c.matchStatus === st : c.listState === st); }
  function makeRow(c, i) { var tb = document.createElement('tbody'); tb.innerHTML = rowHtml(c, i); return tb.firstChild; }
  function replaceRow(i, c2) {
    var old = rows[i], st = loaded && loaded.args ? loaded.args.status : 'ALL';
    c2._nomatch = !matchesStatus(c2, st); c2._updated = true;
    rows[i] = c2; adjustCounts(old, c2);
    var tr0 = rowEl(i);
    if (tr0) { var n = makeRow(c2, i); if (selIdx === i) n.classList.add('sv-selected'); tr0.replaceWith(n); }
  }
  function redrawRow(i) {
    var tr0 = rowEl(i); if (!tr0) return;
    var n = makeRow(rows[i], i); if (selIdx === i) n.classList.add('sv-selected'); tr0.replaceWith(n);
  }
  /** The row as a svCorrectBatch result describes it (times, hours, rowStamp and version come from the written row; the authoritative record follows from the next Load). */
  function batchPatched(c, r) {
    var n = Object.assign({}, c), rw = r.row || {};
    if (rw.checkIn !== undefined) { n.checkIn = rw.checkIn || ''; n.current = Object.assign({}, c.current, { checkIn: n.checkIn }); }
    if (rw.checkOut !== undefined) { n.checkOut = rw.checkOut || ''; n.current = Object.assign({}, n.current || c.current, { checkOut: n.checkOut }); }
    if (rw.attendanceStatus) n.attendanceStatus = rw.attendanceStatus;
    var wm = rw.workedMinutes !== undefined && rw.workedMinutes !== '' && rw.workedMinutes !== null ? Number(rw.workedMinutes) : null;
    if (wm !== null && !isNaN(wm)) { var h = Object.assign({}, c.hours || {}); h.actualMin = wm; if (has(h.requiredMin)) h.varianceMin = wm - h.requiredMin; n.hours = h; }
    if (rw.rowStamp !== undefined) n.rowStamp = rw.rowStamp;
    n.missing = (n.checkIn ? [] : ['CHECK_IN']).concat(n.checkOut ? [] : ['CHECK_OUT']);
    if ((c.matchStatus === 'MISSING_CHECK_IN' && n.checkIn) || (c.matchStatus === 'MISSING_CHECK_OUT' && n.checkOut)) n.matchStatus = ''; // re-evaluated by the next Load
    n.listState = 'CORRECTED'; n.correctionStatus = r.state === 'CONFIRMED' ? 'CONFIRMED' : 'CORRECTED';
    n.correction = { correctionId: r.correctionId, version: r.version, type: r.type || (r.state === 'CONFIRMED' ? 'CONFIRMED' : 'CORRECTED'), approvedIn: n.checkIn, approvedOut: n.checkOut, by: '', at: '', approvalPath: r.approvalPath || (c.editPath === 'DIRECT_APPROVAL' ? 'SUPERVISOR_DIRECT' : 'ZM_GATE') };
    if (r.version !== undefined) n.version = r.version;
    return n;
  }
  // ---- drafts: counter, review panel, reconcile after a reload ----
  function removeDraft(key) {
    if (submitting || !drafts[key]) return;
    delete drafts[key]; persist();
    var i = idxByKey[key]; if (i !== undefined) redrawRow(i);
    updateToolbar();
  }
  function updateToolbar() {
    var n = draftKeys().length, b = $('qPending');
    b.textContent = 'Pending changes (' + n + ') / تغييرات معلقة'; b.classList.toggle('sv-has-drafts', n > 0);
    $('qSaveAll').disabled = submitting || n === 0;
    renderReview();
  }
  /** After every list load: a draft whose record now shows another version / rowStamp is a CONFLICT ("record changed - review"); a record that is no longer editable needs review. */
  function reconcileDrafts() {
    var touched = false;
    rows.forEach(function (c) {
      var d = drafts[c.caseKey]; if (!d) return;
      if (String(c.version) !== String(d.expectedVersion) || String(c.rowStamp) !== String(d.expectedStamp)) {
        if (d.status !== 'CONFLICT' || d.message !== CONFLICT_MSG) { d.status = 'CONFLICT'; d.message = CONFLICT_MSG; touched = true; }
        if (!d.newId) { d.newId = true; touched = true; }
      } else if (!canEditRow(c) && d.status === 'DRAFT') { d.status = 'REQUIRES_REVIEW'; d.message = (RO_TEXT[c.readOnlyReason] || c.readOnlyReason || 'not editable'); touched = true; }
    });
    if (touched) persist();
  }
  function reviewRow(d) {
    var r = el('tr', 'sv-rv-row'); r.setAttribute('data-case', d.caseKey); r.setAttribute('data-draft', d.status);
    function cell(v, cls) { var t = el('td', cls || null, v === undefined || v === null || v === '' ? '—' : v); t.setAttribute('dir', 'auto'); r.appendChild(t); return t; }
    var punches = [];
    punches.push('In ' + (d.changedIn ? (tm(d.current.checkIn, d.workDate) || 'MISSING') + ' → ' : '') + (d.proposed.checkIn || 'MISSING'));
    punches.push('Out ' + (d.changedOut ? (tm(d.current.checkOut, d.workDate) || 'MISSING') + ' → ' : '') + (draftOut(d) || 'MISSING'));
    var hrs = (has(d.origMin) ? fmtMin(d.origMin) : '—') + ' → ' + (has(d.propMin) ? fmtMin(d.propMin) : '—');
    cell(d.employeeName, 'sv-rv-name'); cell(d.employeeCode, 'sv-rv-code'); cell(d.workDate, 'sv-rv-date'); cell(d.zone, 'sv-rv-zone'); cell(punches.join(' · '), 'sv-rv-punches'); cell(hrs, 'sv-rv-hours');
    cell(d.reasonText, 'sv-rv-reason'); cell(d.editPath === 'DIRECT_APPROVAL' ? 'Direct approval / اعتماد مباشر' : 'ZM gate / بوابة مدير المنطقة', 'sv-rv-path');
    var st = cell((DRAFT_LABEL[d.status] || d.status) + (d.message ? ' - ' + d.message : ''), 'sv-rv-status'); st.setAttribute('data-status', d.status);
    var act = el('td', 'sv-rv-actions'), ed = el('button', 'btn-secondary sv-rv-edit', 'Edit / تعديل'), rm = el('button', 'btn-secondary sv-rv-remove', 'Remove / حذف');
    ed.type = 'button'; rm.type = 'button'; ed.disabled = submitting; rm.disabled = submitting;
    ed.addEventListener('click', function () { editDraft(d.caseKey); }); rm.addEventListener('click', function () { removeDraft(d.caseKey); });
    act.appendChild(ed); act.appendChild(rm); r.appendChild(act);
    return r;
  }
  function renderReview() {
    var box = $('qReview'); clear(box); box.hidden = !reviewOpen;
    if (!reviewOpen) return;
    var keys = sortedDraftKeys(), head = el('div', 'sv-review-head');
    head.appendChild(el('b', 'sv-review-title', 'Review pending changes (' + keys.length + ') / مراجعة التغييرات المعلقة'));
    var all = el('button', 'btn-primary sv-saveall', 'Save & Approve All / حفظ واعتماد الكل'), close = el('button', 'btn-secondary sv-review-close', 'Close / إغلاق');
    all.type = 'button'; close.type = 'button'; all.id = 'qSaveAll2'; all.disabled = submitting || !keys.length;
    all.addEventListener('click', saveAll); close.addEventListener('click', function () { reviewOpen = false; renderReview(); });
    head.appendChild(all); head.appendChild(close); box.appendChild(head);
    if (!keys.length) { box.appendChild(el('div', 'empty-note', 'No pending changes. / لا توجد تغييرات معلقة.')); return; }
    var trs = keys.map(function (k) { return reviewRow(drafts[k]); });
    box.appendChild(table(['Employee / الاسم', 'Code / الرمز', 'Date / التاريخ', 'Zone / المنطقة', 'Original → proposed / الأصلي ← المقترح', 'Hours / الساعات', 'Reason / السبب', 'Path / المسار', 'Status / الحالة', 'Actions / إجراءات'], trs, 'sv-review-table'));
  }
  function toggleReview() { reviewOpen = !reviewOpen; renderReview(); if (reviewOpen) { try { $('qReview').scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } } }
  function editDraft(key) {
    var i = idxByKey[key];
    if (i === undefined) { setMsg('qResult', 'This record is not in the current list - set the dates / filters that show it, then press Edit. / السجل غير ظاهر في القائمة الحالية.', true); return; }
    reviewOpen = false; renderReview();
    openCorrection(i, true);
  }
  function dayGap(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000); }
  // ---- V1.4.1: compact encoding + packing by the ACTUAL encoded size (the Worker refuses a POST body above 4,096 bytes with HTTP 413) ----
  var BODY_BUDGET = 3800, TOO_LONG_MSG = 'Reason/note too long for one request - shorten it. / السبب أو الملاحظة طويلة جدًا - اختصرها.', SIZE_BATCH_ID = '';
  while (SIZE_BATCH_ID.length < 34) SIZE_BATCH_ID += 'x';
  function utf8len(str) { try { if (window.TextEncoder) return new TextEncoder().encode(str).length; } catch (e) { /* fall through */ } return unescape(encodeURIComponent(str)).length; }
  function haveSubtle() { try { return !!(window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function' && window.TextEncoder); } catch (e) { return false; } }
  /** First 12 hex chars of SHA-256 (UTF-8) of a string (the backend compares it with svSha_(rowStamp).slice(0, 12)). */
  function sha12(str) {
    return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str))).then(function (buf) {
      var u = new Uint8Array(buf), h = ''; for (var i = 0; i < 6; i++) h += ('0' + u[i].toString(16)).slice(-2);
      return h;
    });
  }
  /** One punch spec -> compact: '' KEEP | 'S' SCHEDULE | 'HH:mm' SET | 'HH:mm+' SET next day; null when it cannot be expressed. */
  function specCode(sp) {
    if (!sp || sp.mode === 'KEEP') return '';
    if (sp.mode === 'SCHEDULE') return 'S';
    if (sp.mode === 'SET' && validTime(sp.time)) return sp.time + (sp.nextDay === true ? '+' : '');
    return null;
  }
  /** Verbose items (each with requestId) -> the compact opArgs payload, or null when an item cannot be encoded. hashes: caseKey -> stampHash. */
  function compactArgs(base, items, hashes) {
    var r = [], at = {}, c = [], ok = true;
    var idx = function (t) { if (t === undefined || t === null || t === '') return -1; t = String(t); if (at[t] === undefined) { at[t] = r.length; r.push(t); } return at[t]; };
    items.forEach(function (it) {
      var a = it.action === 'CONFIRM' ? 1 : it.action === 'CORRECT' ? 0 : -1, ci = specCode(it.checkIn), co = specCode(it.checkOut), h = hashes[it.caseKey], rs = idx(it.reason);
      if (a < 0 || ci === null || co === null || !h || rs < 0) { ok = false; return; }
      c.push([it.caseKey, it.expectedVersion, h, it.requestId, a, ci, co, rs, idx(it.evidence), it.directApproval === true ? 1 : 0]);
    });
    if (!ok) return null;
    var out = Object.assign({}, base); out.r = r; out.c = c; return out;
  }
  /** The exact POST body A.call sends for an op (action / token key follow the credential kind), for size measurement. */
  function bodyBytes(name, args, from, to) {
    var cred = A.credential(), f = from || A.todayRiyadh(), t = to || f;
    var b = { action: cred && cred.kind === 'device' ? 'periodAnalyticsViaDevice' : 'periodAnalytics', op: name, date: f, fromDate: f, toDate: t, opArgs: JSON.stringify(args || {}) };
    b[cred && cred.kind === 'device' ? 'deviceToken' : 'adminToken'] = cred ? cred.value : '';
    return utf8len(JSON.stringify(b));
  }
  /** entries [{k, it, date}] (date-ordered) -> {plan: [{ks, args, from, to}], tooLong: [k]}. Each request holds as many drafts as fit BODY_BUDGET bytes (and CHUNK, and a 31-day window). */
  function packRequests(entries, hashes) {
    var plan = [], tooLong = [], cur = [], first = '';
    var build = function (es, batchId) {
      var base = { batchId: batchId, confirm: true }; if (isAdmin()) base.adminOverride = true; // automatic: the backend still requires it and enforces every gate
      var items = es.map(function (e) { return e.it; }), ds = es.map(function (e) { return e.date; }).sort();
      var args = hashes ? compactArgs(base, items, hashes) : null;
      if (!args) { args = Object.assign({}, base); args.items = items; }
      return { args: args, from: ds[0], to: ds[ds.length - 1] };
    };
    var size = function (es) { var b = build(es, SIZE_BATCH_ID); return bodyBytes('svCorrectBatch', b.args, b.from, b.to); };
    var flush = function () { if (!cur.length) return; var b = build(cur, newId()); plan.push({ ks: cur.map(function (e) { return e.k; }), args: b.args, from: b.from, to: b.to }); cur = []; };
    entries.forEach(function (e) {
      if (size([e]) > BODY_BUDGET) { tooLong.push(e.k); return; }
      if (cur.length && (cur.length >= CHUNK || dayGap(first, e.date) > 30 || size(cur.concat([e])) > BODY_BUDGET)) flush();
      if (!cur.length) first = e.date;
      cur.push(e);
    });
    flush();
    return { plan: plan, tooLong: tooLong };
  }
  function isNetworkFailure(r) { return !r || (r.ok === false && !r.code && !r.retryable && /^(Network error|Empty response|timed out)/i.test(String(r.error || ''))); }
  function failText(code, err) { return (CODE_TEXT[code] ? CODE_TEXT[code] + ' ' : '') + (err || code || 'failed') + (code ? ' [' + code + ']' : ''); }
  function redrawKeys(ks) { ks.forEach(function (k) { var i = idxByKey[k]; if (i !== undefined && drafts[k]) redrawRow(i); }); }
  /** ONE button: every draft (except those flagged CONFLICT, which must be reviewed first) is sent in sequential svCorrectBatch requests. */
  function saveAll() {
    if (submitting) return;
    var all = draftKeys(), keys = all.filter(function (k) { return drafts[k].status !== 'CONFLICT'; });
    if (!keys.length) { setMsg('qSummary', all.length ? 'Only drafts with a conflict remain - open each one (Edit) to review it. / راجع التعارضات أولًا.' : 'No pending changes. / لا توجد تغييرات.', all.length > 0); return; }
    keys.sort(function (a, b) { var x = drafts[a], y = drafts[b]; return x.workDate < y.workDate ? -1 : x.workDate > y.workDate ? 1 : (x.employeeCode < y.employeeCode ? -1 : x.employeeCode > y.employeeCode ? 1 : 0); });
    var plan = [], total = keys.length, done = 0, tot = { saved: 0, failed: 0, conflict: 0, review: 0, unconfirmed: 0 }, stopped = false;
    submitting = true; setBusy(true); setMsg('qSummary', ''); setMsg('qResult', '');
    closeForm(); updateToolbar();
    var bar = $('qBatchBar'); bar.max = total; bar.value = 0; $('qBatch').hidden = false;
    function progress(n, extra) { bar.value = done; $('qBatchText').textContent = 'Saving ' + n + ' / ' + total + '…' + (extra ? ' ' + extra : ''); }
    function mark(d, status, msg) { d.status = status; d.message = msg; }
    function finish() {
      submitting = false; setBusy(false); $('qBatch').hidden = true; persist();
      var line = 'Saved ' + tot.saved + ' · Failed ' + tot.failed + ' · Conflict ' + tot.conflict + ' · Requires review ' + tot.review + (tot.unconfirmed ? ' · Not confirmed ' + tot.unconfirmed : '') + (stopped ? ' · stopped: ' + done + ' of ' + total + ' processed' : '');
      setMsg('qSummary', line, tot.failed + tot.conflict + tot.review + tot.unconfirmed > 0 || stopped);
      if (draftKeys().length) reviewOpen = true;
      updateToolbar();
    }
    function runChunk(ci) {
      if (ci >= plan.length) { finish(); return; }
      var ks = plan[ci].ks, args = plan[ci].args;
      progress(done + ks.length);
      opWrite('svCorrectBatch', args, plan[ci].from, plan[ci].to, function (n) { progress(done + ks.length, 'Busy - retrying… (' + n + ' of 3) / النظام مشغول'); }).then(null, function () { return null; }).then(function (r) {
        if (isNetworkFailure(r)) { ks.forEach(function (k) { mark(drafts[k], 'NOT_CONFIRMED', NOT_CONFIRMED_MSG); }); tot.unconfirmed += ks.length; stopped = true; done += ks.length; progress(done); redrawKeys(ks); finish(); return; }
        if (!r.ok) { ks.forEach(function (k) { mark(drafts[k], 'FAILED', 'NOT saved: ' + failText(r.code, r.error)); }); tot.failed += ks.length; stopped = true; done += ks.length; progress(done); redrawKeys(ks); finish(); return; }
        var byKey = {}; (r.results || []).forEach(function (x) { if (x && x.caseKey) byKey[x.caseKey] = x; });
        ks.forEach(function (k) {
          var d = drafts[k], x = byKey[k];
          if (!x) { mark(d, 'NOT_CONFIRMED', 'No answer for this record - submit again (safe). / لا توجد إجابة.'); tot.unconfirmed++; return; }
          if (x.status === 'SAVED') {
            if (r.verified !== true) { mark(d, 'NOT_CONFIRMED', 'Saved but the batch was not verified - submit again (safe). / لم يتم التحقق.'); tot.unconfirmed++; return; }
            var i = idxByKey[k]; delete drafts[k]; if (i !== undefined) replaceRow(i, batchPatched(rows[i], x));
            tot.saved++; return;
          }
          var msg = 'NOT saved: ' + failText(x.code, x.error);
          if (x.status === 'CONFLICT') { mark(d, 'CONFLICT', msg); d.newId = true; tot.conflict++; }
          else if (x.status === 'REQUIRES_REVIEW') { mark(d, 'REQUIRES_REVIEW', msg); tot.review++; }
          else { mark(d, 'FAILED', msg); if (x.code === 'APPLY_FAILED' || x.code === 'REQUEST_ID_CONFLICT') d.newId = true; tot.failed++; }
        });
        done += ks.length; persist(); progress(done); redrawKeys(ks);
        updateToolbar();
        runChunk(ci + 1);
      });
    }
    /** Builds every request first (requestIds, stamp hashes, byte packing); the compact encoding needs SubtleCrypto, else the verbose format is sent with the same byte packing. */
    var entries = keys.map(function (k) {
      var d = drafts[k], it = Object.assign({}, d.item), sig;
      if (d.editPath === 'DIRECT_APPROVAL') it.directApproval = true; else delete it.directApproval;
      sig = JSON.stringify(it);
      if (!d.requestId || d.reqSig !== sig || d.newId) { d.requestId = newId(); d.reqSig = sig; d.newId = false; } // one requestId per attempt: reused while the draft is unchanged
      it.requestId = d.requestId;
      return { k: k, it: it, date: d.workDate };
    });
    persist();
    var hp = haveSubtle() ? Promise.all(entries.map(function (e) { return sha12(drafts[e.k].expectedStamp); })).then(function (hs) { var m = {}; entries.forEach(function (e, i) { m[e.k] = hs[i]; }); return m; }, function () { return null; }) : Promise.resolve(null);
    hp.then(function (hashes) {
      var pk = packRequests(entries, hashes);
      plan = pk.plan;
      pk.tooLong.forEach(function (k) { mark(drafts[k], 'FAILED', TOO_LONG_MSG); tot.failed++; done++; });
      if (pk.tooLong.length) { persist(); redrawKeys(pk.tooLong); }
      runChunk(0);
    });
  }
  function skipNext() {
    var from = openIdx >= 0 ? openIdx : selIdx, j = nextEditable(from);
    if (j < 0) { setMsg('qResult', 'No further editable record below. / لا توجد سجلات قابلة للتعديل بعد هذا.', false); return; }
    openCorrection(j, true);
  }
  // ---- keyboard (high volume) ----
  function isField(t) { return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'); }
  function onKey(ev) {
    var pane = $('svPaneQueue'); if ($('svMain').hidden || pane.hidden || ev.altKey || ev.isComposing) return;
    var t = ev.target, k = ev.key, ctrl = ev.ctrlKey || ev.metaKey;
    if (!t || !t.closest) return;
    if (!t.closest('#svPaneQueue') && t !== document.body && t !== document.documentElement) return; // focus on the page itself (after Load / Esc) still works
    var inEd = !!t.closest('.sv-case');
    if (isField(t) && !inEd) return; // typing in the filter inputs / selects: never hijacked
    if (activeEditor && k === 'Enter' && ctrl) { ev.preventDefault(); activeEditor.submit(); return; }
    if (activeEditor && k === 'Escape') { ev.preventDefault(); activeEditor.cancel(); return; }
    if (ctrl) return;
    if (inEd) {
      var typing = t.classList && t.classList.contains('sv-note');
      if (k === 'Enter' && !ev.shiftKey && (t.tagName === 'SELECT' || typing)) { ev.preventDefault(); activeEditor.submit(); return; }
      if ((k === 'n' || k === 'N') && !typing) { ev.preventDefault(); skipNext(); }
      return;
    }
    if (k === 'ArrowDown' || k === 'j' || k === 'J') { ev.preventDefault(); selectRow(selIdx < 0 ? 0 : selIdx + 1); }
    else if (k === 'ArrowUp' || k === 'k' || k === 'K') { ev.preventDefault(); selectRow(selIdx < 0 ? 0 : selIdx - 1); }
    else if (k === 'Enter' || k === 'e' || k === 'E') {
      if (k === 'Enter' && t.tagName === 'BUTTON') return; // a focused button keeps its own click
      if (selIdx < 0) return;
      ev.preventDefault();
      if (canEditRow(rows[selIdx]) && !rows[selIdx]._pending) openCorrection(selIdx, true);
      else setMsg('qResult', 'This record cannot be edited: ' + (RO_TEXT[rows[selIdx].readOnlyReason] || rows[selIdx].readOnlyReason || 'not editable'), false);
    } else if ((k === 'n' || k === 'N') && activeEditor) { ev.preventDefault(); skipNext(); }
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
  function draftText(d) { return d ? 'In ' + (d.proposed.checkIn || 'MISSING') + ' · Out ' + (draftOut(d) || 'MISSING') + ' · ' + d.reasonText + ' · ' + d.status + (d.message ? ' - ' + d.message : '') : ''; }
  function buildExport(list, a) {
    if (!list.length) { setMsg('qStatus', 'Nothing to export: no records match these filters.', true); return; }
    try {
      var cols = [['Employee Code', 'string', 14], ['Employee Name', 'text', 26], ['Date', 'date', 13], ['Event / Area', 'text', 22], ['Zone', 'text', 18], ['Check-in', 'text', 17], ['Check-out', 'text', 17], ['Scheduled Shift', 'text', 18], ['Hours (actual / required)', 'text', 22],
        ['Match Status', 'text', 16], ['Missing Punch', 'text', 16], ['Zone Manager Decision', 'text', 20], ['Correction Status', 'text', 20], ['Approval Path', 'text', 22], ['List State', 'text', 12], ['Issues', 'wrap', 34], ['Original Check-in', 'text', 17], ['Original Check-out', 'text', 17],
        ['Zone Manager By', 'text', 20], ['Zone Manager At', 'text', 17], ['Correction By', 'text', 24], ['Correction At', 'text', 17], ['Correction Version', 'number', 11], ['Edit Path', 'text', 18], ['Read-only Reason', 'text', 22], ['Designation', 'text', 16], ['Location', 'text', 16], ['Proposed (draft)', 'wrap', 40]];
      var out = list.map(function (c) {
        var cr = c.correction;
        return [String(c.employeeCode), c.employeeName, c.workDate, c.event, c.zone, c.checkIn || 'MISSING', c.checkOut || 'MISSING', shiftText(c) || 'No schedule', hoursText(c), c.matchStatus || '', missText(c),
          c.zmStatus, c.correctionStatus, cr ? cr.approvalPath || '' : '', c.listState, (c.issues || []).join(', '), (c.recorded && c.recorded.checkIn) || '', (c.recorded && c.recorded.checkOut) || '',
          c.zmBy || '', c.zmAt || '', cr ? cr.by || '' : '', cr ? cr.at || '' : '', cr ? cr.version : '', c.editPath || '', c.readOnlyReason || '', c.designation || '', c.location || '', draftText(drafts[c.caseKey])];
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
  $('qAuto').checked = autoAdv;
  $('qAuto').addEventListener('change', function () { autoAdv = $('qAuto').checked; store('hmgSvAutoAdvance', autoAdv ? '1' : '0'); });
  document.addEventListener('keydown', onKey);
  $('qPending').addEventListener('click', toggleReview);
  $('qSaveAll').addEventListener('click', saveAll);
  window.addEventListener('beforeunload', function (ev) { if (!draftKeys().length) return undefined; ev.preventDefault(); ev.returnValue = ''; return ''; }); // unsaved drafts exist
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
